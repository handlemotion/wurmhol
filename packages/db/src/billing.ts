// Whether an org may start pipes (ADR 0026): billing off, or a subscription in good standing,
// trial included. The subscription's `plan` says which plan's limits apply.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { subscriptions } from "./schema/index.ts";

/** Stripe statuses in which the org may use its plan. `past_due` works while Stripe retries. */
export const PAID_STATUSES = ["active", "trialing", "past_due"] as const;

export type Standing =
  | { ok: true; reason: "billing_off" }
  | { ok: true; reason: "subscribed"; plan: string }
  | { ok: false; reason: "no_subscription" };

export async function orgStanding(
  db: Db,
  orgId: string,
  billing: { enabled: boolean },
): Promise<Standing> {
  if (!billing.enabled) return { ok: true, reason: "billing_off" };
  const subscription = await orgSubscription(db, orgId);
  return subscription
    ? { ok: true, reason: "subscribed", plan: subscription.plan }
    : { ok: false, reason: "no_subscription" };
}

/** The org's subscription in good standing, if any. */
export async function orgSubscription(db: Db, orgId: string) {
  const [row] = await db
    .select({
      plan: subscriptions.plan,
      status: subscriptions.status,
      periodEnd: subscriptions.periodEnd,
      trialEnd: subscriptions.trialEnd,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, [...PAID_STATUSES])))
    .limit(1);
  return row ?? null;
}
