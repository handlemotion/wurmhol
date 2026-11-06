// Share tokens: what the CLI presents to start shares for an org (spec section 6).
import type { TokenScope, TokenSource } from "@wurmhol/protocol";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { randomSecret, sha256Hex } from "./crypto.ts";
import { tokens, users } from "./schema/index.ts";

/** Every token starts with this, so secret scanners and people can tell what it is. */
export const TOKEN_PREFIX = "wh_";

/** A new token for `orgId`. The plaintext is returned once and never stored. */
export async function createToken(
  db: Db,
  input: {
    orgId: string;
    name: string;
    createdBy: string;
    scope: TokenScope;
    /** `login` for a computer approved with `wurmhol login`; the console's own by default. */
    source?: TokenSource;
    /** Null: never expires. */
    expiresAt: Date | null;
    /** The device login's normalized user code, for a `login` token (ADR 0026). */
    loginCode?: string;
  },
) {
  const token = `${TOKEN_PREFIX}${randomSecret(32)}`;
  const id = uuidv7();
  await db.insert(tokens).values({
    id,
    orgId: input.orgId,
    name: input.name,
    hash: await sha256Hex(token),
    scope: input.scope,
    source: input.source ?? "console",
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
    loginCode: input.loginCode ?? null,
  });
  return { id, token };
}

export async function listTokens(db: Db, orgId: string) {
  return db
    .select({
      id: tokens.id,
      name: tokens.name,
      scope: tokens.scope,
      source: tokens.source,
      createdAt: tokens.createdAt,
      expiresAt: tokens.expiresAt,
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

/** Revokes every live token `userId` made in `orgId`: they are leaving it. Returns their ids. */
export async function revokeTokensOf(db: Db, orgId: string, userId: string) {
  const revoked = await db
    .update(tokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(tokens.orgId, orgId), eq(tokens.createdBy, userId), isNull(tokens.revokedAt)))
    .returning({ id: tokens.id });
  return revoked.map((token) => token.id);
}

export type TokenUse =
  | { ok: true; id: string; orgId: string; createdBy: string | null; scope: TokenScope }
  | { ok: false; reason: "unknown" | "expired" };

/**
 * The live token a plaintext token is, with who made it, and records the use. Revoked and
 * unknown tokens are `unknown`; a live one past its `expires_at` is `expired`.
 */
export async function useToken(db: Db, token: string): Promise<TokenUse> {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "unknown" };
  const hash = await sha256Hex(token);
  const now = new Date();
  const [row] = await db
    .update(tokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(tokens.hash, hash),
        isNull(tokens.revokedAt),
        or(isNull(tokens.expiresAt), gt(tokens.expiresAt, now)),
      ),
    )
    .returning({
      id: tokens.id,
      orgId: tokens.orgId,
      createdBy: tokens.createdBy,
      scope: tokens.scope,
    });
  if (row) return { ok: true, ...row };
  const [expired] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.hash, hash), isNull(tokens.revokedAt)))
    .limit(1);
  return { ok: false, reason: expired ? "expired" : "unknown" };
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
