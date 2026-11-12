// Embedded mode's applications and integration keys (ADR 0032), as the console manages them.
// Every query is scoped by `org_id`: an application of another org does not exist here.
import {
  EMBED_CREDENTIAL_PREFIXES,
  type EmbedPermission,
  type GrantKind,
  LAUNCH_CODE_TTL_SECONDS,
  type SubjectKind,
} from "@wurmhol/protocol";
import { and, desc, eq, exists, gt, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { newEmbedCredential, randomEmbedTunnelName, randomSecret, sha256Hex } from "./crypto.ts";
import {
  embedAppKeys,
  embedApps,
  embedConnectors,
  embedGrantEvents,
  embedGrants,
  embedLaunchCodes,
  embedSubjects,
  embedTenants,
  embedTunnelAccess,
  embedTunnels,
  pipeNames,
  shares,
  users,
} from "./schema/index.ts";

/** What an app manager sets on an application. Null limits: unset. */
export interface EmbedAppSettings {
  name: string;
  launchUrl: string | null;
  allowedOrigins: string[];
  monthlyRequests: number | null;
  activeTunnels: number | null;
  tenantMonthlyRequests: number | null;
  tenantActiveTunnels: number | null;
}

const appColumns = {
  id: embedApps.id,
  name: embedApps.name,
  launchUrl: embedApps.launchUrl,
  allowedOrigins: embedApps.allowedOrigins,
  monthlyRequests: embedApps.monthlyRequests,
  activeTunnels: embedApps.activeTunnels,
  tenantMonthlyRequests: embedApps.tenantMonthlyRequests,
  tenantActiveTunnels: embedApps.tenantActiveTunnels,
  createdAt: embedApps.createdAt,
};

const liveApp = (orgId: string, appId: string) =>
  and(eq(embedApps.id, appId), eq(embedApps.orgId, orgId), isNull(embedApps.deletedAt));

export async function listEmbedApps(db: Db, orgId: string) {
  return db
    .select(appColumns)
    .from(embedApps)
    .where(and(eq(embedApps.orgId, orgId), isNull(embedApps.deletedAt)))
    .orderBy(desc(embedApps.createdAt));
}

/** An application of `orgId` that is not deleted, or undefined. */
export async function findEmbedApp(db: Db, orgId: string, appId: string) {
  const [app] = await db.select(appColumns).from(embedApps).where(liveApp(orgId, appId)).limit(1);

  return app;
}

export async function createEmbedApp(db: Db, orgId: string, settings: EmbedAppSettings) {
  const id = uuidv7();
  await db.insert(embedApps).values({ id, orgId, ...settings });

  return (await findEmbedApp(db, orgId, id))!;
}

/** Changes a live application's settings; undefined when there is none. */
export async function updateEmbedApp(
  db: Db,
  orgId: string,
  appId: string,
  settings: Partial<EmbedAppSettings>,
) {
  const [app] = await db
    .update(embedApps)
    .set(settings)
    .where(liveApp(orgId, appId))
    .returning(appColumns);

  return app;
}

/**
 * Deletes an application: marks it deleted and revokes its integration keys, so its backend is
 * refused at once. Its tunnels and grants end with it in the steps that open them. False when
 * there is no live application.
 */
export async function deleteEmbedApp(db: Db, orgId: string, appId: string) {
  const now = new Date();

  const [deleted] = await db
    .update(embedApps)
    .set({ deletedAt: now })
    .where(liveApp(orgId, appId))
    .returning({ id: embedApps.id });

  if (!deleted) return false;
  await db
    .update(embedAppKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(embedAppKeys.orgId, orgId),
        eq(embedAppKeys.appId, appId),
        isNull(embedAppKeys.revokedAt),
      ),
    );

  return true;
}

