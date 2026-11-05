// Orgs, members and invite links. Every query names its org; callers check the caller's
// membership first.
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { randomSecret, sha256Hex } from "./crypto.ts";
import { inviteLinks, members, orgBlocks, organizations, users } from "./schema/index.ts";

/** Self-serve sign-up's personal org, owned by the new user (spec section 3). */
export async function createPersonalOrg(db: Db, input: { userId: string; name: string }) {
  const orgId = uuidv7();
  const now = new Date();
  await db.batch([
    db.insert(organizations).values({
      id: orgId,
      name: input.name,
      slug: `personal-${orgId}`,
      createdAt: now,
    }),
    db.insert(members).values({
      id: uuidv7(),
      organizationId: orgId,
      userId: input.userId,
      role: "owner",
      createdAt: now,
    }),
  ]);
  return orgId;
}

export interface Membership {
  /** `members.id` */
  id: string;
  orgId: string;
  userId: string;
  role: string;
}

/** `userId`'s membership in `orgId` (without one, their oldest membership), or null. */
export async function findMember(
  db: Db,
  userId: string,
  orgId?: string,
): Promise<Membership | null> {
  const [member] = await db
    .select({
      id: members.id,
      orgId: members.organizationId,
      userId: members.userId,
      role: members.role,
    })
    .from(members)
    .where(and(eq(members.userId, userId), orgId ? eq(members.organizationId, orgId) : undefined))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return member ?? null;
}

/**
 * `userId`'s orgs, oldest membership first. `personal` marks an org made at sign-up
 * (`createPersonalOrg`), which the switcher shows with its owner's picture.
 */
export async function listOrgsForUser(db: Db, userId: string) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      role: members.role,
      personal: sql<boolean>`${organizations.slug} like 'personal-%'`.mapWith(Boolean),
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt));
}

export async function listMembers(db: Db, orgId: string) {
  return db
    .select({
      id: members.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      role: members.role,
      joinedAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.organizationId, orgId))
    .orderBy(asc(members.createdAt));
}

/**
 * Removes a member. Refuses to remove the last owner, so an org always has someone who can
 * manage it. Returns what happened.
 */
export async function removeMember(db: Db, orgId: string, memberId: string) {
  const all = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.organizationId, orgId));
  const target = all.find((m) => m.id === memberId);
  if (!target) return "not_found" as const;
  if (target.role === "owner" && all.filter((m) => m.role === "owner").length === 1) {
    return "last_owner" as const;
  }
  await db.delete(members).where(and(eq(members.id, memberId), eq(members.organizationId, orgId)));
  return "removed" as const;
}

/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A new single-use invite link's code. Only its hash is stored. */
export async function createInvite(db: Db, input: { orgId: string; createdBy: string }) {
  const code = randomSecret(24);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.insert(inviteLinks).values({
    id: uuidv7(),
    orgId: input.orgId,
    hash: await sha256Hex(code),
    createdBy: input.createdBy,
    expiresAt,
  });
  return { code, expiresAt };
}

/** The invite link with this code's hash, while it is unused and unexpired. */
function liveInvite(hash: string) {
  return and(
    eq(inviteLinks.hash, hash),
    isNull(inviteLinks.usedAt),
    gt(inviteLinks.expiresAt, new Date()),
  );
}

/** The org an unused, unexpired invite code is for (with its name), or null. Does not use it. */
export async function peekInvite(db: Db, code: string) {
  return findLiveInvite(db, await sha256Hex(code));
}

async function findLiveInvite(db: Db, hash: string) {
  const [invite] = await db
    .select({ orgId: inviteLinks.orgId, orgName: organizations.name })
    .from(inviteLinks)
    .innerJoin(organizations, eq(organizations.id, inviteLinks.orgId))
    .where(liveInvite(hash))
    .limit(1);
  return invite ?? null;
}

/**
 * Joins `userId` to the invite's org as a member and uses the link up. Single use holds under
 * races: the conditional update claims the link, and only the request that claimed it adds the
 * member. Someone already in the org keeps their role, and the link stays unused.
 */
export async function acceptInvite(db: Db, code: string, userId: string) {
  const hash = await sha256Hex(code);
  const invite = await findLiveInvite(db, hash);
  if (!invite) return { status: "invalid" as const };
  if (await findMember(db, userId, invite.orgId)) {
    return { status: "already_member" as const, orgId: invite.orgId };
  }
  const claimed = await db
    .update(inviteLinks)
    .set({ usedAt: new Date(), usedBy: userId })
    .where(liveInvite(hash))
    .returning({ orgId: inviteLinks.orgId });
  if (!claimed.length) return { status: "invalid" as const };
  await db.insert(members).values({
    id: uuidv7(),
    organizationId: invite.orgId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  return { status: "joined" as const, orgId: invite.orgId };
}

/**
 * The members of `orgId` with these emails (case-insensitive), and the emails that matched no
 * member. Per-pipe access (ADR 0008) names viewers by email.
 */
export async function findMembersByEmail(db: Db, orgId: string, emails: string[]) {
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  if (!wanted.length) return { members: [], unknown: [] };
  const rows = await db
    .select({ userId: users.id, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), inArray(sql`lower(${users.email})`, wanted)));
  const found = new Set(rows.map((row) => row.email.toLowerCase()));
  return { members: rows, unknown: wanted.filter((email) => !found.has(email)) };
}

/** Blocks `orgId` for abuse (ADR 0022). Blocking it again keeps the first note. */
export async function blockOrg(db: Db, orgId: string, reason: string | null) {
  await db.insert(orgBlocks).values({ orgId, reason }).onConflictDoNothing();
}

/** Whether an operator blocked `orgId` (ADR 0022). */
export async function isOrgBlocked(db: Db, orgId: string) {
  const [row] = await db
    .select({ orgId: orgBlocks.orgId })
    .from(orgBlocks)
    .where(eq(orgBlocks.orgId, orgId))
    .limit(1);
  return row !== undefined;
}
