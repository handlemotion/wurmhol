// `GET /connect`: the CLI's one WebSocket (spec section 5). The token says which org; a `share`
// query parameter brings back a share whose CLI dropped (it keeps its id for 60 s). A new share
// may ask for its lifetime in seconds (`ttl`), up to `LIMIT_SHARE_SECONDS`; without one it lasts
// `DEFAULT_SHARE_SECONDS`.
//
// `Wurmhol-Viewers: ana@x.com,bo@y.com` narrows a new share to those members of the token's org
// (ADR 0008, per-pipe access); without it, the whole org may open it.
//
// A `name` query parameter opens a named pipe (ADR 0009) at `<name>.<SHARE_DOMAIN>`: the same
// host every time, held by the first org to use the name, one open pipe per name. The OAuth
// relay's label (ADR 0010) is no pipe's name.
//
// `Wurmhol-Source` says where a new pipe came from (ADR 0015): URI-encoded JSON of
// `@wurmhol/protocol`'s `PipeSource`, every field optional and bounded. It goes on the share's
// history row and its card on the wall.
//
// Refusals answer with plain HTTP before the upgrade, as `{ error, fix }`: the CLI prints `fix`,
// one line that says what to do.
import {
  formatDuration,
  parsePipeSource,
  PIPE_NAME_RULE,
  pipeName,
  type SourceResult,
} from "@wurmhol/protocol";
import {
  findMembersByEmail,
  findShare,
  orgStanding,
  recordShareEnd,
  recordShareStart,
} from "@wurmhol/db";
import { Hono } from "hono";
import { bearerToken, refuse } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { reservedPipeName, shareOrigin, SHARE_ID } from "../env.ts";
import { INTERNAL_HEADERS, type ShareInit } from "../share-do.ts";

/** The header that names a new share's viewers, comma-separated emails. */
export const VIEWERS_HEADER = "wurmhol-viewers";
const MAX_VIEWERS = 50;
/** The header that says where a new share came from (ADR 0015). */
export const SOURCE_HEADER = "wurmhol-source";
/** Bigger than any source within `SOURCE_LIMITS`, URI-encoded. */
const MAX_SOURCE_HEADER = 24 * 1024;

function readSource(header: string | undefined): SourceResult {
  if (!header) return { ok: true, source: null };
  if (header.length > MAX_SOURCE_HEADER) {
    return { ok: false, field: "note", fix: "The pipe's source is too long." };
  }
  try {
    return parsePipeSource(JSON.parse(decodeURIComponent(header)));
  } catch {
    return { ok: false, field: "note", fix: "The pipe's source is not URI-encoded JSON." };
  }
}

