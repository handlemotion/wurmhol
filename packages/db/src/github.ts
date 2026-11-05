// GitHub App installations linked to orgs, and the open pipes a pull request matches (ADR 0013).
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.ts";
import { githubInstallations, shares } from "./schema/index.ts";

/** Links an installation to an org; linking it again updates the account's spelling. */
export async function linkInstallation(
  db: Db,
  input: { orgId: string; installationId: number; account: string; linkedBy: string },
) {
  await db
    .insert(githubInstallations)
    .values(input)
    .onConflictDoUpdate({
      target: [githubInstallations.orgId, githubInstallations.installationId],
      set: { account: input.account },
    });
}

export async function orgInstallations(db: Db, orgId: string) {
  return db
    .select({
      installationId: githubInstallations.installationId,
      account: githubInstallations.account,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId));
}

/** Forgets an installation for every org: GitHub says it was uninstalled. */
export async function unlinkInstallation(db: Db, installationId: number) {
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

/**
 * Open pipes on `repoHost`/`repo` at `branch` whose org linked `installationId`. Repo names
 * compare without case, as GitHub's do.
 */
export async function openSharesForBranch(
  db: Db,
  input: { installationId: number; repoHost: string; repo: string; branch: string },
) {
  const rows = await db
    .select({ id: shares.id, orgId: shares.orgId, repo: shares.repo })
    .from(shares)
    .innerJoin(
      githubInstallations,
      and(
        eq(githubInstallations.orgId, shares.orgId),
        eq(githubInstallations.installationId, input.installationId),
      ),
    )
    .where(
      and(
        eq(shares.branch, input.branch),
        eq(shares.repoHost, input.repoHost),
        isNull(shares.endedAt),
      ),
    );
  return rows.filter((row) => row.repo?.toLowerCase() === input.repo.toLowerCase());
}