/** An application's live integration keys, never their secret. */
export async function listEmbedAppKeys(db: Db, orgId: string, appId: string) {
  return db
    .select({
      id: embedAppKeys.id,
      name: embedAppKeys.name,
      permissions: embedAppKeys.permissions,
      createdAt: embedAppKeys.createdAt,
      expiresAt: embedAppKeys.expiresAt,
      lastUsedAt: embedAppKeys.lastUsedAt,
      createdBy: users.name,
    })
    .from(embedAppKeys)
    .leftJoin(users, eq(users.id, embedAppKeys.createdBy))
    .where(
      and(
        eq(embedAppKeys.orgId, orgId),
        eq(embedAppKeys.appId, appId),
        isNull(embedAppKeys.revokedAt),
      ),
    )
    .orderBy(desc(embedAppKeys.createdAt));
}

/** A new integration key (`whk_`). The plaintext is returned once and never stored. */
export async function createEmbedAppKey(
  db: Db,
  input: {
    orgId: string;
    appId: string;
    name: string;
    permissions: EmbedPermission[];
    createdBy: string;
    /** Null: never expires. */
    expiresAt: Date | null;
  },
) {
  const { value, hash } = await newEmbedCredential("key");
  const id = uuidv7();
  await db.insert(embedAppKeys).values({ id, hash, ...input });

  return { id, key: value };
}

/** Revokes a live key of the application. False when there is none. */
export async function revokeEmbedAppKey(db: Db, orgId: string, appId: string, keyId: string) {
  const revoked = await db
    .update(embedAppKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(embedAppKeys.id, keyId),
        eq(embedAppKeys.orgId, orgId),
        eq(embedAppKeys.appId, appId),
        isNull(embedAppKeys.revokedAt),
      ),
    )
    .returning({ id: embedAppKeys.id });

  return revoked.length > 0;
}

// --- What the integration (a `whk_` key) manages ----------------------------------------------

export type EmbedKeyUse =
  | { ok: true; keyId: string; orgId: string; appId: string; permissions: EmbedPermission[] }
  | { ok: false; reason: "unknown" | "expired" };

/**
 * The live integration key `presented` is, of a live application, and records its use. Revoked
 * and unknown keys, and keys of a deleted application, are `unknown`.
 */
export async function useEmbedAppKey(db: Db, presented: string): Promise<EmbedKeyUse> {
  if (!presented.startsWith(EMBED_CREDENTIAL_PREFIXES.key)) return { ok: false, reason: "unknown" };
  const hash = await sha256Hex(presented);

  const [row] = await db
    .select({
      keyId: embedAppKeys.id,
      orgId: embedAppKeys.orgId,
      appId: embedAppKeys.appId,
      permissions: embedAppKeys.permissions,
      expiresAt: embedAppKeys.expiresAt,
    })
    .from(embedAppKeys)
    .innerJoin(embedApps, eq(embedApps.id, embedAppKeys.appId))
    .where(
      and(eq(embedAppKeys.hash, hash), isNull(embedAppKeys.revokedAt), isNull(embedApps.deletedAt)),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };

  if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
    return { ok: false, reason: "expired" };
  await db
    .update(embedAppKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(embedAppKeys.id, row.keyId));
  const { expiresAt: _, ...key } = row;

  return { ok: true, ...key };
}

/** Which application a key acts for: every query below is scoped by both. */
export interface EmbedScope {
  orgId: string;
  appId: string;
}

const tenantColumns = {
  id: embedTenants.id,
  externalId: embedTenants.externalId,
  monthlyRequests: embedTenants.monthlyRequests,
  activeTunnels: embedTenants.activeTunnels,
  disabledAt: embedTenants.disabledAt,
  createdAt: embedTenants.createdAt,
};

export async function findEmbedTenant(db: Db, scope: EmbedScope, externalId: string) {
  const [tenant] = await db
    .select(tenantColumns)
    .from(embedTenants)
    .where(
      and(
        eq(embedTenants.orgId, scope.orgId),
        eq(embedTenants.appId, scope.appId),
        eq(embedTenants.externalId, externalId),
      ),
    )
    .limit(1);

  return tenant;
}

/** What an integration may change on a tenant. Null limits fall back to the application's. */
export interface EmbedTenantChange {
  disabled?: boolean;
  monthlyRequests?: number | null;
  activeTunnels?: number | null;
}

