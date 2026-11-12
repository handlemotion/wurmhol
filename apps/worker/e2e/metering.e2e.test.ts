// Business requests metered to Stripe (ADR 0027), against a real Stripe sandbox: the Org object
// sends each request once, as meter events Stripe sums per customer. Needs a sandbox key and the
// sandbox's ids, so it runs only where those are set (`doppler run -c dev_worker`), never in CI:
//
//   STRIPE_E2E_SECRET_KEY, STRIPE_E2E_METER_ID, STRIPE_E2E_PRICE_FRIENDS,
//   STRIPE_E2E_PRICE_BUSINESS, STRIPE_E2E_PRICE_BUSINESS_REQUESTS
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  api,
  browserFetch,
  cliEnv,
  createToken,
  localServer,
  me,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

const e2e = {
  key: process.env.STRIPE_E2E_SECRET_KEY ?? "",
  meter: process.env.STRIPE_E2E_METER_ID ?? "",
  friends: process.env.STRIPE_E2E_PRICE_FRIENDS ?? "",
  business: process.env.STRIPE_E2E_PRICE_BUSINESS ?? "",
  requests: process.env.STRIPE_E2E_PRICE_BUSINESS_REQUESTS ?? "",
};

const WEBHOOK_SECRET = "whsec_e2e_wurmhol_metering";

describe.runIf(e2e.key && e2e.meter)("metering Business requests to Stripe", () => {
  let stripe: Stripe;
  let stack: Stack;
  let ada: Person;
  let env: Record<string, string>;
  let customer: string;
  let local: Awaited<ReturnType<typeof localServer>>;

  beforeAll(async () => {
    stripe = new Stripe(e2e.key);
    stack = await startStack({
      STRIPE_SECRET_KEY: e2e.key,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_FRIENDS: e2e.friends,
      STRIPE_PRICE_BUSINESS: e2e.business,
      STRIPE_PRICE_BUSINESS_REQUESTS: e2e.requests,
    });
    ada = await signIn(stack);
    const orgId = (await me(stack, ada)).activeOrgId;
    env = cliEnv(stack, (await createToken(stack, ada)).token);
    local = await localServer((_req, res) => res.end("ok"));
    customer = (await stripe.customers.create({ description: "wurmhol metering e2e" })).id;
    const db = stack.db({ write: true });
    db.prepare("update organizations set stripe_customer_id = ? where id = ?").run(customer, orgId);
    db.close();
    // The subscription as Stripe would send it; the meter events are real.
    const now = Math.floor(Date.now() / 1000);

    const item = (id: string, price: string) => ({
      id,
      price: { id: price, recurring: { interval: "month" } },
      current_period_start: now,
      current_period_end: now + 30 * 86400,
    });

    const payload = JSON.stringify({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      object: "event",
      type: "customer.subscription.created",
      created: now,
      data: {
        object: {
          id: `sub_e2e_${now}`,
          object: "subscription",
          customer,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [item("si_e2e_1", e2e.business), item("si_e2e_2", e2e.requests)] },
        },
      },
    });

    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const hook = await browserFetch(`${stack.url}/api/auth/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });

    if (hook.status !== 200) throw new Error(`the subscription webhook answered ${hook.status}`);
  });

  afterAll(async () => {
    await stopAll(env);
    await local.close();
    await stack.stop();
    await stripe.customers.del(customer).catch(() => {});
  });

  it("sends each viewer request to the meter exactly once", async () => {
    const start = Math.floor(Date.now() / 1000) - 60;
    const started = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, started.url);
    const usage = z.object({ usage: z.object({ requests: z.number() }) });
    const { body: before } = await api(stack, ada, "/api/billing", {}, usage);

    for (let i = 0; i < 7; i++) {
      expect((await browserFetch(`${started.url}/m${i}`, { cookie })).status).toBe(200);
    }

    await stopAll(env);
    const sent = before.usage.requests + 7;

    // The Org object sends within a minute; Stripe sums meter events a little later.
    const total = await waitFor(
      async () => {
        const end = Math.ceil(Date.now() / 60 / 1000) * 60 + 60;

        const summaries = await stripe.billing.meters.listEventSummaries(e2e.meter, {
          customer,
          start_time: Math.floor(start / 60) * 60,
          end_time: end,
        });

        const sum = summaries.data.reduce((n, s) => n + s.aggregated_value, 0);

        return sum >= sent ? sum : null;
      },
      { what: "Stripe to sum the meter events", timeoutMs: 240_000, intervalMs: 10_000 },
    );

    expect(total).toBe(sent);
  }, 300_000);
});
