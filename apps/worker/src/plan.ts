// An org's limits (ADR 0027): its plan's with billing on, the `LIMIT_*` variables with billing off.
// Business has no fixed request limit: its owner's spend cap sets it, and its requests are
// metered to Stripe.
import { DEFAULT_SPEND_CAP_CENTS, isPlanName, PLAN_LIMITS, type PlanName } from "@wurmhol/auth";
import { type Db, findSpendCap, orgSubscription } from "@wurmhol/db";
import type { Config } from "./env.ts";
import type { UsageLimits } from "./org-do.ts";

export interface OrgPlan {
  /** Null: billing off on this install. */
  plan: PlanName | null;
  members: number | null;
  limits: UsageLimits & { active: number };
  /** Custom domains the org may have (ADR 0030). */
  customDomains: number;
}

/** Requests a Business org may make in a billing period without its bill passing `capCents`. */
export function businessRequests(config: Config, capCents: number) {
  const extraCents = Math.max(0, capCents - config.BUSINESS_BASE_CENTS);
  const extra = Math.floor((extraCents * 1_000_000) / config.BUSINESS_CENTS_PER_MILLION);
  return config.BUSINESS_INCLUDED_REQUESTS + extra;
}

/** The org's plan and limits; null when billing is on and it has no plan (no pipes then). */
export async function orgPlan(db: Db, config: Config, orgId: string): Promise<OrgPlan | null> {
  if (!config.auth.billing) {
    return {
      plan: null,
      members: null,
      customDomains: config.LIMIT_CUSTOM_DOMAINS,
      limits: {
        active: config.LIMIT_ACTIVE_SHARES,
        monthlyBytes: config.LIMIT_MONTHLY_BYTES,
        monthlyRequests: config.LIMIT_MONTHLY_REQUESTS,
        period: null,
        meter: null,
      },
    };
  }
  const subscription = await orgSubscription(db, orgId);
  if (!subscription) return null;
  // A plan this Worker does not know gets Friends' limits, not unlimited ones.
  const plan: PlanName = isPlanName(subscription.plan) ? subscription.plan : "friends";
  const { members, active, monthlyBytes, monthlyRequests, customDomains } = PLAN_LIMITS[plan];
  if (plan !== "business") {
    return {
      plan,
      members,
      customDomains,
      limits: { active, monthlyBytes, monthlyRequests, period: null, meter: null },
    };
  }
  // Stripe bills no usage during a trial; the trial still stops at what the base includes.
  const trial = subscription.status === "trialing";
  const cap = (await findSpendCap(db, orgId)) ?? DEFAULT_SPEND_CAP_CENTS;
  return {
    plan,
    members,
    customDomains,
    limits: {
      active,
      monthlyBytes,
      monthlyRequests: trial ? config.BUSINESS_INCLUDED_REQUESTS : businessRequests(config, cap),
      period:
        subscription.periodStart && subscription.periodEnd
          ? { start: subscription.periodStart.getTime(), end: subscription.periodEnd.getTime() }
          : null,
      // Reported during the trial too: Stripe bills none of it, and nothing after it goes missing.
      meter: subscription.stripeCustomerId ? { customer: subscription.stripeCustomerId } : null,
    },
  };
}

/** How many members the org may have: its plan's cap, or none (no plan yet, or billing off). */
export async function memberCap(db: Db, config: Config, orgId: string) {
  return (await orgPlan(db, config, orgId))?.members ?? null;
}