/** The columns an `EmbedTenantChange` writes. */
type EmbedTenantUpdate = Partial<
  Pick<typeof embedTenants.$inferInsert, "disabledAt" | "monthlyRequests" | "activeTunnels">
>;

/** The tenant named `externalId`, made if new, with `change` applied. */
export async function putEmbedTenant(
  db: Db,
  scope: EmbedScope,
  externalId: string,
  change: EmbedTenantChange = {},
) {
  await db
    .insert(embedTenants)
    .values({ id: uuidv7(), ...scope, externalId })
    .onConflictDoNothing();
  const { disabled, ...limits } = change;

  const set: EmbedTenantUpdate = { ...limits };

  if (disabled !== undefined) set.disabledAt = disabled ? new Date() : null;

  if (Object.keys(set).length) {
    await db
      .update(embedTenants)
      .set(set)
      .where(
        and(
          eq(embedTenants.orgId, scope.orgId),
          eq(embedTenants.appId, scope.appId),
          eq(embedTenants.externalId, externalId),
        ),
      );
  }

  return (await findEmbedTenant(db, scope, externalId))!;
}

const subjectColumns = {
  id: embedSubjects.id,
  tenantId: embedSubjects.tenantId,
  externalId: embedSubjects.externalId,
  kind: embedSubjects.kind,
  disabledAt: embedSubjects.disabledAt,
  createdAt: embedSubjects.createdAt,
};

export async function findEmbedSubject(
  db: Db,
  scope: EmbedScope,
  tenantId: string,
  externalId: string,
) {
  const [subject] = await db
    .select(subjectColumns)
    .from(embedSubjects)
    .where(
      and(
        eq(embedSubjects.orgId, scope.orgId),
        eq(embedSubjects.appId, scope.appId),
        eq(embedSubjects.tenantId, tenantId),
        eq(embedSubjects.externalId, externalId),
      ),
    )
    .limit(1);

  return subject;
}

/**
 * The subject named `externalId` in the tenant, made if new. `conflict` when it exists with
 * another kind: a user never becomes a service, or back.
 */
export async function putEmbedSubject(
  db: Db,
  scope: EmbedScope,
  tenantId: string,
  externalId: string,
  input: { kind: SubjectKind; disabled?: boolean },
) {
  await db
    .insert(embedSubjects)
    .values({ id: uuidv7(), ...scope, tenantId, externalId, kind: input.kind })
    .onConflictDoNothing();
  const subject = (await findEmbedSubject(db, scope, tenantId, externalId))!;

  if (subject.kind !== input.kind) return { conflict: true as const };

  if (input.disabled !== undefined) {
    await db
      .update(embedSubjects)
      .set({ disabledAt: input.disabled ? new Date() : null })
      .where(eq(embedSubjects.id, subject.id));
  }

  return {
    conflict: false as const,
    subject: (await findEmbedSubject(db, scope, tenantId, externalId))!,
  };
}

/** Takes a subject off every tunnel's access list. */
export async function removeEmbedSubjectAccess(db: Db, orgId: string, subjectId: string) {
  await db
    .delete(embedTunnelAccess)
    .where(and(eq(embedTunnelAccess.orgId, orgId), eq(embedTunnelAccess.subjectId, subjectId)));
}

const tunnelColumns = {
  id: embedTunnels.id,
  name: embedTunnels.name,
  tenantId: embedTunnels.tenantId,
  tenant: embedTenants.externalId,
  ownerSubjectId: embedTunnels.ownerSubjectId,
  owner: embedSubjects.externalId,
  createdAt: embedTunnels.createdAt,
  stoppedAt: embedTunnels.stoppedAt,
};

/** Tunnels with their tenant's and owner's external ids. */
function selectTunnels(db: Db) {
  return db
    .select(tunnelColumns)
    .from(embedTunnels)
    .innerJoin(embedTenants, eq(embedTenants.id, embedTunnels.tenantId))
    .innerJoin(embedSubjects, eq(embedSubjects.id, embedTunnels.ownerSubjectId));
}

