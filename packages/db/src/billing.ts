// Whether an org may start pipes (ADR 0004): billing off, or a subscription in good standing.
// There is no trial: an org buys the plan before its first pipe.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { subscriptions } from "./schema/index.ts";

/** Stripe statuses in which the org has paid. `past_due` keeps working while Stripe retries. */
export const PAID_STATUSES = ["active", "trialing", "past_due"] as const;

export type Standing =
  | { ok: true; reason: "billing_off" | "subscribed" }
  | { ok: false; reason: "no_subscription" };

export async function orgStanding(
  db: Db,
  orgId: string,
  billing: { enabled: boolean },
): Promise<Standing> {
  if (!billing.enabled) return { ok: true, reason: "billing_off" };
  return (await orgSubscription(db, orgId))
    ? { ok: true, reason: "subscribed" }
    : { ok: false, reason: "no_subscription" };
}

/** The org's subscription in good standing, if any. */
export async function orgSubscription(db: Db, orgId: string) {
  const [row] = await db
    .select({ status: subscriptions.status, periodEnd: subscriptions.periodEnd })
    .from(subscriptions)
    .where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, [...PAID_STATUSES])))
    .limit(1);
  return row ?? null;
}
