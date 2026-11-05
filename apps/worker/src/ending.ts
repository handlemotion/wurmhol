// Ending shares: one at a person's Terminate (the wall, `/v1/pipes`, MCP, a deleted org), or every
// share of a revoked token, whose machines disconnect too.
import { type Db, findShare, openSharesOfToken, revokeTokensOf } from "@wurmhol/db";
import type { AppEnv } from "./context.ts";
import { SHARE_ID } from "@wurmhol/protocol";
import { orgStub } from "./org-do.ts";
import { shareStub } from "./share-do.ts";

interface Scope {
  env: Env;
  var: Pick<AppEnv["Variables"], "db" | "log">;
}

/** A share of `orgId` by its id, or null: another org's shares do not exist for its members. */
export async function shareOfOrg(db: Db, orgId: string, id: string) {
  const share = SHARE_ID.test(id) ? await findShare(db, id) : null;
  return share?.orgId === orgId ? share : null;
}

/**
 * Ends a share now: its URL stops working and its CLI hears why. `via` names who ended it, for
 * the log.
 */
export async function endShare(
  c: Scope,
  share: { id: string; orgId: string },
  reason: "terminated" | "revoked",
  via: "wall" | "api" | "mcp" | "org deleted" | "token revoked",
) {
  await shareStub(c.env, share.id).terminate(reason);
  c.var.log.info("share.terminated", { shareId: share.id, orgId: share.orgId, reason, via });
}

/** Ends what already-revoked tokens of `orgId` still run: their shares and machines. */
export async function endTokens(c: Scope, orgId: string, tokenIds: string[]) {
  const org = orgStub(c.env, orgId);
  for (const tokenId of tokenIds) {
    for (const share of await openSharesOfToken(c.var.db, tokenId)) {
      await endShare(c, { id: share.id, orgId }, "revoked", "token revoked");
    }
    await org.dropToken(tokenId);
  }
}

/** Someone left `orgId` (removed, or by choice): every token they made there is revoked. */
export async function revokeTokensOfLeaver(c: Scope, orgId: string, userId: string) {
  await endTokens(c, orgId, await revokeTokensOf(c.var.db, orgId, userId));
}
