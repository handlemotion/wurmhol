// Custom domains (ADR 0033): the rows, and the few questions the Worker asks of them.
import type { DomainErrorCode, DomainState } from "@wurmhol/protocol";
import { and, asc, count, eq, inArray, isNotNull, lte, ne, notExists } from "drizzle-orm";
import type { Db } from "./client.ts";
import { customDomains, pipeNames, shares } from "./schema/index.ts";

export type DomainRow = typeof customDomains.$inferSelect;

/**
 * One claim on a hostname: the hostname and the random challenge it was added with. A domain
 * removed and added again, by any org, is a new claim, so a write for the old one finds nothing.
 */
export type DomainClaim = Pick<DomainRow, "hostname" | "challenge">;

const isClaim = (claim: DomainClaim) =>
  and(eq(customDomains.hostname, claim.hostname), eq(customDomains.challenge, claim.challenge));

/**
 * Adds `hostname` for `orgId`, attached to `pipeName`, which the org keeps for itself (ADR 0009:
 * the first org to use a name keeps it). The same org adding the same hostname for the same name
 * again gets the existing row back. `hostname_taken`: another org, or another of this org's names,
 * has it. `pipe_taken`: the name belongs to another org. `domain_limit`: the org already has
 * `limit` domains, counted after the row is written so that concurrent adds cannot both pass.
 *
 * A pipe name this call claimed is released again when it adds nothing, so a refused add never
 * keeps a name. `nameClaimed` says whether it claimed one, for a caller that undoes the add later.
 */
export async function addDomain(
  db: Db,
  input: {
    orgId: string;
    hostname: string;
    pipeName: string;
    challenge: string;
    expiresAt: Date;
    limit: number;
  },
): Promise<
  | { ok: true; domain: DomainRow; created: boolean; nameClaimed: boolean }
  | { ok: false; reason: "hostname_taken" | "pipe_taken" | "domain_limit" }
> {
  const { limit, ...values } = input;
  const mine = (row: DomainRow | null) =>
    row !== null && row.orgId === input.orgId && row.pipeName === input.pipeName;
  const before = await findDomain(db, input.hostname);
  if (mine(before)) return { ok: true, domain: before!, created: false, nameClaimed: false };
  if (before) return { ok: false, reason: "hostname_taken" };

  const claimed = await db
    .insert(pipeNames)
    .values({ name: input.pipeName, orgId: input.orgId })
    .onConflictDoNothing()
    .returning({ name: pipeNames.name });
  const nameClaimed = claimed.length > 0;
  const [owner] = await db
    .select({ orgId: pipeNames.orgId })
    .from(pipeNames)
    .where(eq(pipeNames.name, input.pipeName));
  if (owner?.orgId !== input.orgId) return { ok: false, reason: "pipe_taken" };
  const [inserted] = await db
    .insert(customDomains)
    .values({ ...values, state: "pending" })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    if (nameClaimed) await releasePipeName(db, input.orgId, input.pipeName);
    const existing = await findDomain(db, input.hostname);
    if (mine(existing)) return { ok: true, domain: existing!, created: false, nameClaimed: false };
    return { ok: false, reason: "hostname_taken" };
  }
  if ((await countDomains(db, input.orgId)) > limit) {
    await deleteDomain(db, inserted);
    if (nameClaimed) await releasePipeName(db, input.orgId, input.pipeName);
    return { ok: false, reason: "domain_limit" };
  }
  return { ok: true, domain: inserted, created: true, nameClaimed };
}

/**
 * Gives back a pipe name the org claimed only for a domain, when no domain of it is left. A name
 * a pipe has used stays the org's like any other (one of the org's shares records it, so it is kept).
 */
export async function releasePipeName(db: Db, orgId: string, name: string) {
  await db.delete(pipeNames).where(
    and(
      eq(pipeNames.name, name),
      eq(pipeNames.orgId, orgId),
      notExists(
        db
          .select({ one: customDomains.hostname })
          .from(customDomains)
          .where(eq(customDomains.pipeName, name)),
      ),
      notExists(
        db
          .select({ one: shares.id })
          .from(shares)
          .where(and(eq(shares.orgId, orgId), eq(shares.name, name))),
      ),
    ),
  );
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

/**
 * Writes what changed about one claim; returns the row, or null when that claim is gone (removed,
 * or removed and added again), so a check that started before never writes onto a newer claim.
 */
export async function updateDomain(
  db: Db,
  claim: DomainClaim,
  patch: Partial<Omit<DomainRow, "hostname" | "orgId" | "pipeName" | "createdAt" | "challenge">>,
) {
  const [row] = await db.update(customDomains).set(patch).where(isClaim(claim)).returning();
  return row ?? null;
}

/** Deletes one claim. A newer claim on the same hostname is left alone. */
export async function deleteDomain(db: Db, claim: DomainClaim) {
  await db.delete(customDomains).where(isClaim(claim));
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
