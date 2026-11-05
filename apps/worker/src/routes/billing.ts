// Billing (spec section 4): one plan per org, $3 a month or $30 a year, through Better Auth's
// Stripe plugin. One menu item: the customer portal when the org has a plan, Checkout (yearly
// first, the cheaper one to charge) when it has none. Owners only.
import { zValidator } from "@hono/zod-validator";
import { PLAN_NAME } from "@wurmhol/auth";
import { orgStanding, orgSubscription } from "@wurmhol/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, requireOwner } from "../context.ts";

const openBody = z.object({
  /** Checkout's interval; yearly unless asked otherwise (and offered). */
  interval: z.enum(["month", "year"]).optional(),
});

export const billing = new Hono<AppEnv>()
  .get("/billing", async (c) => {
    const { config, db, member } = c.var;
    const plan = config.auth.billing;
    const standing = await orgStanding(db, member.orgId, {
      enabled: plan !== undefined,
      trialDays: config.auth.trialDays,
    });
    const subscription = plan ? await orgSubscription(db, member.orgId) : null;
    return c.json({
      enabled: plan !== undefined,
      canManage: member.role === "owner",
      yearly: Boolean(plan?.yearlyPriceId),
      standing,
      subscription: subscription && {
        status: subscription.status,
        periodEnd: subscription.periodEnd?.toISOString() ?? null,
      },
    });
  })
  /** Where the Billing menu item goes: the portal, or Checkout when there is no plan. */
  .post("/billing/open", requireOwner, zValidator("json", openBody), async (c) => {
    const { config, db, member, auth } = c.var;
    const plan = config.auth.billing;
    if (!plan) throw new HTTPException(404, { message: "billing is off on this install" });
    const back = new URL("/", config.auth.baseURL).toString();
    if (await orgSubscription(db, member.orgId)) {
      const portal = await auth.api.createBillingPortal({
        headers: c.req.raw.headers,
        body: {
          customerType: "organization",
          referenceId: member.orgId,
          returnUrl: back,
          disableRedirect: true,
        },
      });
      return c.json({ url: portal.url });
    }
    const interval = c.req.valid("json").interval ?? (plan.yearlyPriceId ? "year" : "month");
    if (interval === "year" && !plan.yearlyPriceId) {
      throw new HTTPException(400, { message: "yearly billing is not offered" });
    }
    const session = await auth.api.upgradeSubscription({
      headers: c.req.raw.headers,
      body: {
        plan: PLAN_NAME,
        annual: interval === "year",
        customerType: "organization",
        referenceId: member.orgId,
        successUrl: back,
        cancelUrl: back,
        disableRedirect: true,
      },
    });
    if (!session.url) throw new HTTPException(502, { message: "Stripe returned no checkout URL" });
    return c.json({ url: session.url });
  });