export const connect = new Hono<AppEnv>().get("/", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(426, "expected a websocket upgrade", "Connect with the wurmhol CLI.");
  }
  const { config, db } = c.var;
  const token = await bearerToken(c);
  if (token instanceof Response) return token;
  const standing = await orgStanding(db, token.orgId, {
    enabled: config.auth.billing !== undefined,
  });
  if (!standing.ok) {
    return refuse(
      402,
      "no subscription",
      `The org has no plan yet. Subscribe at ${config.auth.baseURL} (menu → Billing).`,
    );
  }

  // A reconnect: the same token's share, still open.
  const resume = c.req.query("share");
  if (resume !== undefined) {
    const share = SHARE_ID.test(resume) ? await findShare(db, resume) : null;
    if (!share || share.orgId !== token.orgId || share.tokenId !== token.id) {
      return refuse(404, "share not found", "Start a new pipe: npx wurmhol <port>.");
    }
    if (share.endedAt) {
      return refuse(410, "share ended", "Start a new pipe: npx wurmhol <port>.", {
        reason: share.endReason,
      });
    }
    const stub = c.env.SHARE.get(c.env.SHARE.idFromName(share.id));
    return stub.fetch(new Request(new URL("/connect", c.req.url), { headers: c.req.raw.headers }));
  }

  const port = Number(c.req.query("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return refuse(400, "bad port", "Pass the port your server listens on: npx wurmhol 8787.");
  }
  const limit = config.LIMIT_SHARE_SECONDS;
  const ttl = c.req.query("ttl");
  const seconds = ttl === undefined ? Math.min(config.DEFAULT_SHARE_SECONDS, limit) : Number(ttl);
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    return refuse(400, "bad ttl", "Pass a lifetime like --ttl 90m or --ttl 8h.");
  }
  if (seconds > limit) {
    return refuse(
      400,
      "ttl over the limit",
      `Pipes last at most ${formatDuration(limit)}. Pass --ttl ${formatDuration(limit)} or less.`,
      { limit },
    );
  }
  const rawName = c.req.query("name");
  const name = rawName === undefined ? null : pipeName(rawName);
  if (rawName !== undefined && !name) {
    return refuse(400, "bad name", `Pick a pipe name of ${PIPE_NAME_RULE}.`);
  }
  if (name && name === reservedPipeName(config)) {
    return refuse(409, "name reserved", `The pipe name ${name} is reserved. Pick another --name.`);
  }
  const source = readSource(c.req.header(SOURCE_HEADER));
  if (!source.ok) return refuse(400, `bad ${source.field}`, source.fix);
  let viewers: string[] | null = null;
  const named = (c.req.header(VIEWERS_HEADER) ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (named.length > MAX_VIEWERS) {
    return refuse(400, "too many viewers", `Name at most ${MAX_VIEWERS} people with --only.`);
  }
  if (named.length) {
    const found = await findMembersByEmail(db, token.orgId, named);
    if (found.unknown.length) {
      return refuse(
        400,
        "not members",
        `${found.unknown.join(", ")} ${found.unknown.length === 1 ? "is not a member" : "are not members"} of the token's org. Invite them at ${config.auth.baseURL} (menu → Members), or leave them out of --only.`,
        { unknown: found.unknown },
      );
    }
    viewers = found.members.map((member) => member.userId);
  }

  const started = await recordShareStart(db, {
    orgId: token.orgId,
    tokenId: token.id,
    startedBy: token.createdBy,
    port,
    name,
    source: source.source,
  });
  if (!started.ok) {
    return started.reason === "taken"
      ? refuse(409, "name taken", `Another org has the pipe name ${name}. Pick another --name.`)
      : refuse(
          409,
          "name open",
          `The org already has a pipe named ${name} open on port ${started.port}. End it first: wurmhol stop ${name}, or terminate it on ${config.auth.baseURL}.`,
        );
  }
  const starter = token.createdBy
    ? await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.id, token.createdBy!),
        columns: { name: true, email: true },
      })
    : undefined;
  const init: ShareInit = {
    id: started.id,
    orgId: token.orgId,
    tokenId: token.id,
    port,
    url: shareOrigin(config, { id: started.id, name }),
    startedBy: starter?.name || starter?.email || null,
    startedAt: started.startedAt.getTime(),
    viewers,
    source: source.source,
    limits: { seconds, monthlyBytes: config.LIMIT_MONTHLY_BYTES },
  };
  const org = c.env.ORG.get(c.env.ORG.idFromName(token.orgId));
  const reservation = await org.reserve(
    {
      id: init.id,
      url: init.url,
      port,
      startedBy: init.startedBy,
      startedAt: init.startedAt,
      title: null,
      favicon: false,
      lastRequestAt: null,
      views: [],
      state: "live",
      source: init.source,
    },
    { active: config.LIMIT_ACTIVE_SHARES, monthlyBytes: config.LIMIT_MONTHLY_BYTES },
  );
  if (!reservation.ok) {
    await recordShareEnd(db, { id: init.id, reason: "limit", bytes: 0 });
    return reservation.reason === "active_limit"
      ? refuse(
          429,
          "active pipe limit",
          `The org already has ${reservation.limit} open pipes. Stop one (wurmhol stop <port>) or terminate one on ${config.auth.baseURL}.`,
        )
      : refuse(
          429,
          "monthly transfer limit",
          "The org has used this month's transfer allowance. It resets on the 1st (UTC).",
        );
  }
  const headers = new Headers(c.req.raw.headers);
  headers.set(INTERNAL_HEADERS.init, JSON.stringify(init));
  const stub = c.env.SHARE.get(c.env.SHARE.idFromName(init.id));
  const response = await stub.fetch(new Request(new URL("/connect", c.req.url), { headers }));
  if (response.status !== 101) {
    await org.remove(init.id);
    await recordShareEnd(db, { id: init.id, reason: "disconnected", bytes: 0 });
  }
  c.var.log.info("share.started", { shareId: init.id, orgId: init.orgId, port });
  return response;
});
