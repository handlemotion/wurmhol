// `wurmhol login`, a device-code flow (ADR 0008, RFC 8628) on Better Auth's device-authorization
// plugin. The plugin keeps the codes and their state machine; these routes add what Wurmhol needs:
//
// - The CLI's two calls, `POST /device/code` and `POST /device/token`, answered on the CLI's host.
//   The token call redeems the code through the plugin, which makes a full Better Auth session.
//   The CLI never sees it: the session is revoked in the same request and an ordinary org token
//   is returned instead.
// - The console's three calls under `/api/device`, for a signed-in member: look a code up, approve
//   it for the active org, or deny it. The org is recorded on the code's scope as `org:<id>`.
// - A setup code (ADR 0020): `POST /api/device/setup` issues a code already approved by the
//   caller for the active org and hands back its device code, which Create pipe puts in
//   `wurmhol host --code`. The CLI redeems it on `/device/token` like any other, once.
// - A share's login (ADR 0026): `npx wurmhol <port>` with no token starts a code with the port in
//   it. The token minted for it records the code, and `GET /api/device/pipe` follows the code to
//   the pipe it opened, so the approval page can open that pipe.
//
// A code's scope is a space-separated list: `name:<computer>` (from the CLI, URI-encoded),
// `port:<n>` for a share's login and, once approved, `org:<id>`. A setup code has no name; the CLI
// sends it when it redeems.
import { zValidator } from "@hono/zod-validator";
import { APIError, DEVICE_CLIENT_ID } from "@wurmhol/auth";
import {
  createToken,
  findDeviceUserCode,
  findLoginPipe,
  findMember,
  listOrgsForUser,
  orgStanding,
  setPendingDeviceScope,
} from "@wurmhol/db";

import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { COMPUTER_NAME_MAX, isPort } from "@wurmhol/protocol";
import { type AppEnv, requireMember } from "../context.ts";
import { shareUrl } from "../share-url.ts";
import { limitPerIp, limitPerMember } from "../rate-limiter.ts";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** `wurmhol login` tokens open pipes and expire after 90 days (ADR 0008). */
const LOGIN_TOKEN_MS = 90 * 24 * 60 * 60 * 1000;

/** How long after its token was made a share's login still leads to its pipe. */
const LOGIN_PIPE_MS = 60 * 60 * 1000;

interface Scope {
  name: string | null;
  orgId: string | null;
  /** The port a share's login opens once approved (ADR 0026). */
  port?: number | null;
}

function parseScope(scope: string | null | undefined): Scope {
  const parts = (scope ?? "").split(" ");
  const value = (prefix: string) => {
    const part = parts.find((p) => p.startsWith(prefix));
    return part ? decodeURIComponent(part.slice(prefix.length)) : null;
  };
  const port = Number(value("port:"));
  return { name: value("name:"), orgId: value("org:"), port: isPort(port) ? port : null };
}

