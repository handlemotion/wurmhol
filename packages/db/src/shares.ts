// Share history. The live state of an open share is its Durable Object; these rows record that
// a share existed (ids are never reused) and how it ended.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { randomShareId } from "./crypto.ts";
import { pipeNames, shares, shareViews, users } from "./schema/index.ts";

/** Where a pipe came from (ADR 0012): `@wurmhol/protocol`'s `PipeSource`, already checked. */
export interface ShareSource {
  repoHost: string | null;
  repo: string | null;
  branch: string | null;
  commit: string | null;
  link: string | null;
  note: string | null;
  agent: string | null;
  agentUrl: string | null;
}

/**
 * Records a new share under a fresh id. The primary key makes an id unique forever; on the
 * astronomically rare collision, another id is drawn.
 *
 * A named share (ADR 0009) first claims its name for the org: `taken` when another org holds
 * it, `open` when the org already has an open pipe by that name.
 */
export async function recordShareStart(
  db: Db,
  input: {
    orgId: string;
    tokenId: string;
    startedBy: string | null;
    port: number;
    name?: string | null;
    /** Where the pipe came from (ADR 0012), already checked with `parsePipeSource`. */
    source?: ShareSource | null;
  },
): Promise<
  { ok: true; id: string; startedAt: Date } | { ok: false; reason: "taken" | "open"; port?: number }
> {
  const name = input.name ?? null;
  const { source, ...share } = input;
  const columns = source
    ? {
        repoHost: source.repoHost,
        repo: source.repo,
        branch: source.branch,
        commitSha: source.commit,
        link: source.link,
        note: source.note,
        agent: source.agent,
        agentUrl: source.agentUrl,
      }
    : {};
  if (name) {
    await db.insert(pipeNames).values({ name, orgId: input.orgId }).onConflictDoNothing();
    const [owner] = await db
      .select({ orgId: pipeNames.orgId })
      .from(pipeNames)
      .where(eq(pipeNames.name, name));
    if (owner?.orgId !== input.orgId) return { ok: false, reason: "taken" };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomShareId();
    const inserted = await db
      .insert(shares)
      .values({ id, ...share, ...columns, name })
      .onConflictDoNothing()
      .returning({ id: shares.id, startedAt: shares.startedAt });
    if (inserted[0]) return { ok: true, ...inserted[0] };
    // The other conflict a named share can hit: its name's open pipe.
    const open = name ? await findOpenShareByName(db, name) : null;
    if (open) return { ok: false, reason: "open", port: open.port };
  }
  throw new Error("could not draw an unused share id");
}

/** The open share a name points at, or null. */
export async function findOpenShareByName(db: Db, name: string) {
  const [row] = await db
    .select({ id: shares.id, port: shares.port })
    .from(shares)
    .where(and(eq(shares.name, name), isNull(shares.endedAt)))
    .limit(1);
  return row ?? null;
}

/** Marks a share ended, once: a second call (a retried alarm) changes nothing. */
export async function recordShareEnd(db: Db, input: { id: string; reason: string; bytes: number }) {
  await db
    .update(shares)
    .set({ endedAt: new Date(), endReason: input.reason, bytes: input.bytes })
    .where(and(eq(shares.id, input.id), isNull(shares.endedAt)));
}

/** One share with its starter's name, or null. */
export async function findShare(db: Db, id: string) {
  const [row] = await db
    .select({
      id: shares.id,
      orgId: shares.orgId,
      tokenId: shares.tokenId,
      port: shares.port,
      name: shares.name,
      startedAt: shares.startedAt,
      endedAt: shares.endedAt,
      endReason: shares.endReason,
      startedBy: users.name,
    })
    .from(shares)
    .leftJoin(users, eq(users.id, shares.startedBy))
    .where(eq(shares.id, id))
    .limit(1);
  return row ?? null;
}

/** Open shares started with `tokenId`: ended when the token is revoked. */
export async function openSharesOfToken(db: Db, tokenId: string) {
  return db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.tokenId, tokenId), isNull(shares.endedAt)));
}

export interface ShareView {
  userId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  requests: number;
}

/** Writes a share's view log: one row per viewer, replaced with the Share DO's latest counts. */
export async function recordShareViews(
  db: Db,
  share: { id: string; orgId: string },
  views: ShareView[],
) {
  if (!views.length) return;
  await db
    .insert(shareViews)
    .values(
      views.map((view) => ({
        shareId: share.id,
        orgId: share.orgId,
        userId: view.userId,
        firstSeenAt: new Date(view.firstSeenAt),
        lastSeenAt: new Date(view.lastSeenAt),
        requests: view.requests,
      })),
    )
    .onConflictDoUpdate({
      target: [shareViews.shareId, shareViews.userId],
      set: {
        lastSeenAt: sql`excluded.last_seen_at`,
        requests: sql`excluded.requests`,
      },
    });
}