/** A tunnel's name: `e` + 15 characters, claimed for the org in `pipe_names` so no pipe takes it. */
async function claimTunnelName(db: Db, orgId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = randomEmbedTunnelName();

    const claimed = await db
      .insert(pipeNames)
      .values({ name, orgId })
      .onConflictDoNothing()
      .returning({ name: pipeNames.name });

    if (claimed[0]) return name;
  }

  throw new Error("could not draw an unused tunnel name");
}

/** A new connector (`whc_`) for a tunnel. The plaintext is returned once and never stored. */
export async function createEmbedConnector(
  db: Db,
  input: { orgId: string; tunnelId: string; expiresAt: Date },
) {
  const { value, hash } = await newEmbedCredential("connector");
  const id = uuidv7();
  await db.insert(embedConnectors).values({ id, hash, ...input });

  return { id, connector: value, expiresAt: input.expiresAt };
}

/**
 * A new tunnel for a tenant: its name claimed, its owner and `access` on its list, and its first
 * connector. Every subject must be of the tenant; the route checks that first.
 */
export async function createEmbedTunnel(
  db: Db,
  scope: EmbedScope,
  input: { tenantId: string; ownerSubjectId: string; access: string[]; connectorExpiresAt: Date },
) {
  const id = uuidv7();
  const name = await claimTunnelName(db, scope.orgId);
  await db.insert(embedTunnels).values({
    id,
    ...scope,
    tenantId: input.tenantId,
    ownerSubjectId: input.ownerSubjectId,
    name,
  });
  const subjects = [...new Set([input.ownerSubjectId, ...input.access])];
  await db
    .insert(embedTunnelAccess)
    .values(subjects.map((subjectId) => ({ tunnelId: id, subjectId, orgId: scope.orgId })));

  const connector = await createEmbedConnector(db, {
    orgId: scope.orgId,
    tunnelId: id,
    expiresAt: input.connectorExpiresAt,
  });

  return { tunnel: (await findEmbedTunnel(db, scope, id))!, connector };
}

/** A live (not deleted) tunnel of the application, or undefined. */
export async function findEmbedTunnel(db: Db, scope: EmbedScope, tunnelId: string) {
  const [tunnel] = await selectTunnels(db)
    .where(
      and(
        eq(embedTunnels.id, tunnelId),
        eq(embedTunnels.orgId, scope.orgId),
        eq(embedTunnels.appId, scope.appId),
        isNull(embedTunnels.deletedAt),
      ),
    )
    .limit(1);

  return tunnel;
}

/** Narrows an application's tunnels to one tenant's, or to those one of its subjects may be granted. */
export interface EmbedTunnelFilter {
  tenantId?: string;
  subjectId?: string;
}

/** The application's live tunnels, of one tenant, or that one subject may be granted. */
export async function listEmbedTunnels(db: Db, scope: EmbedScope, filter: EmbedTunnelFilter = {}) {
  const where = [
    eq(embedTunnels.orgId, scope.orgId),
    eq(embedTunnels.appId, scope.appId),
    isNull(embedTunnels.deletedAt),
  ];

  if (filter.tenantId) where.push(eq(embedTunnels.tenantId, filter.tenantId));

  if (filter.subjectId) {
    const reachable = db
      .select({ id: embedTunnelAccess.tunnelId })
      .from(embedTunnelAccess)
      .where(eq(embedTunnelAccess.subjectId, filter.subjectId));

    where.push(inArray(embedTunnels.id, reachable));
  }

  return selectTunnels(db)
    .where(and(...where))
    .orderBy(desc(embedTunnels.createdAt))
    .limit(500);
}

