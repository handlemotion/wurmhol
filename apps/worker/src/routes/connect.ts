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
// relay's label (ADR 0010) is no pipe's name. Asking for a name the org's open pipe holds takes it
// over when that pipe is away or stale, or when the same token started it (ADR 0025).
//
// `Wurmhol-Source` says where a new pipe came from (ADR 0015): URI-encoded JSON of
// `@wurmhol/protocol`'s `PipeSource`, every field optional and bounded. It goes on the share's
// history row and its card on the wall.
//
// `Wurmhol-Access: <sha-256 hex>` lets a new pipe be opened by a client with no browser session
// (ADR 0028): the hash of an access key the CLI holds. The relay keeps only the hash.
//
// Refusals answer with plain HTTP before the upgrade, as `@wurmhol/protocol`'s `Refusal`.
import {
  ACCESS_KEY_HASH,
  CONNECT_HEADERS,
  embedCredentialKind,
  formatDuration,
  isEmbedTunnelName,
  isEndReason,
  isPort,
  newShareCard,
  parsePipeSource,
  PIPE_NAME_RULE,
  pipeName,
  SHARE_ID,
  type SourceResult,
} from "@wurmhol/protocol";
import {
  findMembersByEmail,
  findShare,
  embedLimitsOf,
  isOrgBlocked,
  recordShareEnd,
  recordShareStart,
  setEmbedTunnelStopped,
  useEmbedConnector,
  type Db,
} from "@wurmhol/db";
import { TRIAL_DAYS } from "@wurmhol/auth";
import { type Context, Hono } from "hono";
import { bearerToken, refuse } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { reservedPipeNames, shareOrigin } from "../env.ts";
import { shareUrl } from "../share-url.ts";
import { orgStub, type Reservation } from "../org-do.ts";
import { type OrgPlan, orgPlan } from "../plan.ts";
import { checkRateLimit } from "../rate-limiter.ts";
import { shareGone, shareStub, toShare } from "../share-do.ts";
import type { ShareInit } from "../share-meta.ts";

const MAX_VIEWERS = 50;
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

/**
 * Ends the org's open pipe named as a new one asks, so the new one can have the name and its URL
 * (ADR 0025): when its CLI is away, when its object already ended or never started (a row left
 * open), or when the same credential started it (the same agent, run again after a crash). A live
 * pipe of another credential keeps its name. True when the name is free to take again.
 */
async function takeOver(
  env: Env,
  db: Db,
  orgId: string,
  sameStarter: boolean,
  open: { id: string },
) {
  const stub = shareStub(env, open.id);
  const { state } = await stub.status();
  if (state === "live" && !sameStarter) return false;
  if (state === "live" || state === "away") {
    await stub.terminate("stopped");
  } else {
    await recordShareEnd(db, { id: open.id, reason: "disconnected", bytes: 0 });
    await orgStub(env, orgId).remove(open.id);
  }
  return true;
}

