// Billing (ADR 0004) against Better Auth's real Stripe plugin: pipes refuse to start until the
// org subscribes (there is no trial), and Stripe's webhooks (signed with the Stripe SDK's
// own test helper, verified by the plugin) start and end the plan. Checkout and the portal call
// Stripe itself: those run only with STRIPE_E2E_SECRET_KEY set (a test-mode key), never in CI.
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
    // Yearly only, as hosted Wurmhol sells it (ADR 0004).
    STRIPE_PRICE_YEARLY: process.env.STRIPE_E2E_PRICE_YEARLY ?? "price_e2e_year",
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

function subscription(status: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "sub_e2e_1",
    object: "subscription",
    customer,
    status,
    metadata: {},
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_e2e_1",
          price: { id: "price_e2e_year", recurring: { interval: "year" } },
          quantity: 1,
          current_period_start: now,
          current_period_end: now + 365 * 86400,
        },
      ],
    },
  };
}

describe("billing", () => {
  it("refuses pipes before the org buys a plan (no trial), saying how to subscribe", async () => {
    const refused = await cli([String(local.port)], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("no plan yet");
    expect(refused.stderr).toContain("Billing");
    const { body } = await api<{
      enabled: boolean;
      standing: { ok: boolean };
      subscription: unknown;
    }>(stack, ada, "/api/billing");
    expect(body).toMatchObject({ enabled: true, standing: { ok: false }, subscription: null });
  });

  it("only owners open billing, and the plugin's own subscription routes are closed", async () => {
    const bob = await signIn(stack);
    const { body: invite } = await api<{ url: string }>(stack, ada, "/api/invites", {
      method: "POST",
    });
    await api(stack, bob, `/api/invites/${invite.url.split("/join/")[1]}/accept`, {
      method: "POST",
    });
    expect((await api(stack, bob, "/api/billing/open", { method: "POST", body: {} })).status).toBe(
      403,
    );
    const direct = await api(stack, ada, "/api/auth/subscription/upgrade", {
      method: "POST",
      body: { plan: "wurmhol" },
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

  it("a webhook-driven plan lets shares start, and its cancellation stops them again", async () => {
    // Checkout would have made the org's Stripe customer; here the row says so directly.
    const db = new DatabaseSync(dbPath(stack));
    db.prepare("update organizations set stripe_customer_id = ? where id = ?").run(customer, orgId);
    db.close();

    expect((await webhook("customer.subscription.created", subscription("active"))).status).toBe(
      200,
    );
    await waitFor(
      async () =>
        (await api<{ standing: { ok: boolean } }>(stack, ada, "/api/billing")).body.standing.ok,
      { what: "the plan to apply" },
    );
    const { body } = await api<{ subscription: { status: string } }>(stack, ada, "/api/billing");
    expect(body.subscription.status).toBe("active");
    const started = await cli([String(local.port)], env);
    expect(started.code).toBe(0);
    await stopAll(env);

    expect((await webhook("customer.subscription.deleted", subscription("canceled"))).status).toBe(
      200,
    );
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
