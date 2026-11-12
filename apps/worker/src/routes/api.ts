// The app's API, for members of the active org: the wall, tokens, members and invite links.
import { zValidator } from "@hono/zod-validator";
import {
  acceptInvite,
  countMembers,
  createInvite,
  createToken,
  listMembers,
  listOrgsForUser,
  listTokens,
  orgStanding,
  peekInvite,
  removeMember,
  revokeToken,
} from "@wurmhol/db";
import { TOKEN_EXPIRY_DAYS, TOKEN_SCOPES } from "@wurmhol/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  type AppEnv,
  ownOriginSocket,
  requireMember,
  requireOwner,
  resolveSession,
} from "../context.ts";
import { endShare, endTokens, revokeTokensOfLeaver, shareOfOrg } from "../ending.ts";
import { orgStub, toOrg } from "../org-do.ts";
import { memberCap } from "../plan.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { shareStub } from "../share-do.ts";
import { apps } from "./apps.ts";
import { billing } from "./billing.ts";
import { machines } from "./machines.ts";
import { org } from "./org.ts";

/** Where the CLI dials when WURMHOL_URL is unset (`DEFAULT_SERVER`, packages/cli/src/pipe.ts). */
const CLI_DEFAULT_SERVER = "https://api.wurmhol.com";

/** A share of the member's org, or 404: another org's shares do not exist here. */
async function ownShare(c: { var: AppEnv["Variables"] }, id: string) {
  const share = await shareOfOrg(c.var.db, c.var.member.orgId, id);

  if (!share) {
    throw new HTTPException(404, { message: "no such share" });
  }

  return share;
}

/** Routes that work signed in but without an org, or with an invite in hand. */
export const account = new Hono<AppEnv>()
  /** Who is signed in, their orgs, and which one is active. */
  .get("/me", async (c) => {
    const session = await resolveSession(c);

    if (!session) throw new HTTPException(401, { message: "sign in first" });

    const [orgs, standing] = await Promise.all([
      listOrgsForUser(c.var.db, session.user.id),
      session.member
        ? orgStanding(c.var.db, session.member.orgId, {
            enabled: c.var.config.auth.billing !== undefined,
          })
        : null,
    ]);

    // Embedded applications (ADR 0032): for owners, when the install has them and the org may
    // use them (Business, or billing off).
    const apps = Boolean(
      c.var.config.EMBEDDED_ENABLED &&
      session.member?.role === "owner" &&
      standing?.ok &&
      (standing.reason === "billing_off" || standing.plan === "business"),
    );

    return c.json({
      user: session.user,
      orgs,
      activeOrgId: session.member?.orgId ?? null,
      role: session.member?.role ?? null,
      standing,
      apps,
    });
  })
  /** Which org an invite link is for, so the join page can name it. */
  .get("/invites/:code", async (c) => {
    const invite = await peekInvite(c.var.db, c.req.param("code"));

    if (!invite)
      throw new HTTPException(404, { message: "this invite link has expired or was used" });

    return c.json({ orgName: invite.orgName });
  })
  .post("/invites/:code/accept", async (c) => {
    const session = await resolveSession(c);

    if (!session) throw new HTTPException(401, { message: "sign in first" });

    const result = await acceptInvite(c.var.db, c.req.param("code"), session.user.id, (orgId) =>
      memberCap(c.var.db, c.var.config, orgId),
    );

    if (result.status === "invalid") {
      throw new HTTPException(404, { message: "this invite link has expired or was used" });
    }

    if (result.status === "full") throw orgFull(result.cap);
    await c.var.auth.api.setActiveOrganization({
      headers: c.req.raw.headers,
      body: { organizationId: result.orgId },
    });

    return c.json({ orgId: result.orgId, status: result.status });
  });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why an org at its plan's member cap takes no one new (ADR 0027). */
function orgFull(cap: number) {
  return new HTTPException(409, {
    message: `this org's plan includes ${cap} members; an owner can move it to Team (menu → Billing)`,
  });
}

/** A new token (ADR 0008): 30 days, 90 days (the default) or never; scope `pipes` by default. */
const tokenBody = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(TOKEN_SCOPES).default("pipes"),
  expiresInDays: z.union([z.literal(TOKEN_EXPIRY_DAYS), z.null()]).default(90),
});