/** The application's live tunnels owned by `ownerSubjectId`, or of `tenantId`: what goes with it. */
export async function embedTunnelIdsOf(
  db: Db,
  scope: EmbedScope,
  of: { tenantId: string } | { ownerSubjectId: string },
) {
  const rows = await db
    .select({ id: embedTunnels.id })
    .from(embedTunnels)
    .where(
      and(
        eq(embedTunnels.orgId, scope.orgId),
        eq(embedTunnels.appId, scope.appId),
        isNull(embedTunnels.deletedAt),
        "tenantId" in of
          ? eq(embedTunnels.tenantId, of.tenantId)
          : eq(embedTunnels.ownerSubjectId, of.ownerSubjectId),
      ),
    );

  return rows.map((row) => row.id);
}

/** Subject ids on a tunnel's access list, with their external ids. */
export async function listEmbedTunnelAccess(db: Db, orgId: string, tunnelId: string) {
  return db
    .select({ id: embedSubjects.id, externalId: embedSubjects.externalId })
    .from(embedTunnelAccess)
    .innerJoin(embedSubjects, eq(embedSubjects.id, embedTunnelAccess.subjectId))
    .where(and(eq(embedTunnelAccess.orgId, orgId), eq(embedTunnelAccess.tunnelId, tunnelId)));
}

export async function addEmbedTunnelAccess(
  db: Db,
  orgId: string,
  tunnelId: string,
  subjectId: string,
) {
  await db.insert(embedTunnelAccess).values({ orgId, tunnelId, subjectId }).onConflictDoNothing();
}

/** Takes a subject off a tunnel's list. The owner stays: a tunnel always has one. */
export async function removeEmbedTunnelAccess(
  db: Db,
  orgId: string,
  tunnelId: string,
  subjectId: string,
) {
  const removed = await db
    .delete(embedTunnelAccess)
    .where(
      and(
        eq(embedTunnelAccess.orgId, orgId),
        eq(embedTunnelAccess.tunnelId, tunnelId),
        eq(embedTunnelAccess.subjectId, subjectId),
      ),
    )
    .returning({ subjectId: embedTunnelAccess.subjectId });

  return removed.length > 0;
}

/** Marks a tunnel stopped (`stopped`), or clears the mark when its connector opens it again. */
export async function setEmbedTunnelStopped(
  db: Db,
  orgId: string,
  tunnelId: string,
  stopped: boolean,
) {
  await db
    .update(embedTunnels)
    .set({ stoppedAt: stopped ? new Date() : null })
    .where(and(eq(embedTunnels.id, tunnelId), eq(embedTunnels.orgId, orgId)));
}

/** Deletes tunnels for good: marked deleted, their connectors revoked. Their names stay claimed. */
export async function deleteEmbedTunnels(db: Db, orgId: string, tunnelIds: string[]) {
  if (!tunnelIds.length) return;
  const now = new Date();
  await db
    .update(embedTunnels)
    .set({ deletedAt: now })
    .where(and(eq(embedTunnels.orgId, orgId), inArray(embedTunnels.id, tunnelIds)));
  await db
    .update(embedConnectors)
    .set({ revokedAt: now })
    .where(
      and(
        eq(embedConnectors.orgId, orgId),
        inArray(embedConnectors.tunnelId, tunnelIds),
        isNull(embedConnectors.revokedAt),
      ),
    );
}

/** The live tunnels of a deleted application, so their sessions can be ended. */
export async function embedTunnelIdsOfApp(db: Db, orgId: string, appId: string) {
  const rows = await db
    .select({ id: embedTunnels.id })
    .from(embedTunnels)
    .where(
      and(
        eq(embedTunnels.orgId, orgId),
        eq(embedTunnels.appId, appId),
        isNull(embedTunnels.deletedAt),
      ),
    );

  return rows.map((row) => row.id);
}

/** Revokes connectors of a tunnel: one by id, or all of them except `keep`. Returns how many. */
export async function revokeEmbedConnectors(
  db: Db,
  orgId: string,
  tunnelId: string,
  which: { id: string } | { except: string | null },
) {
  const revoked = await db
    .update(embedConnectors)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(embedConnectors.orgId, orgId),
        eq(embedConnectors.tunnelId, tunnelId),
        isNull(embedConnectors.revokedAt),
        "id" in which
          ? eq(embedConnectors.id, which.id)
          : which.except
            ? ne(embedConnectors.id, which.except)
            : undefined,
      ),
    )
    .returning({ id: embedConnectors.id });

  return revoked.length;
}

