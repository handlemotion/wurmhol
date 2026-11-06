// Billing (ADR 0027): Friends or Business per org, each starting with a trial, through Better
// Auth's Stripe plugin. Checkout when the org has no plan, the customer portal (the card, invoices,
// cancelling) when it has one. Business also has a spend cap, which an owner sets here. Owners
// manage billing; any member may read it.
import { zValidator } from "@hono/zod-validator";
import { DEFAULT_SPEND_CAP_CENTS, PLAN_NAMES, TRIAL_DAYS } from "@wurmhol/auth";
import { findSpendCap, orgStanding, orgSubscription, setSpendCap } from "@wurmhol/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, requireOwner } from "../context.ts";
import { orgStub } from "../org-do.ts";
import { businessRequests, orgPlan } from "../plan.ts";
import { limitPerMember } from "../rate-limiter.ts";

const openBody = z.object({
  /** Checkout's plan; ignored once the org has one (the portal manages it then). */
  plan: z.enum(PLAN_NAMES).default("friends"),
});

/** The largest spend cap an owner can set without asking us: $100,000 a month. */
const MAX_SPEND_CAP_CENTS = 10_000_000;

export const billing = new Hono<AppEnv>()
  .get("/billing", async (c) => {
    const { config, db, member } = c.var;
    const enabled = config.auth.billing !== undefined;
    const standing = await orgStanding(db, member.orgId, { enabled });
    const subscription = enabled ? await orgSubscription(db, member.orgId) : null;
    const cents =
      subscription?.plan === "business"
        ? ((await findSpendCap(db, member.orgId)) ?? DEFAULT_SPEND_CAP_CENTS)
        : null;
    const usage = enabled ? await orgStub(c.env, member.orgId).usage() : null;
    return c.json({
      enabled,
      canManage: member.role === "owner",
      trialDays: TRIAL_DAYS,
      plans: enabled ? PLAN_NAMES : [],
      standing,
      subscription: subscription && {
        plan: subscription.plan,
        status: subscription.status,
        periodEnd: subscription.periodEnd?.toISOString() ?? null,
        trialEnd: subscription.trialEnd?.toISOString() ?? null,
      },
      usage: usage && { bytes: usage.bytes, requests: usage.requests },
      spendCap: cents !== null && {
        cents,
        minCents: config.BUSINESS_BASE_CENTS,
        maxCents: MAX_SPEND_CAP_CENTS,
        requests: businessRequests(config, cents),
      },
    });
  })
  /** Where Billing goes: the portal when the org has a plan, else Checkout for the asked one. */
  .post("/billing/open", requireOwner, zValidator("json", openBody), async (c) => {
    const { config, db, member, auth } = c.var;
    if (!config.auth.billing) {
      throw new HTTPException(404, { message: "billing is off on this install" });
    }
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
    const session = await auth.api.upgradeSubscription({
      headers: c.req.raw.headers,
      body: {
        plan: c.req.valid("json").plan,
        customerType: "organization",
        referenceId: member.orgId,
        successUrl: back,
        cancelUrl: back,
        disableRedirect: true,
      },
    });
    if (!session.url) throw new HTTPException(502, { message: "Stripe returned no checkout URL" });
    return c.json({ url: session.url });
  })
  /**
   * Business's spend cap, in cents a billing period, base price included. It applies at once,
   * to open pipes too: the Org object gets the new limits.
   */
  .put(
    "/billing/spend-cap",
    requireOwner,
    limitPerMember("manage"),
    zValidator("json", z.object({ cents: z.number().int() })),
    async (c) => {
      const { config, db, member } = c.var;
      const plan = await orgPlan(db, config, member.orgId);
      if (plan?.plan !== "business") {
        throw new HTTPException(409, { message: "only Business has a spend cap" });
      }
      const { cents } = c.req.valid("json");
      if (cents < config.BUSINESS_BASE_CENTS || cents > MAX_SPEND_CAP_CENTS) {
        throw new HTTPException(400, {
          message: `set a spend cap from $${config.BUSINESS_BASE_CENTS / 100} to $${MAX_SPEND_CAP_CENTS / 100} a month`,
        });
      }
      await setSpendCap(db, member.orgId, cents);
      const updated = await orgPlan(db, config, member.orgId);
      if (updated) await orgStub(c.env, member.orgId).setLimits(updated.limits);
      return c.json({ cents, requests: businessRequests(config, cents) });
    },
  );
