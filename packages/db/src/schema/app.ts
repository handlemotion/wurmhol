// Wurmhol's own tables. Every one belongs to an org (`org_id`). Better Auth's tables are in
// `auth.ts`, generated; never edit that file by hand.
import { DOMAIN_ERROR_CODES, DOMAIN_STATES, TOKEN_SCOPES, TOKEN_SOURCES } from "@wurmhol/protocol";
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
import { embedApps, embedConnectors, embedTenants, embedTunnels } from "./embed.ts";

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

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
    /**
     * The normalized user code of the device login that made it, so the approval page can follow
     * the login to the pipe it opens (ADR 0026). Null for console tokens.
     */
    loginCode: text("login_code"),
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
    // Where the pipe came from (ADR 0015): what the CLI that opened it said about itself, each
    // field bounded and checked by `@wurmhol/protocol`'s `parsePipeSource`. Null when not sent.
    /** The forge's host, like `github.com`. */
    repoHost: text("repo_host"),
    /** The repo's path on the forge, like `owner/name`. */
    repo: text("repo"),
    branch: text("branch"),
    /** Full commit hash. */
    commitSha: text("commit_sha"),
    /** `--link`: an http(s) URL. */
    link: text("link"),
    /** `--note`: one line. */
    note: text("note"),
    /** The agent that opened it, like `Claude Code`. */
    agent: text("agent"),
    /** The agent session's page, http(s). */
    agentUrl: text("agent_url"),
    // An embedded tunnel's session (ADR 0032); all null for a classic pipe. No delete action:
    // embedded rows are soft-deleted, so deleting one a session points at is refused rather than
    // turning the session into an org pipe. Deleting the org removes both through `org_id`.
    appId: text("app_id").references(() => embedApps.id),
    tenantId: text("tenant_id").references(() => embedTenants.id),
    tunnelId: text("tunnel_id").references(() => embedTunnels.id),
    connectorId: text("connector_id").references(() => embedConnectors.id),
  },
  (table) => [
    index("shares_org_idx").on(table.orgId, table.endedAt),
    index("shares_token_idx").on(table.tokenId),
    index("shares_tunnel_idx").on(table.tunnelId, table.endedAt),
    // Open pipes of a branch, for a pull request opened after its pipe (ADR 0016).
    index("shares_open_branch_idx")
      .on(table.branch)
      .where(sql`${table.branch} is not null and ${table.endedAt} is null`),
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
    /** The host the flow started on when it was a custom domain (ADR 0030), where it comes back. */
    host: text("host"),
  },
  (table) => [
    index("oauth_states_org_idx").on(table.orgId),
    index("oauth_states_expires_idx").on(table.expiresAt),
  ],
);

/**
 * GitHub App installations an org has linked (ADR 0016): its pipes post themselves to matching
 * pull requests in the installation's repos. Linked only by a member GitHub shows the
 * installation to, so an org cannot claim another account's installation.
 */
export const githubInstallations = sqliteTable(
  "github_installations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    /** The GitHub account (user or organization) it is installed on, as GitHub spells it. */
    account: text("account").notNull(),
    linkedBy: text("linked_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(now).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.installationId] }),
    index("github_installations_installation_idx").on(table.installationId),
  ],
);

/**
 * Orgs an operator blocked for abuse (ADR 0022): their tokens open no pipes and connect no
 * machines. Deleting the row unblocks the org.
 */
export const orgBlocks = sqliteTable("org_blocks", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** The operator's note: the report it answers. Never shown to the org. */
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(now).notNull(),
});

/**
 * A Business org's monthly spend cap (ADR 0027), set by an owner: the most its bill may reach in
 * a billing period, base price included. Its pipes stop at the requests that would pass it. No
 * row: `DEFAULT_SPEND_CAP_CENTS`.
 */
export const spendCaps = sqliteTable("spend_caps", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  cents: integer("cents").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(now).notNull(),
});

/**
 * Custom domains (ADR 0030): a hostname an org owns, attached to one of its pipe names. Only an
 * `active` row is routed. The hostname is unique across orgs: it is the key, and Cloudflare's zone
 * holds one custom hostname per name too. Goes with its pipe name, and with its org.
 */
export const customDomains = sqliteTable(
  "custom_domains",
  {
    /** Lowercase, no trailing dot (`@wurmhol/protocol`'s `customHostname`). */
    hostname: text("hostname").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pipeName: text("pipe_name")
      .notNull()
      .references(() => pipeNames.name, { onDelete: "cascade" }),
    state: text("state", { enum: DOMAIN_STATES }).notNull(),
    /** Random. The org publishes it as a TXT record to prove it owns the hostname. */
    challenge: text("challenge").notNull(),
    /** Cloudflare's id for the custom hostname. Null once it is deleted there. */
    providerId: text("provider_id"),
    /** Cloudflare's own words for the hostname and its certificate, as last read. */
    providerStatus: text("provider_status"),
    providerSslStatus: text("provider_ssl_status"),
    /** Why a `failed` domain failed. */
    errorCode: text("error_code", { enum: DOMAIN_ERROR_CODES }),
    /** Cloudflare's last words about what is wrong, shown to the org. */
    errorDetail: text("error_detail"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(now).notNull(),
    /** When the TXT record was first seen. */
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    /** When it first became `active`: the oldest active domain of a name is the pipe's URL. */
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    /** A `pending` domain is removed at this time. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /** The last time the domain was checked against DNS and Cloudflare. */
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("custom_domains_org_idx").on(table.orgId),
    index("custom_domains_name_idx").on(table.pipeName, table.state),
    index("custom_domains_check_idx").on(table.state, table.checkedAt),
  ],
);
