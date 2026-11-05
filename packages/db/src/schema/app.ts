// Wurmhol's own tables. Every one belongs to an org (`org_id`). Better Auth's tables are in
// `auth.ts`, generated; never edit that file by hand.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.ts";

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

/** What a token may do (ADR 0008): `pipes` opens pipes; `org` also lists and closes the org's. */
export const TOKEN_SCOPES = ["pipes", "org"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * Share tokens (spec section 6, ADR 0008): random, 32 bytes, stored only as a SHA-256 hash.
 * Revoked tokens stay for the history; `revoked_at` is set. Null `expires_at`: never expires.
 */
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lowercase hex SHA-256 of the token. */
    hash: text("hash").notNull(),
    scope: text("scope", { enum: TOKEN_SCOPES }).default("pipes").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(now).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("tokens_hash_idx").on(table.hash),
    index("tokens_org_idx").on(table.orgId),
  ],
);

/**
 * Share history. The live state of an open share is its Share Durable Object; this row records
 * that it existed (ids are never reused) and how it ended.
 */
export const shares = sqliteTable(
  "shares",
  {
    /** 10 random characters, the share host's first label. */
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenId: text("token_id").references(() => tokens.id, { onDelete: "set null" }),
    /** Who started it: the token's creator. */
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    port: integer("port").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).default(now).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    /** `stopped` (the CLI), `terminated` (the wall), `revoked`, `expired`, `disconnected`, `limit`. */
    endReason: text("end_reason"),
    /** Bytes relayed both ways. Bodies themselves are never stored. */
    bytes: integer("bytes").default(0).notNull(),
  },
  (table) => [
    index("shares_org_idx").on(table.orgId, table.endedAt),
    index("shares_token_idx").on(table.tokenId),
  ],
);

/**
 * Invite links (spec section 3, Members): anyone signed in who opens one joins the org as a
 * member. Stored hashed; single use; they expire.
 */
export const inviteLinks = sqliteTable(
  "invite_links",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercase hex SHA-256 of the code in the link. */
    hash: text("hash").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(now).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("invite_links_hash_idx").on(table.hash),
    index("invite_links_org_idx").on(table.orgId),
  ],
);
