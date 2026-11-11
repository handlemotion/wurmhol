// Ending shares: one at a person's Terminate (the wall, `/v1/pipes`, MCP, a deleted org), every
// share of a revoked token, whose machines disconnect too, and embedded tunnels' sessions.
import {
  type Db,
  findShare,
  openSharesOfToken,
  openSharesOfTunnels,
  revokeTokensOf,
} from "@wurmhol/db";
import type { AppEnv } from "./context.ts";
import { SHARE_ID } from "@wurmhol/protocol";
import { orgStub } from "./org-do.ts";
import { shareStub } from "./share-do.ts";

interface Scope {
  env: Env;
  var: Pick<AppEnv["Variables"], "db" | "log">;
}

/**
 * A share of `orgId` by its id, or null: another org's shares do not exist for its members, and
 * neither does an embedded tunnel's session (ADR 0032), which only its integration manages.
 */
export async function shareOfOrg(db: Db, orgId: string, id: string) {
  const share = SHARE_ID.test(id) ? await findShare(db, id) : null;
  return share?.orgId === orgId && !share.tunnelId ? share : null;
}

/**
 * Ends a share now: its URL stops working and its CLI hears why. `via` names who ended it, for
 * the log.
 */
export async function endShare(
  c: Scope,
  share: { id: string; orgId: string },
  reason: "terminated" | "revoked",
  via:
    | "wall"
    | "api"
    | "mcp"
    | "org deleted"
    | "token revoked"
    | "takedown"
    | "embed stop"
    | "embed delete"
    | "connector revoked",
) {
  await shareStub(c.env, share.id).terminate(reason);
  c.var.log.info("share.terminated", { shareId: share.id, orgId: share.orgId, reason, via });
}

/**
 * Ends what already-revoked tokens of `orgId` still run: their shares and machines. Returns the
 * ids of the shares it ended.
 */
export async function endTokens(c: Scope, orgId: string, tokenIds: string[]) {
  const org = orgStub(c.env, orgId);
  const ended: string[] = [];
  for (const tokenId of tokenIds) {
    for (const share of await openSharesOfToken(c.var.db, tokenId)) {
      await endShare(c, { id: share.id, orgId }, "revoked", "token revoked");
      ended.push(share.id);
    }
    await org.dropToken(tokenId);
  }
  return ended;
}

/** Someone left `orgId` (removed, or by choice): every token they made there is revoked. */
export async function revokeTokensOfLeaver(c: Scope, orgId: string, userId: string) {
  await endTokens(c, orgId, await revokeTokensOf(c.var.db, orgId, userId));
}

/** Ends the open sessions of embedded tunnels (ADR 0032). Returns the ids of the sessions ended. */
export async function endTunnelSessions(
  c: Scope,
  tunnelIds: string[],
  reason: "terminated" | "revoked",
  via: "embed stop" | "embed delete" | "connector revoked" | "takedown",
) {
  const open = await openSharesOfTunnels(c.var.db, tunnelIds);
  for (const share of open) await endShare(c, share, reason, via);
  return open.map((share) => share.id);
}

/** Ends every open embedded session of an org: it is being deleted or blocked. */
export async function endEmbeddedOfOrg(c: Scope, orgId: string, via: "org deleted" | "takedown") {
  const ended: string[] = [];
  for (const session of await orgStub(c.env, orgId).listEmbedded()) {
    await endShare(
      c,
      { id: session.id, orgId },
      via === "takedown" ? "revoked" : "terminated",
      via,
    );
    ended.push(session.id);
  }
  return ended;
}