/** The open sessions of tunnels, to end or report on. */
export async function openSharesOfTunnels(db: Db, tunnelIds: string[]) {
  if (!tunnelIds.length) return [];

  return db
    .select({
      id: shares.id,
      orgId: shares.orgId,
      tunnelId: shares.tunnelId,
      connectorId: shares.connectorId,
    })
    .from(shares)
    .where(and(inArray(shares.tunnelId, tunnelIds), isNull(shares.endedAt)));
}

/** Each tunnel's newest session, open or ended, for its health. */
export async function latestSharesOfTunnels(db: Db, tunnelIds: string[]) {
  if (!tunnelIds.length) return new Map<string, LatestSession>();

  const rows = await db
    .select({
      id: shares.id,
      tunnelId: shares.tunnelId,
      startedAt: shares.startedAt,
      endedAt: shares.endedAt,
      endReason: shares.endReason,
      bytes: shares.bytes,
    })
    .from(shares)
    .where(inArray(shares.tunnelId, tunnelIds))
    .orderBy(desc(shares.startedAt));

  const latest = new Map<string, LatestSession>();

  for (const row of rows) if (!latest.has(row.tunnelId!)) latest.set(row.tunnelId!, row);

  return latest;
}

export interface LatestSession {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  bytes: number;
}

// --- What an agent (a `whc_` connector) may do: open its one tunnel ----------------------------

export type EmbedConnectorUse =
  | {
      ok: true;
      connectorId: string;
      orgId: string;
      appId: string;
      tenantId: string;
      tunnelId: string;
      name: string;
      stopped: boolean;
    }
  | { ok: false; reason: "unknown" | "expired" | "disabled" };

/**
 * The live connector `presented` is, for a live tunnel of a live application, with its tenant and
 * owner enabled; records its use. Revoked and unknown connectors, and ones whose tunnel or
 * application was deleted, are `unknown`; a disabled tenant or owner is `disabled`.
 */
