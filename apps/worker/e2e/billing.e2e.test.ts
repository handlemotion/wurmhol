// Billing (ADR 0027) against Better Auth's real Stripe plugin: pipes refuse to start until the
// org starts a plan, and Stripe's webhooks (signed with the Stripe SDK's own test helper, verified
// by the plugin) start the trial, set the plan, and end it. Each plan's limits apply, and
// Business's spend cap turns into a request limit that open pipes follow at once. Reporting
// Business requests to Stripe's meter calls Stripe itself: `metering.e2e.test.ts`, with a
// sandbox key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alive,
  api,
  browserFetch,
  cli,
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

const WEBHOOK_SECRET = "whsec_e2e_wurmhol_webhook_secret";
const PRICES = {
  friends: "price_e2e_friends",
  business: "price_e2e_business",
  businessRequests: "price_e2e_business_requests",
};
const stripe = new Stripe("sk_test_unused");

let stack: Stack;
let ada: Person;
let env: Record<string, string>;
let orgId: string;
let local: Awaited<ReturnType<typeof localServer>>;
const customer = `cus_e2e${Date.now()}`;

beforeAll(async () => {
  stack = await startStack({
    STRIPE_SECRET_KEY: "sk_test_e2e_not_a_real_key",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_FRIENDS: PRICES.friends,
    STRIPE_PRICE_BUSINESS: PRICES.business,
    STRIPE_PRICE_BUSINESS_REQUESTS: PRICES.businessRequests,
    // Small enough to reach: at a spend cap of the base price, Business stops at 3 requests.
    BUSINESS_INCLUDED_REQUESTS: "3",
  });
  ada = await signIn(stack);
  orgId = (await me(stack, ada)).activeOrgId;
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  local = await localServer((_req, res) => res.end("ok"));
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

async function webhook(type: string, object: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return browserFetch(`${stack.url}/api/auth/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

/** A subscription as Stripe sends it: Business carries its metered price beside the base. */
function subscription(status: string, plan: "friends" | "business" = "friends") {
  const now = Math.floor(Date.now() / 1000);
  const trial = status === "trialing";
  const end = now + (plan === "friends" ? 365 : 30) * 86400;
  const item = (id: string, price: string, interval: string, metered = false) => ({
    id,
    price: { id: price, recurring: { interval, usage_type: metered ? "metered" : "licensed" } },
    ...(metered ? {} : { quantity: 1 }),
    current_period_start: now,
    current_period_end: end,
  });
  return {
    id: "sub_e2e_1",
    object: "subscription",
    customer,
    status,
    metadata: {},
    cancel_at_period_end: false,
    trial_start: trial ? now : null,
    trial_end: trial ? now + 14 * 86400 : null,
    items: {
      data:
        plan === "friends"
          ? [item("si_e2e_1", PRICES.friends, "year")]
          : [
              item("si_e2e_1", PRICES.business, "month"),
              item("si_e2e_2", PRICES.businessRequests, "month", true),
            ],
    },
  };
}

interface BillingBody {
  standing: { ok: boolean };
  subscription: { plan: string; status: string; trialEnd: string | null } | null;
  spendCap: { cents: number; minCents: number; requests: number } | false;
  usage: { bytes: number; requests: number } | null;
}

async function billing() {
  return (await api<BillingBody>(stack, ada, "/api/billing")).body;
}

/** Waits for the org's plan, as `/api/billing` reports it, to be `plan` (null: none). */
async function planIs(plan: string | null) {
  await waitFor(async () => ((await billing()).subscription?.plan ?? null) === plan, {
    what: `the plan to be ${plan}`,
  });
}

async function invite(person: Person) {
  return api<{ url: string }>(stack, person, "/api/invites", { method: "POST" });
}

async function accept(person: Person, url: string) {
  return api(stack, person, `/api/invites/${url.split("/join/")[1]}/accept`, { method: "POST" });
}

function pidOf(id: string) {
  const file = join(env.WURMHOL_HOME!, "shares", `${id}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
}

describe("billing", () => {
  it("refuses pipes before the org starts a plan, saying how to start a trial", async () => {
    const refused = await cli([String(local.port)], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("no plan yet");
    expect(refused.stderr).toContain("14-day trial");
    expect(await billing()).toMatchObject({ standing: { ok: false }, subscription: null });
  });

  it("only owners open billing or set a spend cap, and the plugin's own routes are closed", async () => {
    const bob = await signIn(stack);
    await accept(bob, (await invite(ada)).body.url);
    expect((await api(stack, bob, "/api/billing/open", { method: "POST", body: {} })).status).toBe(
      403,
    );
    const cap = await api(stack, bob, "/api/billing/spend-cap", {
      method: "PUT",
      body: { cents: 5000 },
    });
    expect(cap.status).toBe(403);
    const direct = await api(stack, ada, "/api/auth/subscription/upgrade", {
      method: "POST",
      body: { plan: "friends" },
    });
    expect(direct.status).toBe(404);
  });

  it("refuses a webhook with a bad signature", async () => {
    const response = await webhook(
      "customer.subscription.created",
      subscription("active"),
      "whsec_wrong",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("a Friends trial lets pipes start, takes 10 members, and has no spend cap", async () => {
    // Checkout would have made the org's Stripe customer; here the row says so directly.
    const db = stack.db({ write: true });
    db.prepare("update organizations set stripe_customer_id = ? where id = ?").run(customer, orgId);
    db.close();
    expect((await webhook("customer.subscription.created", subscription("trialing"))).status).toBe(
      200,
    );
    await planIs("friends");
    const body = await billing();
    expect(body.subscription).toMatchObject({ status: "trialing" });
    expect(body.subscription!.trialEnd).not.toBeNull();
    expect(body.spendCap).toBe(false);

    // Every viewer request counts exactly once: some go out while the pipe runs, the rest when
    // it ends.
    const started = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, started.url);
    const before = (await billing()).usage!.requests;
    for (let i = 0; i < 25; i++) {
      expect((await browserFetch(`${started.url}/n${i}`, { cookie })).status).toBe(200);
    }
    await stopAll(env);
    await waitFor(async () => (await billing()).usage!.requests >= before + 25, {
      what: "the pipe's requests to reach the org",
    });
    // Settled: nothing more arrives late.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await billing()).usage!.requests).toBe(before + 25);

    // Ada and Bob are in. Two links made at 9 members: the first fills the org to 10, the second
    // is refused at the door, and no new link can be made.
    for (let i = 0; i < 7; i++) {
      expect((await accept(await signIn(stack), (await invite(ada)).body.url)).status).toBe(200);
    }
    const early = (await invite(ada)).body.url;
    const late = (await invite(ada)).body.url;
    expect((await accept(await signIn(stack), early)).status).toBe(200);
    const refused = await accept(await signIn(stack), late);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("includes 10 members");
    expect((await invite(ada)).status).toBe(409);
    const cap = await api(stack, ada, "/api/billing/spend-cap", {
      method: "PUT",
      body: { cents: 5000 },
    });
    expect(cap.status).toBe(409);
  });

  it("Business takes any number of members and starts with a $100 spend cap", async () => {
    expect(
      (await webhook("customer.subscription.updated", subscription("active", "business"))).status,
    ).toBe(200);
    await planIs("business");
    // $100 - $20 base = $80 at $1.50 a million: 53,333,333 more than the 3 included.
    expect((await billing()).spendCap).toMatchObject({
      cents: 10_000,
      minCents: 2000,
      requests: 3 + 53_333_333,
    });
    const late = (await invite(ada)).body.url;
    expect((await accept(await signIn(stack), late)).status).toBe(200);
  });

  it("refuses a spend cap below the base price, and accepts one at it", async () => {
    const low = await api(stack, ada, "/api/billing/spend-cap", {
      method: "PUT",
      body: { cents: 1999 },
    });
    expect(low.status).toBe(400);
    const at = await api<{ requests: number }>(stack, ada, "/api/billing/spend-cap", {
      method: "PUT",
      body: { cents: 2000 },
    });
    expect(at.status).toBe(200);
    expect(at.body.requests).toBe(3);
  });

  it("ends pipes at the spend cap, refuses new ones, and raising it lets them start", async () => {
    const started = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, started.url);
    const pid = pidOf(started.id);
    // Usage reaches the Org object every few seconds: keep asking until the pipe ends.
    await waitFor(
      async () => {
        await browserFetch(`${started.url}/`, { cookie }).catch(() => null);
        return !alive(pid);
      },
      { what: "the pipe to end at the spend cap", timeoutMs: 20_000, intervalMs: 250 },
    );
    const refused = await cli([String(local.port)], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("spend cap");

    const raised = await api(stack, ada, "/api/billing/spend-cap", {
      method: "PUT",
      body: { cents: 2100 },
    });
    expect(raised.status).toBe(200);
    expect((await cli([String(local.port)], env)).code).toBe(0);
    await stopAll(env);
  });

  it("cancelling the plan stops pipes from starting again", async () => {
    expect(
      (await webhook("customer.subscription.deleted", subscription("canceled", "business"))).status,
    ).toBe(200);
    await waitFor(async () => !(await billing()).standing.ok, { what: "the plan to end" });
    expect((await cli([String(local.port)], env)).code).toBe(1);
  });
});
