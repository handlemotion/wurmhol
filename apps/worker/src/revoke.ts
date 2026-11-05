// Revoked tokens stop at once: their open pipes end ("revoked") and their machines disconnect.
import { type Db, openSharesOfToken, revokeTokensOf } from "@wurmhol/db";

/** Ends what already-revoked tokens of `orgId` still run. */
export async function endTokens(env: Env, db: Db, orgId: string, tokenIds: string[]) {
  const org = env.ORG.get(env.ORG.idFromName(orgId));
  for (const tokenId of tokenIds) {
    for (const share of await openSharesOfToken(db, tokenId)) {
      await env.SHARE.get(env.SHARE.idFromName(share.id)).terminate("revoked");
    }
    await org.dropToken(tokenId);
  }
}

/** Someone left `orgId` (removed, or by choice): every token they made there is revoked. */
export async function revokeTokensOfLeaver(env: Env, db: Db, orgId: string, userId: string) {
  await endTokens(env, db, orgId, await revokeTokensOf(db, orgId, userId));
}