export const api = new Hono<AppEnv>()
  .use(requireMember)
  /** The wall: every open share of the active org. */
  .get("/shares", async (c) => {
    return c.json({ shares: await orgStub(c.env, c.var.member.orgId).list() });
  })
  /** The wall's live feed: a snapshot, then share.started / updated / ended. */
  .get("/live", ownOriginSocket, async (c) =>
    orgStub(c.env, c.var.member.orgId).fetch(toOrg(c.req.raw, { kind: "wall" })),
  )
  /** Terminate: ends the share at once and closes its CLI's socket. Any member may. */
  .post("/shares/:id/terminate", limitPerMember("manage"), async (c) => {
    const share = await ownShare(c, c.req.param("id"));
    await endShare(c, share, "terminated", "wall");

    return c.json({ ok: true });
  })
  /** The dev server's favicon, for the wall (the share host itself needs its own cookie). */
  .get("/shares/:id/favicon", async (c) => {
    const share = await ownShare(c, c.req.param("id"));
    const icon = await shareStub(c.env, share.id).favicon();

    if (!icon) return c.body(null, 404);

    return c.body(icon.body, 200, {
      "content-type": icon.type,
      "cache-control": "private, max-age=300",
      // SVG favicons can hold script: never as a document.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  })
  .get("/tokens", async (c) => c.json({ tokens: await listTokens(c.var.db, c.var.member.orgId) }))
  /**
   * A new token, shown once, with what a sandbox needs beside it (ADR 0008, the console
   * snippet): the host the CLI dials, to allowlist, and the URL to set as WURMHOL_URL, or null
   * when it is the CLI's default and needs no setting.
   */
  .post("/tokens", limitPerMember("manage"), zValidator("json", tokenBody), async (c) => {
    const { name, scope, expiresInDays } = c.req.valid("json");

    const { id, token } = await createToken(c.var.db, {
      orgId: c.var.member.orgId,
      name,
      scope,
      expiresAt: expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY_MS),
      createdBy: c.var.user.id,
    });

    const server = new URL(c.var.config.auth.baseURL);

    if (c.var.config.CONNECT_HOST) server.hostname = c.var.config.CONNECT_HOST;
    const url = server.origin === CLI_DEFAULT_SERVER ? null : server.origin;

    return c.json({ id, token, host: server.hostname, url }, 201);
  })
  /** Revokes a token and ends every share it started (spec section 6, "Token leaked"). */
  .delete("/tokens/:id", async (c) => {
    const tokenId = c.req.param("id");

    if (!(await revokeToken(c.var.db, c.var.member.orgId, tokenId))) {
      throw new HTTPException(404, { message: "no such token" });
    }

    await endTokens(c, c.var.member.orgId, [tokenId]);

    return c.json({ ok: true });
  })
  .get("/members", async (c) =>
    c.json({ members: await listMembers(c.var.db, c.var.member.orgId), you: c.var.member.id }),
  )
  /** Removes a member and revokes their tokens, ending their pipes and machines (ADR 0021). */
  .delete("/members/:id", requireOwner, async (c) => {
    const orgId = c.var.member.orgId;
    const memberId = c.req.param("id");
    const target = (await listMembers(c.var.db, orgId)).find((m) => m.id === memberId);
    const result = await removeMember(c.var.db, orgId, memberId);

    if (result === "not_found") throw new HTTPException(404, { message: "no such member" });

    if (result === "last_owner") {
      throw new HTTPException(409, { message: "an org needs at least one owner" });
    }

    if (target) await revokeTokensOfLeaver(c, orgId, target.userId);

    return c.json({ ok: true });
  })
  /** A single-use invite link (spec section 3, Members). */
  .post("/invites", requireOwner, limitPerMember("manage"), async (c) => {
    const { db, config, member } = c.var;
    const cap = await memberCap(db, config, member.orgId);

    if (cap !== null && (await countMembers(db, member.orgId)) >= cap) throw orgFull(cap);

    const { code, expiresAt } = await createInvite(c.var.db, {
      orgId: c.var.member.orgId,
      createdBy: c.var.user.id,
    });

    const url = new URL(`/join/${code}`, c.var.config.auth.baseURL).toString();

    return c.json({ url, expiresAt: expiresAt.toISOString() }, 201);
  })
  .route("/apps", apps)
  .route("/machines", machines)
  .route("/", org)
  .route("/", billing);