export const connect = new Hono<AppEnv>().get("/", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(426, "expected a websocket upgrade", "Connect with the wurmhol CLI.");
  }
  const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (presented && embedCredentialKind(presented) === "connector") {
    return connectEmbedded(c, presented);
  }
  const { config, db } = c.var;
  const token = await bearerToken(c);
  if (token instanceof Response) return token;
  const plan = await orgPlan(db, config, token.orgId);
  if (!plan) {
    return refuse(
      402,
      "no subscription",
      `The org has no plan yet. An owner starts a ${TRIAL_DAYS}-day trial at ${config.auth.baseURL}.`,
    );
  }

  // A reconnect: the same token's share, still open.
  const resume = c.req.query("share");
  if (resume !== undefined) {
    const share = SHARE_ID.test(resume) ? await findShare(db, resume) : null;
    if (!share || share.orgId !== token.orgId || share.tokenId !== token.id) {
      return shareGone(null);
    }
    if (share.endedAt) {
      return shareGone(isEndReason(share.endReason) ? share.endReason : "disconnected");
    }
    return shareStub(c.env, share.id).fetch(toShare(c.req.raw, { cli: null }));
  }

  const port = Number(c.req.query("port"));
  if (!isPort(port)) {
    return refuse(400, "bad port", "Pass the port your server listens on: npx wurmhol 8787.");
  }
  const seconds = pipeSeconds(c);
  if (seconds instanceof Response) return seconds;
  const rawName = c.req.query("name");
  const name = rawName === undefined ? null : pipeName(rawName);
  if (rawName !== undefined && !name) {
    return refuse(400, "bad name", `Pick a pipe name of ${PIPE_NAME_RULE}.`);
  }
  if (name && isEmbedTunnelName(name)) {
    return refuse(
      409,
      "name reserved",
      `Names like ${name} are kept for embedded tunnels. Pick another --name.`,
    );
  }
  if (name && reservedPipeNames(config).includes(name)) {
    return refuse(409, "name reserved", `The pipe name ${name} is reserved. Pick another --name.`);
  }
  const source = readSource(c.req.header(CONNECT_HEADERS.source));
  if (!source.ok) return refuse(400, `bad ${source.field}`, source.fix);
  const accessHash = c.req.header(CONNECT_HEADERS.access) ?? null;
  if (accessHash !== null && !ACCESS_KEY_HASH.test(accessHash)) {
    return refuse(
      400,
      "bad access key",
      "Update the wurmhol CLI: it sent an access key the relay cannot read.",
    );
  }
  let viewers: string[] | null = null;
  const named = (c.req.header(CONNECT_HEADERS.viewers) ?? "")
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

  const record = () =>
    recordShareStart(db, {
      orgId: token.orgId,
      tokenId: token.id,
      startedBy: token.createdBy,
      port,
      name,
      source: source.source,
    });
  let started = await record();
  if (
    !started.ok &&
    started.reason === "open" &&
    (await takeOver(c.env, db, token.orgId, started.open.tokenId === token.id, started.open))
  ) {
    c.var.log.info("share.name_taken_over", { shareId: started.open.id, orgId: token.orgId });
    started = await record();
  }
  if (!started.ok) {
    return started.reason === "taken"
      ? refuse(409, "name taken", `Another org has the pipe name ${name}. Pick another --name.`)
      : refuse(
          409,
          "name open",
          `The org already has a pipe named ${name} open on port ${started.open.port}. End it first: wurmhol stop ${name}, or terminate it on ${config.auth.baseURL}.`,
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
    url: await shareUrl(db, config, { id: started.id, name }),
    startedBy: starter?.name || starter?.email || null,
    startedAt: started.startedAt.getTime(),
    viewers,
    source: source.source,
    accessHash,
    limits: {
      seconds,
      monthlyBytes: plan.limits.monthlyBytes,
      monthlyRequests: plan.limits.monthlyRequests,
    },
  };
  const org = orgStub(c.env, token.orgId);
  const reservation = await org.reserve(
    newShareCard({
      id: init.id,
      url: init.url,
      port,
      startedBy: init.startedBy,
      startedAt: init.startedAt,
      source: init.source,
    }),
    plan.limits,
  );
  if (!reservation.ok) {
    await recordShareEnd(db, { id: init.id, reason: "limit", bytes: 0 });
    return reservationRefusal(
      reservation,
      plan,
      (limit) =>
        `The org already has ${limit} open pipes. Stop one (wurmhol stop <port>) or terminate one on ${config.auth.baseURL}.`,
      config.auth.baseURL,
    );
  }
  const response = await shareStub(c.env, init.id).fetch(toShare(c.req.raw, { cli: init }));
  if (response.status !== 101) {
    await org.remove(init.id);
    await recordShareEnd(db, { id: init.id, reason: "disconnected", bytes: 0 });
  }
  c.var.log.info("share.started", { shareId: init.id, orgId: init.orgId, port });
  return response;
});

type ConnectContext = Context<AppEnv>;

/** A new pipe's lifetime in seconds from `ttl`, or the refusal to send instead. */
function pipeSeconds(c: ConnectContext): number | Response {
  const { config } = c.var;
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
  return seconds;
}

/** Why the org's object refused a new pipe a slot. `activeFix` says what to do at the open limit. */
function reservationRefusal(
  reservation: Exclude<Reservation, { ok: true }>,
  plan: OrgPlan,
  activeFix: (limit: number) => string,
  appURL: string,
) {
  if (reservation.reason === "active_limit") {
    return refuse(429, "active pipe limit", activeFix(reservation.limit));
  }
  return reservation.reason === "monthly_limit"
    ? refuse(
        429,
        "monthly transfer limit",
        "The org has used this month's transfer allowance. It resets on the 1st (UTC).",
      )
    : refuse(
        429,
        "monthly request limit",
        plan.plan === "business"
          ? `The org's requests reached its spend cap for this billing period. An owner can raise it at ${appURL} (Org settings).`
          : "The org has used this month's request allowance. It resets on the 1st (UTC).",
      );
}

/**
 * `/connect` with a connector (`whc_`, ADR 0032): an agent opening, reopening or reconnecting to
 * its one embedded tunnel, at the tunnel's own host. It names nothing about the pipe but its port
 * and lifetime: no name, no viewers, no access key. Its session is never an org pipe.
 */
