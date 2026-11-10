// Custom domains (ADR 0030): the rows, and the few questions the Worker asks of them.
import type { DomainErrorCode, DomainState } from "@wurmhol/protocol";
import { and, asc, count, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import type { Db } from "./client.ts";
import { customDomains, pipeNames } from "./schema/index.ts";

export type DomainRow = typeof customDomains.$inferSelect;

/**
 * Adds `hostname` for `orgId`, attached to `pipeName`, which the org keeps for itself (ADR 0009:
 * the first org to use a name keeps it). The same org adding the same hostname for the same name
 * again gets the existing row back. `hostname_taken`: another org, or another of this org's names,
 * has it. `pipe_taken`: the name belongs to another org.
 */
export async function addDomain(
  db: Db,
  input: {
    orgId: string;
    hostname: string;
    pipeName: string;
    challenge: string;
    expiresAt: Date;
  },
): Promise<
  | { ok: true; domain: DomainRow; created: boolean }
  | { ok: false; reason: "hostname_taken" | "pipe_taken" }
> {
  await db
    .insert(pipeNames)
    .values({ name: input.pipeName, orgId: input.orgId })
    .onConflictDoNothing();
  const [owner] = await db
    .select({ orgId: pipeNames.orgId })
    .from(pipeNames)
    .where(eq(pipeNames.name, input.pipeName));
  if (owner?.orgId !== input.orgId) return { ok: false, reason: "pipe_taken" };
  const [inserted] = await db
    .insert(customDomains)
    .values({ ...input, state: "pending" })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { ok: true, domain: inserted, created: true };
  const existing = await findDomain(db, input.hostname);
  if (existing && existing.orgId === input.orgId && existing.pipeName === input.pipeName) {
    return { ok: true, domain: existing, created: false };
  }
  return { ok: false, reason: "hostname_taken" };
}

export async function findDomain(db: Db, hostname: string) {
  const [row] = await db.select().from(customDomains).where(eq(customDomains.hostname, hostname));
  return row ?? null;
}

/** The org's domains, oldest first. */
export async function listDomains(db: Db, orgId: string) {
  return db
    .select()
    .from(customDomains)
    .where(eq(customDomains.orgId, orgId))
    .orderBy(asc(customDomains.createdAt), asc(customDomains.hostname));
}

export async function countDomains(db: Db, orgId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(customDomains)
    .where(eq(customDomains.orgId, orgId));
  return row?.n ?? 0;
}

/** Writes what changed about a domain; returns the row, or null when it is gone. */
export async function updateDomain(
  db: Db,
  hostname: string,
  patch: Partial<Omit<DomainRow, "hostname" | "orgId" | "pipeName" | "createdAt" | "challenge">>,
) {
  const [row] = await db
    .update(customDomains)
    .set(patch)
    .where(eq(customDomains.hostname, hostname))
    .returning();
  return row ?? null;
}

export async function deleteDomain(db: Db, hostname: string) {
  await db.delete(customDomains).where(eq(customDomains.hostname, hostname));
}

/** The name an active domain routes to, for a request to its host. Null for any other state. */
export async function findActiveDomain(db: Db, hostname: string) {
  const [row] = await db
    .select({ orgId: customDomains.orgId, pipeName: customDomains.pipeName })
    .from(customDomains)
    .where(and(eq(customDomains.hostname, hostname), eq(customDomains.state, "active")));
  return row ?? null;
}

/** A name's URL host: its oldest active domain, or null. */
export async function primaryDomain(db: Db, pipeName: string) {
  const [row] = await db
    .select({ hostname: customDomains.hostname })
    .from(customDomains)
    .where(
      and(
        eq(customDomains.pipeName, pipeName),
        eq(customDomains.state, "active"),
        isNotNull(customDomains.activatedAt),
      ),
    )
    .orderBy(asc(customDomains.activatedAt), asc(customDomains.hostname))
    .limit(1);
  return row?.hostname ?? null;
}

/** Whether `hostname` is an active domain of this org and name. */
export async function isActiveDomainOf(
  db: Db,
  input: { hostname: string; orgId: string; pipeName: string },
) {
  const domain = await findActiveDomain(db, input.hostname);
  return domain?.orgId === input.orgId && domain.pipeName === input.pipeName;
}

/**
 * The domains the daily job looks at: those not `failed`, least recently checked first, at most
 * `limit`. A `pending` one past its expiry is included whatever its check time.
 */
export async function domainsToCheck(db: Db, limit: number) {
  return db
    .select()
    .from(customDomains)
    .where(ne(customDomains.state, "failed"))
    .orderBy(asc(customDomains.checkedAt), asc(customDomains.createdAt))
    .limit(limit);
}

/** Domains whose expiry has passed while still unverified. */
export async function expiredDomains(db: Db, now: Date) {
  return db
    .select()
    .from(customDomains)
    .where(
      and(
        inArray(customDomains.state, ["pending"] satisfies DomainState[]),
        lte(customDomains.expiresAt, now),
      ),
    );
}

export type { DomainErrorCode };