export async function useEmbedConnector(db: Db, presented: string): Promise<EmbedConnectorUse> {
  if (!presented.startsWith(EMBED_CREDENTIAL_PREFIXES.connector)) {
    return { ok: false, reason: "unknown" };
  }

  const hash = await sha256Hex(presented);

  const [row] = await db
    .select({
      connectorId: embedConnectors.id,
      orgId: embedConnectors.orgId,
      expiresAt: embedConnectors.expiresAt,
      appId: embedTunnels.appId,
      tenantId: embedTunnels.tenantId,
      tunnelId: embedTunnels.id,
      name: embedTunnels.name,
      stoppedAt: embedTunnels.stoppedAt,
      tenantDisabledAt: embedTenants.disabledAt,
      ownerDisabledAt: embedSubjects.disabledAt,
    })
    .from(embedConnectors)
    .innerJoin(embedTunnels, eq(embedTunnels.id, embedConnectors.tunnelId))
    .innerJoin(embedApps, eq(embedApps.id, embedTunnels.appId))
    .innerJoin(embedTenants, eq(embedTenants.id, embedTunnels.tenantId))
    .innerJoin(embedSubjects, eq(embedSubjects.id, embedTunnels.ownerSubjectId))
    .where(
      and(
        eq(embedConnectors.hash, hash),
        isNull(embedConnectors.revokedAt),
        isNull(embedTunnels.deletedAt),
        isNull(embedApps.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };

  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  if (row.tenantDisabledAt || row.ownerDisabledAt) return { ok: false, reason: "disabled" };
  await db
    .update(embedConnectors)
    .set({ lastUsedAt: new Date() })
    .where(eq(embedConnectors.id, row.connectorId));

  return {
    ok: true,
    connectorId: row.connectorId,
    orgId: row.orgId,
    appId: row.appId,
    tenantId: row.tenantId,
    tunnelId: row.tunnelId,
    name: row.name,
    stopped: row.stoppedAt !== null,
  };
}

// --- Grants: one subject's traffic to one tunnel ---------------------------------------------

/**
 * A new grant for a subject on a tunnel's list, logged. A `client` grant returns its token
 * (`whg_`); a `browser` grant returns a one-time launch code instead. Plaintexts are returned
 * once and never stored. The route checks the subject is on the list first.
 */
export async function issueEmbedGrant(
  db: Db,
  scope: EmbedScope,
  input: {
    tenantId: string;
    tunnelId: string;
    subjectId: string;
    keyId: string;
    kind: GrantKind;
    expiresAt: Date;
  },
) {
  const id = uuidv7();
  const token = input.kind === "client" ? await newEmbedCredential("grant") : null;
  await db.insert(embedGrants).values({ id, ...scope, ...input, hash: token?.hash ?? null });
  await db.insert(embedGrantEvents).values({
    id: uuidv7(),
    orgId: scope.orgId,
    grantId: id,
    tunnelId: input.tunnelId,
    subjectId: input.subjectId,
    keyId: input.keyId,
    event: "issued",
  });
  let launchCode: string | null = null;

  if (input.kind === "browser") {
    launchCode = randomSecret(32);
    await db.insert(embedLaunchCodes).values({
      hash: await sha256Hex(launchCode),
      orgId: scope.orgId,
      grantId: id,
      expiresAt: new Date(Date.now() + LAUNCH_CODE_TTL_SECONDS * 1000),
    });
  }

  return { id, token: token?.value ?? null, launchCode, expiresAt: input.expiresAt };
}

/** Swaps a launch code for its grant's id, once; null when unknown, used or expired. */
export async function takeEmbedLaunchCode(db: Db, code: string) {
  const [taken] = await db
    .delete(embedLaunchCodes)
    .where(eq(embedLaunchCodes.hash, await sha256Hex(code)))
    .returning({ grantId: embedLaunchCodes.grantId, expiresAt: embedLaunchCodes.expiresAt });

  return taken && taken.expiresAt.getTime() > Date.now() ? taken.grantId : null;
}

/**
 * A grant that still opens its tunnel, by id (a browser's cookie) or by its token's hash (a
 * program): unrevoked and unexpired, its subject and tenant enabled, its subject still on the
 * tunnel's list, its tunnel and application not deleted. Undefined otherwise. Carries the
 * application's allowed origins, for a browser WebSocket's subprotocol grant.
 */
export async function findLiveEmbedGrant(db: Db, by: { id: string } | { token: string }) {
  const match: SQL =
    "id" in by ? eq(embedGrants.id, by.id) : eq(embedGrants.hash, await sha256Hex(by.token));

  const [grant] = await db
    .select({
      id: embedGrants.id,
      orgId: embedGrants.orgId,
      tunnelId: embedGrants.tunnelId,
      subjectId: embedGrants.subjectId,
      kind: embedGrants.kind,
      expiresAt: embedGrants.expiresAt,
      allowedOrigins: embedApps.allowedOrigins,
    })
    .from(embedGrants)
    .innerJoin(embedSubjects, eq(embedSubjects.id, embedGrants.subjectId))
    .innerJoin(embedTenants, eq(embedTenants.id, embedGrants.tenantId))
    .innerJoin(embedTunnels, eq(embedTunnels.id, embedGrants.tunnelId))
    .innerJoin(embedApps, eq(embedApps.id, embedGrants.appId))
    .where(
      and(
        match,
        isNull(embedGrants.revokedAt),
        gt(embedGrants.expiresAt, new Date()),
        isNull(embedSubjects.disabledAt),
        isNull(embedTenants.disabledAt),
        isNull(embedTunnels.deletedAt),
        isNull(embedApps.deletedAt),
        exists(
          db
            .select({ one: embedTunnelAccess.tunnelId })
            .from(embedTunnelAccess)
            .where(
              and(
                eq(embedTunnelAccess.tunnelId, embedGrants.tunnelId),
                eq(embedTunnelAccess.subjectId, embedGrants.subjectId),
              ),
            ),
        ),
      ),
    )
    .limit(1);

  return grant;
}

/** Which grants to revoke: one of an application, or every grant of tunnels or of a subject. */
export type GrantRevocation =
  | { appId: string; grantId: string }
  | { tunnelIds: string[] }
  | { subjectId: string; tunnelId?: string };

/** Revokes live grants and logs it. Returns each revoked grant with its tunnel. */
export async function revokeEmbedGrants(
  db: Db,
  orgId: string,
  which: GrantRevocation,
  keyId: string | null = null,
) {
  if ("tunnelIds" in which && !which.tunnelIds.length) return [];

  const scoped =
    "grantId" in which
      ? and(eq(embedGrants.id, which.grantId), eq(embedGrants.appId, which.appId))
      : "tunnelIds" in which
        ? inArray(embedGrants.tunnelId, which.tunnelIds)
        : and(
            eq(embedGrants.subjectId, which.subjectId),
            which.tunnelId ? eq(embedGrants.tunnelId, which.tunnelId) : undefined,
          );

  const revoked = await db
    .update(embedGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(embedGrants.orgId, orgId), isNull(embedGrants.revokedAt), scoped))
    .returning({
      id: embedGrants.id,
      tunnelId: embedGrants.tunnelId,
      subjectId: embedGrants.subjectId,
    });

  if (revoked.length) {
    await db.insert(embedGrantEvents).values(
      revoked.map((grant) => ({
        id: uuidv7(),
        orgId,
        grantId: grant.id,
        tunnelId: grant.tunnelId,
        subjectId: grant.subjectId,
        keyId,
        event: "revoked" as const,
      })),
    );
  }

  return revoked;
}

/** A tunnel's grant log, newest first, with the subject's external id. */
export async function listEmbedGrantEvents(db: Db, orgId: string, tunnelId: string) {
  return db
    .select({
      grantId: embedGrantEvents.grantId,
      event: embedGrantEvents.event,
      at: embedGrantEvents.at,
      subject: embedSubjects.externalId,
      keyId: embedGrantEvents.keyId,
      expiresAt: embedGrants.expiresAt,
    })
    .from(embedGrantEvents)
    .innerJoin(embedSubjects, eq(embedSubjects.id, embedGrantEvents.subjectId))
    .innerJoin(embedGrants, eq(embedGrants.id, embedGrantEvents.grantId))
    .where(and(eq(embedGrantEvents.orgId, orgId), eq(embedGrantEvents.tunnelId, tunnelId)))
    .orderBy(desc(embedGrantEvents.at))
    .limit(500);
}

/** An application's launch URL, where a browser without a grant is sent; null when unset. */
export async function embedAppLaunchUrl(db: Db, appId: string) {
  const [app] = await db
    .select({ launchUrl: embedApps.launchUrl })
    .from(embedApps)
    .where(and(eq(embedApps.id, appId), isNull(embedApps.deletedAt)))
    .limit(1);

  return app?.launchUrl ?? null;
}

/** An application's limits and a tenant's own, as set; null: unset (ADR 0032). */
export async function embedLimitsOf(db: Db, appId: string, tenantId: string) {
  const [row] = await db
    .select({
      appMonthlyRequests: embedApps.monthlyRequests,
      appActiveTunnels: embedApps.activeTunnels,
      tenantMonthlyRequests: embedApps.tenantMonthlyRequests,
      tenantActiveTunnels: embedApps.tenantActiveTunnels,
      ownMonthlyRequests: embedTenants.monthlyRequests,
      ownActiveTunnels: embedTenants.activeTunnels,
    })
    .from(embedTenants)
    .innerJoin(embedApps, eq(embedApps.id, embedTenants.appId))
    .where(and(eq(embedTenants.id, tenantId), eq(embedTenants.appId, appId)))
    .limit(1);

  return row;
}
