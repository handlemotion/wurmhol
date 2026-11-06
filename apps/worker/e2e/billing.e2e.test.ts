// Billing (ADR 0026) against Better Auth's real Stripe plugin: pipes refuse to start until the
// org starts a plan, and Stripe's webhooks (signed with the Stripe SDK's own test helper, verified
// by the plugin) start the trial, apply the plan's limits, move it between plans and end it.
// Checkout and the portal call Stripe itself: those run only with STRIPE_E2E_SECRET_KEY set (a
// test-mode key), never in CI.
import { DatabaseSync } from "node:sqlite";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  me,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  waitFor,
} from "./support.ts";

const WEBHOOK_SECRET = "whsec_e2e_wurmhol_webhook_secret";
const PRICES = {
  personal: process.env.STRIPE_E2E_PRICE_PERSONAL ?? "price_e2e_personal",
  team: process.env.STRIPE_E2E_PRICE_TEAM_MONTHLY ?? "price_e2e_team",
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
    STRIPE_SECRET_KEY: process.env.STRIPE_E2E_SECRET_KEY ?? "sk_test_e2e_not_a_real_key",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_PERSONAL: PRICES.personal,
    STRIPE_PRICE_TEAM_MONTHLY: PRICES.team,
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

function subscription(status: string, price = PRICES.personal) {
  const now = Math.floor(Date.now() / 1000);
  const trial = status === "trialing";
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
      data: [
        {
          id: "si_e2e_1",
          price: {
            id: price,
            recurring: { interval: price === PRICES.personal ? "year" : "month" },
          },
          quantity: 1,
          current_period_start: now,
          current_period_end: now + (trial ? 14 : 365) * 86400,
        },
      ],
    },
  };
}

/** Waits for the org's plan, as `/api/billing` reports it, to be `plan` (null: none). */
async function planIs(plan: string | null) {
  await waitFor(
    async () => {
      const { body } = await api<{ subscription: { plan: string } | null }>(
        stack,
        ada,
        "/api/billing",
      );
      return (body.subscription?.plan ?? null) === plan;
    },
    { what: `the plan to be ${plan}` },
  );
}

async function invite(person: Person) {
  return api<{ url: string }>(stack, person, "/api/invites", { method: "POST" });
}

async function accept(person: Person, url: string) {
  return api(stack, person, `/api/invites/${url.split("/join/")[1]}/accept`, { method: "POST" });
}

describe("billing", () => {
  it("refuses pipes before the org starts a plan, saying how to start a trial", async () => {
    const refused = await cli([String(local.port)], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("no plan yet");
    expect(refused.stderr).toContain("14-day trial");
    const { body } = await api<{
      enabled: boolean;
      standing: { ok: boolean };
      subscription: unknown;
    }>(stack, ada, "/api/billing");
    expect(body).toMatchObject({ enabled: true, standing: { ok: false }, subscription: null });
  });

  it("only owners open billing, and the plugin's own subscription routes are closed", async () => {
    const bob = await signIn(stack);
    await accept(bob, (await invite(ada)).body.url);
    expect((await api(stack, bob, "/api/billing/open", { method: "POST", body: {} })).status).toBe(
      403,
    );
    const direct = await api(stack, ada, "/api/auth/subscription/upgrade", {
      method: "POST",
      body: { plan: "personal" },
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

  it("a Personal trial lets pipes start, up to Personal's 3 at once", async () => {
    // Checkout would have made the org's Stripe customer; here the row says so directly.
    const db = new DatabaseSync(dbPath(stack));
    db.prepare("update organizations set stripe_customer_id = ? where id = ?").run(customer, orgId);
    db.close();

    expect((await webhook("customer.subscription.created", subscription("trialing"))).status).toBe(
      200,
    );
    await planIs("personal");
    const { body } = await api<{ subscription: { status: string; trialEnd: string | null } }>(
      stack,
      ada,
      "/api/billing",
    );
    expect(body.subscription.status).toBe("trialing");
    expect(body.subscription.trialEnd).not.toBeNull();
    const results = await Promise.all([0, 1, 2, 3].map(() => cli([String(local.port)], env)));
    expect(results.filter((r) => r.code === 0)).toHaveLength(3);
    expect(results.find((r) => r.code !== 0)!.stderr).toContain("already has 3 open pipes");
    await stopAll(env);
  });

  it("Personal takes 3 members; moving to Team takes any number", async () => {
    // Ada and Bob are in. Two links made now: the first fills the org, the second is refused at
    // the door, and no new link can be made.
    const early = (await invite(ada)).body.url;
    const late = (await invite(ada)).body.url;
    expect((await accept(await signIn(stack), early)).status).toBe(200);
    const refused = await accept(await signIn(stack), late);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("includes 3 members");
    expect((await invite(ada)).status).toBe(409);

    // The portal moves the org to Team: Stripe updates the subscription's price.
    expect(
      (await webhook("customer.subscription.updated", subscription("active", PRICES.team))).status,
    ).toBe(200);
    await planIs("team");
    expect((await accept(await signIn(stack), late)).status).toBe(200);
    const results = await Promise.all([0, 1, 2, 3].map(() => cli([String(local.port)], env)));
    expect(results.every((r) => r.code === 0)).toBe(true);
    await stopAll(env);
  });

  it("cancelling the plan stops pipes from starting again", async () => {
    expect(
      (await webhook("customer.subscription.deleted", subscription("canceled", PRICES.team)))
        .status,
    ).toBe(200);
    await waitFor(
      async () =>
        !(await api<{ standing: { ok: boolean } }>(stack, ada, "/api/billing")).body.standing.ok,
      { what: "the plan to end" },
    );
    expect((await cli([String(local.port)], env)).code).toBe(1);
  });
});

function dbPath(s: Stack) {
  const handle = s.db();
  const path = (handle.prepare("pragma database_list").get() as { file: string }).file;
  handle.close();
  return path;
}
