// Whether an org may start shares (spec section 4): billing off, inside its trial, or a
// subscription in good standing.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { organizations, subscriptions } from "./schema/index.ts";

/** Stripe statuses in which the org has paid (or is in Stripe's own trial). */
export const PAID_STATUSES = ["active", "trialing", "past_due"] as const;

export type Standing =
  | { ok: true; reason: "billing_off" | "trial" | "subscribed"; trialEndsAt?: Date }
  | { ok: false; reason: "no_subscription"; trialEndedAt: Date };

export async function orgStanding(
  db: Db,
  orgId: string,
  billing: { enabled: boolean; trialDays: number },
): Promise<Standing> {
  if (!billing.enabled) return { ok: true, reason: "billing_off" };
  const [paid] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, [...PAID_STATUSES])))
    .limit(1);
  if (paid) return { ok: true, reason: "subscribed" };
  const [org] = await db
    .select({ createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const trialEnd = new Date((org?.createdAt.getTime() ?? 0) + billing.trialDays * 86_400_000);
  if (trialEnd.getTime() > Date.now()) return { ok: true, reason: "trial", trialEndsAt: trialEnd };
  return { ok: false, reason: "no_subscription", trialEndedAt: trialEnd };
}

/** The org's subscription row, if any, for the Billing menu item. */
export async function orgSubscription(db: Db, orgId: string) {
  const [row] = await db
    .select({ status: subscriptions.status, periodEnd: subscriptions.periodEnd })
    .from(subscriptions)
    .where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, [...PAID_STATUSES])))
    .limit(1);
  return row ?? null;
}
