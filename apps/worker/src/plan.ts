// An org's limits (ADR 0026): its plan's with billing on, the `LIMIT_*` variables with billing off.
import { isPlanName, type OrgLimits, PLAN_LIMITS } from "@wurmhol/auth";
import { type Db, orgStanding, type Standing } from "@wurmhol/db";
import type { Config } from "./env.ts";

/** The limits a standing grants; null when the org has no plan and may not start pipes. */
export function limitsOf(config: Config, standing: Standing): OrgLimits | null {
  if (standing.reason === "billing_off") {
    return {
      members: null,
      active: config.LIMIT_ACTIVE_SHARES,
      monthlyBytes: config.LIMIT_MONTHLY_BYTES,
      monthlyRequests: config.LIMIT_MONTHLY_REQUESTS,
    };
  }
  if (standing.reason === "no_subscription") return null;
  // A plan this Worker does not know gets the smaller plan's limits, not unlimited ones.
  return PLAN_LIMITS[isPlanName(standing.plan) ? standing.plan : "personal"];
}

export async function orgPlan(db: Db, config: Config, orgId: string) {
  const standing = await orgStanding(db, orgId, { enabled: config.auth.billing !== undefined });
  return { standing, limits: limitsOf(config, standing) };
}

/** How many members the org may have: its plan's cap, or none (no plan yet, or billing off). */
export async function memberCap(db: Db, config: Config, orgId: string) {
  return (await orgPlan(db, config, orgId)).limits?.members ?? null;
}
