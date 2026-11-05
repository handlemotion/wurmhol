// Wurmhol's own tables. Every one belongs to an org (`org_id`). Better Auth's tables are in
// `auth.ts`, generated; never edit that file by hand.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.ts";

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

/** What a token may do (ADR 0008): `pipes` opens pipes; `org` also lists and closes the org's. */
export const TOKEN_SCOPES = ["pipes", "org"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * How a token came to be: made in the console's Tokens dialog, or minted for a computer approved
 * with `wurmhol login` (ADR 0008), which the console lists as a signed-in computer.
 */
export const TOKEN_SOURCES = ["console", "login"] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];

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
    source: text("source", { enum: TOKEN_SOURCES }).default("console").notNull(),
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
    /** A named pipe's name (ADR 0009), its host's first label instead of `id`. */
    name: text("name"),
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
    // One open pipe per name: the host routes to it.
    uniqueIndex("shares_open_name_idx")
      .on(table.name)
      .where(sql`${table.name} is not null and ${table.endedAt} is null`),
  ],
);

/**
 * Pipe names (ADR 0009): the first org to open a pipe with a name keeps it, so its host, and any
 * OAuth redirect URI registered for it, never serves another org.
 */
export const pipeNames = sqliteTable(
  "pipe_names",
  {
    name: text("name").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(now).notNull(),
  },
  (table) => [index("pipe_names_org_idx").on(table.orgId)],
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

/**
 * The view log (ADR 0008): per share and viewer, when they first and last opened it and how
 * many requests they made. Events only: no paths, IPs or user agents. Goes with its share.
 */
export const shareViews = sqliteTable(
  "share_views",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    requests: integer("requests").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shareId, table.userId] }),
    index("share_views_org_idx").on(table.orgId),
  ],
);

/**
 * The OAuth callback relay (ADR 0010): an OAuth `state` a pipe's app sent its viewer off with,
 * and the pipe the provider's callback goes back to. Stored only as a SHA-256 hash, taken once,
 * gone after minutes. Never the code, the redirect or anything from a body.
 */
export const oauthStates = sqliteTable(
  "oauth_states",
  {
    /** Lowercase hex SHA-256 of the `state` parameter. */
    hash: text("hash").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("oauth_states_org_idx").on(table.orgId),
    index("oauth_states_expires_idx").on(table.expiresAt),
  ],
);