function formatScope(scope: Scope) {
  return [
    scope.name !== null ? `name:${encodeURIComponent(scope.name)}` : null,
    scope.port ? `port:${scope.port}` : null,
    scope.orgId !== null ? `org:${encodeURIComponent(scope.orgId)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** `ABCD1234`, `abcd-1234` and `ABCD 1234` are the same code; stored as `ABCD1234`. */
function normalizeUserCode(code: string) {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/** `ABCD1234` as people read it: `ABCD-1234`. */
function displayUserCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The plugin's RFC 8628 error (`{ error, error_description }`), or null for anything else. */
function oauthError(error: unknown) {
  if (!(error instanceof APIError)) return null;
  const body = error.body as { error?: string; error_description?: string } | undefined;
  if (!body?.error) return null;
  return { status: error.statusCode, error: body.error, description: body.error_description };
}

/** What the CLI prints when the flow cannot go on: one line that says what to do. */
const FIXES: Record<string, string> = {
  access_denied: "The login was denied. Run wurmhol login to try again.",
  expired_token: "The code expired. Run wurmhol login again.",
  invalid_grant: "That login is unknown or was already used. Run wurmhol login again.",
};

const computerName = z.string().trim().min(1).max(COMPUTER_NAME_MAX);
const codeBody = z.object({
  name: computerName,
  /** The port `npx wurmhol <port>` opens once approved (ADR 0026); absent for `wurmhol login`. */
  port: z.number().int().refine(isPort).optional(),
});
const tokenBody = z.object({
  device_code: z.string().min(1).max(200),
  /** The computer's name, for a setup code, whose scope has none. */
  name: computerName.optional(),
});

/** The CLI's calls: no session, no token; the device code is the credential. */
export const deviceFlow = new Hono<AppEnv>()
  .post("/code", zValidator("json", codeBody), limitPerIp("auth"), async (c) => {
    const { name, port } = c.req.valid("json");
    const issued = await c.var.auth.api.deviceCode({
      body: { client_id: DEVICE_CLIENT_ID, scope: formatScope({ name, orgId: null, port }) },
    });
    const verificationUri = new URL("/device", c.var.config.auth.baseURL);
    const complete = new URL(verificationUri);
    complete.searchParams.set("code", displayUserCode(issued.user_code));
    c.header("cache-control", "no-store");
    return c.json({
      device_code: issued.device_code,
      user_code: displayUserCode(issued.user_code),
      verification_uri: verificationUri.toString(),
      verification_uri_complete: complete.toString(),
      expires_in: issued.expires_in,
      interval: issued.interval,
    });
  })
  .post("/token", zValidator("json", tokenBody), limitPerIp("auth"), async (c) => {
    c.header("cache-control", "no-store");
    const body = c.req.valid("json");
    // Read before redemption deletes the code: the token keeps it for the approval page.
    const userCode = await findDeviceUserCode(c.var.db, body.device_code);
    let redeemed;
    try {
      redeemed = await c.var.auth.api.deviceToken({
        body: {
          grant_type: GRANT_TYPE,
          device_code: body.device_code,
          client_id: DEVICE_CLIENT_ID,
        },
      });
    } catch (error) {
      const refused = oauthError(error);
      if (!refused) throw error;
      const fix = FIXES[refused.error];
      return c.json(
        { error: refused.error, error_description: refused.description, ...(fix ? { fix } : {}) },
        400,
      );
    }
    // The plugin made a session for the approver. Read who it is for, then end it before
    // anything else can fail: the CLI must never be able to use it.
    const context = await c.var.auth.$context;
    const session = await context.internalAdapter.findSession(redeemed.access_token);
    await context.internalAdapter.deleteSession(redeemed.access_token);
    if (!session) throw new Error("device login: the plugin's session is missing");
    const scope = parseScope(redeemed.scope);
    const { orgId } = scope;
    const name = scope.name ?? body.name ?? null;
    const member = orgId ? await findMember(c.var.db, session.user.id, orgId) : null;
    if (!member || !name) {
      c.var.log.info("device.refused", { orgId: orgId ?? undefined });
      return c.json(
        {
          error: "access_denied",
          error_description: "the approver is not a member of that org",
          fix: "Whoever approved is no longer in that org. Run wurmhol login again.",
        },
        403,
      );
    }
    const token = await createToken(c.var.db, {
      orgId: member.orgId,
      name,
      scope: "pipes",
      source: "login",
      expiresAt: new Date(Date.now() + LOGIN_TOKEN_MS),
      createdBy: session.user.id,
      ...(userCode && scope.port ? { loginCode: userCode } : {}),
    });
    const orgs = await listOrgsForUser(c.var.db, session.user.id);
    c.var.log.info("device.token", { orgId: member.orgId });
    return c.json({
      token: token.token,
      org: { id: member.orgId, name: orgs.find((o) => o.id === member.orgId)?.name ?? null },
      name,
    });
  });

const userCodeBody = z.object({ code: z.string().trim().min(1).max(40) });

/**
 * Claims the code for the signed-in user (the plugin's verify step), as only its claimant may
 * see or decide it. 404 for a code that does not exist, expired, or someone else claimed.
 */
async function claim(c: Context<AppEnv>, code: string) {
  const userCode = normalizeUserCode(code);
  let verified;
  try {
    verified = await c.var.auth.api.deviceVerify({
      query: { user_code: userCode },
      headers: c.req.raw.headers,
    });
  } catch (error) {
    if (!oauthError(error)) throw error;
    throw new HTTPException(404, { message: "This code is wrong or has expired." });
  }
  // The plugin includes the client only for the code's claimant.
  const review = verified as { client_id?: string | null; scope?: string | null };
  if (!review.client_id) {
    throw new HTTPException(404, { message: "This code is wrong or has expired." });
  }
  return { userCode, status: verified.status, scope: parseScope(review.scope) };
}

/** The console's calls, as a member of the active org (`/device`, apps/web). */
export const deviceApproval = new Hono<AppEnv>()
  .use(requireMember)
  .get("/", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!code) throw new HTTPException(400, { message: "Enter the code your terminal shows." });
    const claimed = await claim(c, code);
    const { db, config, member } = c.var;
    const [orgs, standing] = await Promise.all([
      listOrgsForUser(db, c.var.user.id),
      // `/connect` refuses an org without a plan: a share's login approved there would never
      // open its pipe, so the page offers the fix instead (ADR 0026).
      orgStanding(db, member.orgId, { enabled: config.auth.billing !== undefined }),
    ]);
    const org = orgs.find((o) => o.id === member.orgId);
    return c.json({
      code: displayUserCode(claimed.userCode),
      name: claimed.scope.name,
      port: claimed.scope.port ?? null,
      status: claimed.status,
      org: { id: member.orgId, name: org?.name ?? null },
      role: member.role,
      standing,
    });
  })
  /**
   * Where an approved share's login has got to (ADR 0026): `{ url }` once its pipe is open, else
   * `{ url: null }`. The code is gone once redeemed, so this reads the token made from it; `port`
   * is the one the approval page asked to open.
   */
  .get("/pipe", async (c) => {
    const code = normalizeUserCode(c.req.query("code") ?? "");
    if (!code) throw new HTTPException(400, { message: "Which code?" });
    const asked = c.req.query("port");
    const port = asked === undefined ? undefined : Number(asked);
    if (port !== undefined && !isPort(port))
      throw new HTTPException(400, { message: "Not a port." });
    const pipe = await findLoginPipe(c.var.db, {
      orgId: c.var.member.orgId,
      userId: c.var.user.id,
      loginCode: code,
      since: new Date(Date.now() - LOGIN_PIPE_MS),
      port,
    });
    c.header("cache-control", "no-store");
    return c.json({ url: pipe ? await shareUrl(c.var.db, c.var.config, pipe) : null });
  })
  .post("/approve", limitPerMember("manage"), zValidator("json", userCodeBody), async (c) => {
    const claimed = await claim(c, c.req.valid("json").code);
    if (claimed.status !== "pending") {
      throw new HTTPException(409, { message: "This code was already used." });
    }
    // The org goes on the code first: approval is what the CLI's next poll redeems.
    const scope = formatScope({ ...claimed.scope, orgId: c.var.member.orgId });
    const set = await setPendingDeviceScope(c.var.db, {
      userCode: claimed.userCode,
      userId: c.var.user.id,
      scope,
    });
    if (!set) throw new HTTPException(409, { message: "This code was already used." });
    await c.var.auth.api.deviceApprove({
      body: { userCode: claimed.userCode },
      headers: c.req.raw.headers,
    });
    c.var.log.info("device.approved", { orgId: c.var.member.orgId });
    return c.json({ ok: true });
  })
  /**
   * A setup code for Create pipe's command (ADR 0020): issued, claimed and approved for the
   * caller and the active org in one call, so the computer that redeems it needs no approval.
   */
  .post("/setup", limitPerMember("manage"), async (c) => {
    const issued = await c.var.auth.api.deviceCode({
      body: {
        client_id: DEVICE_CLIENT_ID,
        scope: formatScope({ name: null, orgId: c.var.member.orgId }),
      },
    });
    const claimed = await claim(c, issued.user_code);
    if (claimed.status !== "pending") throw new Error("setup code: not pending once issued");
    await c.var.auth.api.deviceApprove({
      body: { userCode: claimed.userCode },
      headers: c.req.raw.headers,
    });
    c.var.log.info("device.setup", { orgId: c.var.member.orgId });
    c.header("cache-control", "no-store");
    return c.json({ code: issued.device_code, expires_in: issued.expires_in });
  })
  .post("/deny", limitPerMember("manage"), zValidator("json", userCodeBody), async (c) => {
    const claimed = await claim(c, c.req.valid("json").code);
    if (claimed.status !== "pending") {
      throw new HTTPException(409, { message: "This code was already used." });
    }
    await c.var.auth.api.deviceDeny({
      body: { userCode: claimed.userCode },
      headers: c.req.raw.headers,
    });
    return c.json({ ok: true });
  });
