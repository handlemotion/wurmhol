// Embedded mode's applications and integration keys (ADR 0032), as the console manages them.
// Every query is scoped by `org_id`: an application of another org does not exist here.
import type { EmbedPermission } from "@wurmhol/protocol";
import { and, desc, eq, isNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { newEmbedCredential } from "./crypto.ts";
import { embedAppKeys, embedApps, users } from "./schema/index.ts";

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