async function connectEmbedded(c: ConnectContext, presented: string) {
  const { config, db } = c.var;
  const fix = "Ask the app that set up this tunnel for a new connector.";
  if (!config.EMBEDDED_ENABLED) {
    return refuse(401, "connector unknown", "This relay has no embedded tunnels.");
  }
  const connector = await useEmbedConnector(db, presented);
  if (!connector.ok) {
    if (connector.reason === "expired") return refuse(401, "connector expired", fix);
    if (connector.reason === "disabled") {
      return refuse(403, "tunnel disabled", "The app turned this tunnel's account off.");
    }
    return refuse(401, "connector revoked or unknown", fix);
  }
  const { orgId } = connector;
  if (await isOrgBlocked(db, orgId)) {
    return refuse(401, "org blocked", `Contact the operator of ${config.auth.baseURL}.`);
  }
  const plan = await orgPlan(db, config, orgId);
  if (!plan || (config.auth.billing && plan.plan !== "business")) {
    return refuse(
      402,
      "no subscription",
      "The app's Wurmhol org is not on Business. Ask the app's team to check its plan.",
    );
  }
  const wait = await checkRateLimit(c.env, config, "connect", connector.connectorId);
  if (wait) {
    return refuse(429, "too many requests", `Wait ${wait} s and try again.`, { retryAfter: wait });
  }

  // A reconnect: this connector's session of this tunnel, still open.
  const resume = c.req.query("share");
  if (resume !== undefined) {
    const share = SHARE_ID.test(resume) ? await findShare(db, resume) : null;
    if (
      !share ||
      share.tunnelId !== connector.tunnelId ||
      share.connectorId !== connector.connectorId
    ) {
      return shareGone(null);
    }
    if (share.endedAt) {
      return shareGone(isEndReason(share.endReason) ? share.endReason : "disconnected");
    }
    return shareStub(c.env, share.id).fetch(toShare(c.req.raw, { cli: null }));
  }

  if (
    c.req.query("name") !== undefined ||
    c.req.header(CONNECT_HEADERS.viewers) !== undefined ||
    c.req.header(CONNECT_HEADERS.access) !== undefined
  ) {
    return refuse(
      400,
      "not for a tunnel",
      "A connector opens its own tunnel: leave out --name, --only and WURMHOL_ACCESS_KEY.",
    );
  }
  const port = Number(c.req.query("port"));
  if (!isPort(port)) {
    return refuse(400, "bad port", "Pass the port your server listens on: npx wurmhol 8787.");
  }
  const seconds = pipeSeconds(c);
  if (seconds instanceof Response) return seconds;

  const embed = {
    appId: connector.appId,
    tenantId: connector.tenantId,
    tunnelId: connector.tunnelId,
    connectorId: connector.connectorId,
  };
  const record = () =>
    recordShareStart(db, {
      orgId,
      tokenId: null,
      startedBy: null,
      port,
      name: connector.name,
      embed,
    });
  let started = await record();
  if (
    !started.ok &&
    started.reason === "open" &&
    (await takeOver(
      c.env,
      db,
      orgId,
      started.open.connectorId === connector.connectorId,
      started.open,
    ))
  ) {
    started = await record();
  }
  if (!started.ok) {
    return refuse(
      409,
      "tunnel open",
      "This tunnel is already open from another connection. Stop that one first.",
    );
  }
  if (connector.stopped) await setEmbedTunnelStopped(db, orgId, connector.tunnelId, false);

  const init: ShareInit = {
    id: started.id,
    orgId,
    tokenId: null,
    port,
    url: shareOrigin(config, { id: started.id, name: connector.name }),
    startedBy: null,
    startedAt: started.startedAt.getTime(),
    viewers: null,
    source: null,
    accessHash: null,
    embed,
    limits: {
      seconds,
      monthlyBytes: plan.limits.monthlyBytes,
      monthlyRequests: plan.limits.monthlyRequests,
    },
  };
  const org = orgStub(c.env, orgId);
  const set = await embedLimitsOf(db, embed.appId, embed.tenantId);
  const reservation = await org.reserveEmbedded(
    { id: init.id, appId: embed.appId, tenantId: embed.tenantId, tunnelId: embed.tunnelId },
    { ...plan.limits, active: config.LIMIT_EMBED_ACTIVE },
    {
      monthlyRequests: set?.appMonthlyRequests ?? null,
      activeTunnels: set?.appActiveTunnels ?? null,
      tenantMonthlyRequests: set?.tenantMonthlyRequests ?? null,
      tenantActiveTunnels: set?.tenantActiveTunnels ?? null,
    },
    {
      monthlyRequests: set?.ownMonthlyRequests ?? null,
      activeTunnels: set?.ownActiveTunnels ?? null,
    },
  );
  if (!reservation.ok) {
    await recordShareEnd(db, { id: init.id, reason: "limit", bytes: 0 });
    // An application's or tenant's own limit: the app's to raise, not the org's plan.
    if (reservation.scope === "app" || reservation.scope === "tenant") {
      const whose = reservation.scope === "app" ? "The app" : "This account";
      return reservation.reason === "active_limit"
        ? refuse(
            429,
            "active pipe limit",
            `${whose} already has ${reservation.limit} tunnels open. Close one, or ask the app to raise its limit.`,
          )
        : refuse(
            429,
            "monthly request limit",
            `${whose} has used this month's requests. Ask the app to raise its limit.`,
          );
    }
    return reservationRefusal(
      reservation,
      plan,
      () => "The app has too many tunnels open. Try again later.",
      config.auth.baseURL,
    );
  }
  const response = await shareStub(c.env, init.id).fetch(toShare(c.req.raw, { cli: init }));
  if (response.status !== 101) {
    await org.remove(init.id);
    await recordShareEnd(db, { id: init.id, reason: "disconnected", bytes: 0 });
  }
  c.var.log.info("embed.session_started", {
    shareId: init.id,
    orgId,
    appId: embed.appId,
    tunnelId: embed.tunnelId,
    port,
  });
  return response;
}
