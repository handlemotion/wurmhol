// `/operator/*` on the app's host: the deployment operator's takedown path (ADR 0022). Not an org
// member's: the caller presents `OPERATOR_TOKEN`, and without one configured the routes are 404.
import { zValidator } from "@hono/zod-validator";
import {
  blockOrg,
  findDomain,
  findShare,
  latestShareByName,
  revokeEmbedConnectors,
  revokeToken,
  sha256Hex,
} from "@wurmhol/db";
import { pipeName, SHARE_ID } from "@wurmhol/protocol";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { endEmbeddedOfOrg, endShare, endTokens } from "../ending.ts";
import { type Config, shareLabelFromHost } from "../env.ts";
import { shareUrl } from "../share-url.ts";
import { domainDeps, remove } from "../domains/service.ts";
import { orgStub } from "../org-do.ts";

/** A value's SHA-256 as bytes of equal length, for a constant-time comparison. */
async function digest(value: string) {
  return new TextEncoder().encode(await sha256Hex(value));
}

/** Whether `presented` is the operator token, compared in constant time. */
async function isOperatorToken(config: Config, presented: string) {
  if (!config.OPERATOR_TOKEN) return false;
  return crypto.subtle.timingSafeEqual(
    await digest(presented),
    await digest(config.OPERATOR_TOKEN),
  );
}

const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.config.OPERATOR_TOKEN) return c.json({ error: "not found" }, 404);
  const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  if (!(await isOperatorToken(c.var.config, presented))) {
    return c.json({ error: "operator token missing or wrong" }, 401);
  }
  await next();
});

/**
 * The share a report names: its URL, its host, or the host's first label (an id, or a named
 * pipe's name, whose newest pipe it means). Null when it names none.
 */
async function reportedShare(c: { var: AppEnv["Variables"] }, pipe: string) {
  let host = pipe.trim().toLowerCase();
  if (host.includes("://")) host = URL.canParse(host) ? new URL(host).hostname : "";
  // A report may name a pipe by its custom domain (ADR 0030): it means that name's newest pipe.
  const domain = host.includes(".") ? await findDomain(c.var.db, host) : null;
  if (domain) {
    const latest = await latestShareByName(c.var.db, domain.pipeName);
    return latest ? findShare(c.var.db, latest.id) : null;
  }
  const label = shareLabelFromHost(c.var.config, host) ?? host;
  if (SHARE_ID.test(label)) return findShare(c.var.db, label);
  if (!label || pipeName(label) !== label) return null;
  const named = await latestShareByName(c.var.db, label);
  return named ? findShare(c.var.db, named.id) : null;
}

const takedownBody = z.object({
  /** The pipe: `https://<id>.wurmhol.dev/…`, `<id>.wurmhol.dev`, or `<id>`. */
  pipe: z.string().min(1).max(2048),
  /** Deliberate abuse: end every pipe of the org and refuse its tokens from now on. */
  blockOrg: z.boolean().default(false),
  /** The operator's note, stored with the block: which report this answers. */
  note: z.string().max(500).optional(),
});

export const operator = new Hono<AppEnv>()
  .use(requireOperator)
  .post(
    /**
     * Takes a reported pipe down: ends it, revokes the token that opened it (ending that token's
     * other pipes and disconnecting its machines), and with `blockOrg`, blocks its org. Works on a
     * pipe that already ended too: the token and the org are still there to act on.
     */
    "/takedown",
    zValidator("json", takedownBody),
    async (c) => {
      const { pipe, blockOrg: block, note } = c.req.valid("json");
      const share = await reportedShare(c, pipe);
      if (!share) return c.json({ error: "no pipe has that id, host or name" }, 404);
      const { db } = c.var;
      const orgId = share.orgId;
      // D1 first: a CLI reconnecting while its pipe ends finds its token refused.
      if (block) await blockOrg(db, orgId, note ?? null);
      if (share.tokenId) await revokeToken(db, orgId, share.tokenId);
      // An embedded tunnel's session: its connector, as a pipe's token (ADR 0032).
      if (share.tunnelId && share.connectorId) {
        await revokeEmbedConnectors(db, orgId, share.tunnelId, { id: share.connectorId });
      }
      const ended = new Set<string>();
      if (!share.endedAt) {
        await endShare(c, share, "revoked", "takedown");
        ended.add(share.id);
      }
      if (share.tokenId) {
        for (const id of await endTokens(c, orgId, [share.tokenId])) ended.add(id);
      }
      if (block) {
        const org = orgStub(c.env, orgId);
        for (const open of await org.list()) {
          await endShare(c, { id: open.id, orgId }, "revoked", "takedown");
          ended.add(open.id);
        }
        for (const id of await endEmbeddedOfOrg(c, orgId, "takedown")) ended.add(id);
        await org.dropAll();
      }
      c.var.log.info("operator.takedown", {
        shareId: share.id,
        orgId,
        tokenId: share.tokenId,
        orgBlocked: block,
        ended: ended.size,
      });
      return c.json({
        pipe: { id: share.id, url: await shareUrl(c.var.db, c.var.config, share), orgId },
        tokenRevoked: share.tokenId,
        connectorRevoked: share.connectorId,
        endedPipes: [...ended],
        orgBlocked: block,
      });
    },
  )
  /**
   * Takes a custom domain (ADR 0033) out of service: removed here and at Cloudflare, whoever owns
   * it. The org's pipe and its `<name>.<SHARE_DOMAIN>` host are untouched.
   */
  .delete("/domains/:hostname", async (c) => {
    const deps = domainDeps(c.var.config, c.var.db);
    if (!deps) return c.json({ error: "custom domains are not enabled" }, 404);
    const row = await findDomain(c.var.db, c.req.param("hostname").toLowerCase());
    if (row) {
      await remove(deps, row);
      c.var.log.info("operator.domain_removed", { orgId: row.orgId });
    }
    return c.json({ ok: true });
  });
