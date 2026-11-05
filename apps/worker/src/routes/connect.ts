// `GET /connect`: the CLI's one WebSocket (spec section 5). The token says which org; a `share`
// query parameter brings back a share whose CLI dropped (it keeps its id for 60 s).
//
// Refusals answer with plain HTTP before the upgrade, as `{ error, fix }`: the CLI prints `fix`,
// one line that says what to do.
import { findShare, orgStanding, recordShareEnd, recordShareStart, useToken } from "@wurmhol/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { shareOrigin, SHARE_ID } from "../env.ts";
import { checkRateLimit } from "../rate-limiter.ts";
import { INTERNAL_HEADERS, type ShareInit } from "../share-do.ts";

function refuse(status: number, error: string, fix: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error, fix, ...extra }, { status });
}

export const connect = new Hono<AppEnv>().get("/", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(426, "expected a websocket upgrade", "Connect with the wurmhol CLI.");
  }
  const { config, db } = c.var;
  const authorization = c.req.header("authorization") ?? "";
  const presented = /^Bearer (\S+)$/.exec(authorization)?.[1];
  if (!presented) {
    return refuse(
      401,
      "token missing",
      `Set WURMHOL_TOKEN to a token from ${config.auth.baseURL} (menu → Tokens).`,
    );
  }
  const token = await useToken(db, presented);
  if (!token) {
    return refuse(
      401,
      "token revoked or unknown",
      `Create a new token at ${config.auth.baseURL} (menu → Tokens) and set WURMHOL_TOKEN.`,
    );
  }
  const wait = await checkRateLimit(c.env, config, "connect", token.id);
  if (wait) {
    return refuse(429, "too many connections", `Wait ${wait} s and try again.`, {
      retryAfter: wait,
    });
  }
  const standing = await orgStanding(db, token.orgId, {
    enabled: config.auth.billing !== undefined,
    trialDays: config.auth.trialDays,
  });
  if (!standing.ok) {
    return refuse(
      402,
      "no subscription",
      `The org's trial has ended. Subscribe at ${config.auth.baseURL} (menu → Billing).`,
    );
  }

  // A reconnect: the same token's share, still open.
  const resume = c.req.query("share");
  if (resume !== undefined) {
    const share = SHARE_ID.test(resume) ? await findShare(db, resume) : null;
    if (!share || share.orgId !== token.orgId || share.tokenId !== token.id) {
      return refuse(404, "share not found", "Start a new share: npx wurmhol <port>.");
    }
    if (share.endedAt) {
      return refuse(410, "share ended", "Start a new share: npx wurmhol <port>.", {
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
  const started = await recordShareStart(db, {
    orgId: token.orgId,
    tokenId: token.id,
    startedBy: token.createdBy,
    port,
  });
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
    url: shareOrigin(config, started.id),
    startedBy: starter?.name || starter?.email || null,
    startedAt: started.startedAt.getTime(),
    limits: { seconds: config.LIMIT_SHARE_SECONDS, monthlyBytes: config.LIMIT_MONTHLY_BYTES },
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
      state: "live",
    },
    { active: config.LIMIT_ACTIVE_SHARES, monthlyBytes: config.LIMIT_MONTHLY_BYTES },
  );
  if (!reservation.ok) {
    await recordShareEnd(db, { id: init.id, reason: "limit", bytes: 0 });
    return reservation.reason === "active_limit"
      ? refuse(
          429,
          "active share limit",
          `The org already has ${reservation.limit} open shares. Stop one (wurmhol stop <port>) or terminate one on ${config.auth.baseURL}.`,
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
