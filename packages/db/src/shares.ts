// Share history. The live state of an open share is its Durable Object; these rows record that
// a share existed (ids are never reused) and how it ended.
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.ts";
import { randomShareId } from "./crypto.ts";
import { shares, users } from "./schema/index.ts";

/**
 * Records a new share under a fresh id. The primary key makes an id unique forever; on the
 * astronomically rare collision, another id is drawn.
 */
export async function recordShareStart(
  db: Db,
  input: { orgId: string; tokenId: string; startedBy: string | null; port: number },
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomShareId();
    const inserted = await db
      .insert(shares)
      .values({ id, ...input })
      .onConflictDoNothing()
      .returning({ id: shares.id, startedAt: shares.startedAt });
    if (inserted[0]) return inserted[0];
  }
  throw new Error("could not draw an unused share id");
}

/** Marks a share ended, once: a second call (a retried alarm) changes nothing. */
export async function recordShareEnd(db: Db, input: { id: string; reason: string; bytes: number }) {
  await db
    .update(shares)
    .set({ endedAt: new Date(), endReason: input.reason, bytes: input.bytes })
    .where(and(eq(shares.id, input.id), isNull(shares.endedAt)));
}

/** One share with its starter's name, or null. */
export async function findShare(db: Db, id: string) {
  const [row] = await db
    .select({
      id: shares.id,
      orgId: shares.orgId,
      tokenId: shares.tokenId,
      port: shares.port,
      startedAt: shares.startedAt,
      endedAt: shares.endedAt,
      endReason: shares.endReason,
      startedBy: users.name,
    })
    .from(shares)
    .leftJoin(users, eq(users.id, shares.startedBy))
    .where(eq(shares.id, id))
    .limit(1);
  return row ?? null;
}

/** Open shares started with `tokenId`: ended when the token is revoked. */
export async function openSharesOfToken(db: Db, tokenId: string) {
  return db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.tokenId, tokenId), isNull(shares.endedAt)));
}
