// Embedded mode (ADR 0032): applications an org runs for its own users, their tenants and
// subjects, the tunnels they own, and the credentials around them. Every table has `org_id` and
// goes with its org. Rows are soft-deleted (`deleted_at`, `disabled_at`, `revoked_at`) so that
// history and the grant log keep their meaning; secrets are stored only as SHA-256 hashes.
import type { EmbedPermission, GrantKind, SubjectKind } from "@wurmhol/protocol";
import { GRANT_KINDS, SUBJECT_KINDS } from "@wurmhol/protocol";
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
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * One integrating SaaS inside an org. Its limits are null when unset: a tenant's defaults fall
 * back to the code's, the application's to the org's.
 */
export const embedApps = sqliteTable(
  "embed_apps",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Where an unknown or expired browser goes to be signed in by the SaaS; null: a 401. */
    launchUrl: text("launch_url"),
    /** Origins whose pages may open a tunnel's WebSocket with a subprotocol grant. */
    allowedOrigins: text("allowed_origins", { mode: "json" })
      .$type<string[]>()
      .default(sql`'[]'`)
      .notNull(),
    monthlyRequests: integer("monthly_requests"),
    activeTunnels: integer("active_tunnels"),
    tenantMonthlyRequests: integer("tenant_monthly_requests"),
    tenantActiveTunnels: integer("tenant_active_tunnels"),
    createdAt: timestamp("created_at").default(now).notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("embed_apps_org_idx").on(table.orgId)],
);

/** The SaaS backend's integration keys (`whk_`). Owned by the application, not by a person. */
export const embedAppKeys = sqliteTable(
  "embed_app_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => embedApps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lowercase hex SHA-256 of the key. */
    hash: text("hash").notNull(),
    permissions: text("permissions", { mode: "json" }).$type<EmbedPermission[]>().notNull(),
    /** Who made it, for the console. Leaving the org does not revoke it (ADR 0032). */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").default(now).notNull(),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("embed_app_keys_hash_idx").on(table.hash),
    index("embed_app_keys_app_idx").on(table.appId),
    index("embed_app_keys_org_idx").on(table.orgId),
  ],
);

/** An isolated customer or account inside an application, named by the SaaS's own opaque id. */
export const embedTenants = sqliteTable(
  "embed_tenants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => embedApps.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    /** Overrides of the application's per-tenant defaults. */
    monthlyRequests: integer("monthly_requests"),
    activeTunnels: integer("active_tunnels"),
    createdAt: timestamp("created_at").default(now).notNull(),
    disabledAt: timestamp("disabled_at"),
  },
  (table) => [
    uniqueIndex("embed_tenants_external_idx").on(table.appId, table.externalId),
    index("embed_tenants_org_idx").on(table.orgId),
  ],
);

/** An end user or service of one tenant. Not a Wurmhol user: no account, session or membership. */
export const embedSubjects = sqliteTable(
  "embed_subjects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => embedApps.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => embedTenants.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: SUBJECT_KINDS }).$type<SubjectKind>().notNull(),
    createdAt: timestamp("created_at").default(now).notNull(),
    disabledAt: timestamp("disabled_at"),
  },
  (table) => [
    uniqueIndex("embed_subjects_external_idx").on(table.tenantId, table.externalId),
    index("embed_subjects_org_idx").on(table.orgId),
  ],
);

/**
 * A durable, private endpoint for one tenant. Its sessions are `shares` rows; its host is `name`
 * (`e` + 15 characters), also reserved in `pipe_names`, and never reused.
 */
export const embedTunnels = sqliteTable(
  "embed_tunnels",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => embedApps.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => embedTenants.id, { onDelete: "cascade" }),
    ownerSubjectId: text("owner_subject_id")
      .notNull()
      .references(() => embedSubjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").default(now).notNull(),
    /** Its integration stopped it; the connector may open it again. */
    stoppedAt: timestamp("stopped_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    uniqueIndex("embed_tunnels_name_idx").on(table.name),
    index("embed_tunnels_tenant_idx").on(table.tenantId),
    index("embed_tunnels_owner_idx").on(table.ownerSubjectId),
    index("embed_tunnels_org_idx").on(table.orgId),
  ],
);

/** Who may be granted traffic to a tunnel: subjects of its tenant, the owner from creation. */
export const embedTunnelAccess = sqliteTable(
  "embed_tunnel_access",
  {
    tunnelId: text("tunnel_id")
      .notNull()
      .references(() => embedTunnels.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => embedSubjects.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").default(now).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tunnelId, table.subjectId] }),
    index("embed_tunnel_access_subject_idx").on(table.subjectId),
    index("embed_tunnel_access_org_idx").on(table.orgId),
  ],
);

/** One agent's credential (`whc_`) for one tunnel's `/connect`. */
export const embedConnectors = sqliteTable(
  "embed_connectors",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tunnelId: text("tunnel_id")
      .notNull()
      .references(() => embedTunnels.id, { onDelete: "cascade" }),
    /** Lowercase hex SHA-256 of the credential. */
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at").default(now).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("embed_connectors_hash_idx").on(table.hash),
    index("embed_connectors_tunnel_idx").on(table.tunnelId),
    index("embed_connectors_org_idx").on(table.orgId),
  ],
);

/**
 * A subject's traffic grant for one tunnel. A `client` grant has a token (`whg_`), stored as
 * `hash`; a `browser` grant has none, and is reached through a launch code and a signed cookie.
 */
export const embedGrants = sqliteTable(
  "embed_grants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => embedApps.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => embedTenants.id, { onDelete: "cascade" }),
    tunnelId: text("tunnel_id")
      .notNull()
      .references(() => embedTunnels.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => embedSubjects.id, { onDelete: "cascade" }),
    /** The integration key that issued it. */
    keyId: text("key_id").references(() => embedAppKeys.id, { onDelete: "set null" }),
    kind: text("kind", { enum: GRANT_KINDS }).$type<GrantKind>().notNull(),
    /** Lowercase hex SHA-256 of a client grant's token; null for a browser grant. */
    hash: text("hash"),
    createdAt: timestamp("created_at").default(now).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("embed_grants_hash_idx").on(table.hash),
    index("embed_grants_tunnel_idx").on(table.tunnelId),
    index("embed_grants_subject_idx").on(table.subjectId),
    index("embed_grants_org_idx").on(table.orgId),
  ],
);

/** A browser grant's one-time launch code: 60 seconds, deleted on use, swept when stale. */
export const embedLaunchCodes = sqliteTable(
  "embed_launch_codes",
  {
    /** Lowercase hex SHA-256 of the code. */
    hash: text("hash").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: text("grant_id")
      .notNull()
      .references(() => embedGrants.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("embed_launch_codes_expires_idx").on(table.expiresAt),
    index("embed_launch_codes_org_idx").on(table.orgId),
  ],
);

/** The grant log: each grant issued or revoked. No IPs, user agents, paths or bodies. */
export const embedGrantEvents = sqliteTable(
  "embed_grant_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: text("grant_id")
      .notNull()
      .references(() => embedGrants.id, { onDelete: "cascade" }),
    tunnelId: text("tunnel_id")
      .notNull()
      .references(() => embedTunnels.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => embedSubjects.id, { onDelete: "cascade" }),
    keyId: text("key_id").references(() => embedAppKeys.id, { onDelete: "set null" }),
    event: text("event", { enum: ["issued", "revoked"] }).notNull(),
    at: timestamp("at").default(now).notNull(),
  },
  (table) => [
    index("embed_grant_events_tunnel_idx").on(table.tunnelId, table.at),
    index("embed_grant_events_org_idx").on(table.orgId),
  ],
);
