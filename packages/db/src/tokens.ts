// Share tokens: what the CLI presents to start shares for an org (spec section 6).
import { and, desc, eq, isNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { randomSecret, sha256Hex } from "./crypto.ts";
import { tokens, users } from "./schema/index.ts";

/** Every token starts with this, so secret scanners and people can tell what it is. */
export const TOKEN_PREFIX = "wh_";

/** A new token for `orgId`. The plaintext is returned once and never stored. */
export async function createToken(
  db: Db,
  input: { orgId: string; name: string; createdBy: string },
) {
  const token = `${TOKEN_PREFIX}${randomSecret(32)}`;
  const id = uuidv7();
  await db.insert(tokens).values({
    id,
    orgId: input.orgId,
    name: input.name,
    hash: await sha256Hex(token),
    createdBy: input.createdBy,
  });
  return { id, token };
}

export async function listTokens(db: Db, orgId: string) {
  return db
    .select({
      id: tokens.id,
      name: tokens.name,
      createdAt: tokens.createdAt,
      lastUsedAt: tokens.lastUsedAt,
      createdBy: users.name,
    })
    .from(tokens)
    .leftJoin(users, eq(users.id, tokens.createdBy))
    .where(and(eq(tokens.orgId, orgId), isNull(tokens.revokedAt)))
    .orderBy(desc(tokens.createdAt));
}

/** Revokes a token of `orgId`. False when there is no such live token. */
export async function revokeToken(db: Db, orgId: string, tokenId: string) {
  const revoked = await db
    .update(tokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(tokens.id, tokenId), eq(tokens.orgId, orgId), isNull(tokens.revokedAt)))
    .returning({ id: tokens.id });
  return revoked.length > 0;
}

/** The live token a plaintext token is, with who made it, or null. Records the use. */
export async function useToken(db: Db, token: string) {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await db
    .update(tokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(tokens.hash, await sha256Hex(token)), isNull(tokens.revokedAt)))
    .returning({ id: tokens.id, orgId: tokens.orgId, createdBy: tokens.createdBy });
  return row ?? null;
}

/** Whether a token is still live: a reconnecting CLI's token may have been revoked meanwhile. */
export async function isTokenLive(db: Db, tokenId: string) {
  const [row] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.id, tokenId), isNull(tokens.revokedAt)))
    .limit(1);
  return row !== undefined;
}
