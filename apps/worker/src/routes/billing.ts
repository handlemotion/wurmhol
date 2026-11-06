// Billing (ADR 0026): Personal or Team per org, each starting with a trial, through Better Auth's
// Stripe plugin. Checkout when the org has no plan, the customer portal (switching plans and
// intervals, the card, cancelling) when it has one. Owners only.
import { zValidator } from "@hono/zod-validator";
import { PLAN_NAMES, TRIAL_DAYS } from "@wurmhol/auth";
import { orgStanding, orgSubscription } from "@wurmhol/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, requireOwner } from "../context.ts";

const openBody = z.object({
  /** Checkout's plan; ignored once the org has one (the portal switches plans). */
  plan: z.enum(PLAN_NAMES).default("personal"),
  /** Team's interval; monthly unless asked otherwise (and offered). Personal is yearly only. */
  interval: z.enum(["month", "year"]).optional(),
});

export const billing = new Hono<AppEnv>()
  .get("/billing", async (c) => {
    const { config, db, member } = c.var;
    const prices = config.auth.billing?.prices;
    const standing = await orgStanding(db, member.orgId, { enabled: prices !== undefined });
    const subscription = prices ? await orgSubscription(db, member.orgId) : null;
    return c.json({
      enabled: prices !== undefined,
      canManage: member.role === "owner",
      trialDays: TRIAL_DAYS,
      plans: prices
        ? [
            { name: "personal", intervals: ["year"] },
            { name: "team", intervals: prices.teamYearly ? ["month", "year"] : ["month"] },
          ]
        : [],
      standing,
      subscription: subscription && {
        plan: subscription.plan,
        status: subscription.status,
        periodEnd: subscription.periodEnd?.toISOString() ?? null,
        trialEnd: subscription.trialEnd?.toISOString() ?? null,
      },
    });
  })
  /** Where Billing goes: the portal when the org has a plan, else Checkout for the asked one. */
  .post("/billing/open", requireOwner, zValidator("json", openBody), async (c) => {
    const { config, db, member, auth } = c.var;
    const prices = config.auth.billing?.prices;
    if (!prices) throw new HTTPException(404, { message: "billing is off on this install" });
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
    const { plan } = c.req.valid("json");
    const interval = c.req.valid("json").interval ?? (plan === "personal" ? "year" : "month");
    const offered =
      plan === "personal" ? interval === "year" : interval === "month" || !!prices.teamYearly;
    if (!offered) {
      throw new HTTPException(400, { message: `${plan} is not offered ${interval}ly` });
    }
    const session = await auth.api.upgradeSubscription({
      headers: c.req.raw.headers,
      body: {
        plan,
        // `annual` picks Team's yearly price; Personal's base price is already yearly.
        annual: plan === "team" && interval === "year",
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
