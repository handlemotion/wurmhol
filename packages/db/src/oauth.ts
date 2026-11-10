// The OAuth callback relay (ADR 0010): which pipe an OAuth `state` belongs to, for minutes.
import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { sha256Hex } from "./crypto.ts";
import { oauthStates, shares } from "./schema/index.ts";

/**
 * Records that `state` belongs to `shareId`, until `expiresAt`. The first pipe to record a state
 * keeps it: another pipe sending its viewer off with the same state cannot take its callback.
 */
export async function recordOAuthState(
  db: Db,
  input: { state: string; orgId: string; shareId: string; expiresAt: Date; host?: string | null },
) {
  await db
    .insert(oauthStates)
    .values({
      hash: await sha256Hex(input.state),
      orgId: input.orgId,
      shareId: input.shareId,
      expiresAt: input.expiresAt,
      host: input.host ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Takes `state`'s pipe, once: the row is deleted whether or not it has expired. Null when the
 * state is unknown, already taken or expired.
 */
export async function takeOAuthState(db: Db, state: string, now = new Date()) {
  const [taken] = await db
    .delete(oauthStates)
    .where(eq(oauthStates.hash, await sha256Hex(state)))
    .returning({
      shareId: oauthStates.shareId,
      expiresAt: oauthStates.expiresAt,
      host: oauthStates.host,
    });
  if (!taken || taken.expiresAt <= now) return null;
  const [share] = await db
    .select({ id: shares.id, orgId: shares.orgId, name: shares.name, endedAt: shares.endedAt })
    .from(shares)
    .where(eq(shares.id, taken.shareId))
    .limit(1);
  return share ? { ...share, host: taken.host } : null;
}
