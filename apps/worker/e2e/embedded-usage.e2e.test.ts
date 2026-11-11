// Embedded tunnels' usage and limits (ADR 0032, step 6) on the real stack with billing on: every
// request counts toward the org's Business usage, attributed to its application and tenant; a
// tenant's own limits end and refuse only that tenant's tunnels; and the integration reads the
// counts, never anything from inside a tunnel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alive,
  api,
  browserFetch,
  cli,
  cliEnv,
  localServer,
  me,
  type Person,
  share,
  signIn,
  type Stack,
  startPlan,
  startStack,
  stopAll,
  STRIPE_E2E_VARS,
  waitFor,
} from "./support.ts";

const ALL = ["tunnels:read", "tunnels:manage", "subjects:manage", "grants:issue"];

let stack: Stack;
let apiHost: string;
let owner: Person;
let key: string;
let appId: string;
let local: Awaited<ReturnType<typeof localServer>>;
const envs: Record<string, string>[] = [];

async function embed<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await browserFetch(`${apiHost}/v1/embed${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function tenant(id: string, body: Record<string, unknown> = {}) {
  expect((await embed(`/tenants/${id}`, { method: "PUT", body })).status).toBe(200);
  const subject = await embed(`/tenants/${id}/subjects/user`, {
    method: "PUT",
    body: { kind: "user" },
  });
  expect(subject.status).toBe(200);
}

async function newTunnel(tenantId: string) {
  const made = await embed<{
    tunnel: { id: string; url: string };
    connector: { connector: string };
  }>("/tunnels", { method: "POST", body: { tenant: tenantId, owner: "user" } });
  expect(made.status).toBe(201);
  const env = cliEnv(stack, made.body.connector.connector);
  envs.push(env);
  return { ...made.body.tunnel, env };
}

async function token(tunnel: string) {
  const made = await embed<{ grant: { token: string } }>("/grants", {
    method: "POST",
    body: { tunnel, subject: "user", kind: "client" },
  });
  return made.body.grant.token;
}

function pidOf(env: Record<string, string>, id: string) {
  const file = join(env.WURMHOL_HOME!, "shares", `${id}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
}

interface Counts {
  requests: number;
  bytes: number;
  openTunnels: number;
}

beforeAll(async () => {
  stack = await startStack({
    ...STRIPE_E2E_VARS,
    CONNECT_HOST: "api.localhost",
    EMBEDDED_ENABLED: "true",
  });
  apiHost = `http://api.localhost:${stack.port}`;
  owner = await signIn(stack);
  await startPlan(stack, (await me(stack, owner)).activeOrgId, "business");
  const app = await api<{ app: { id: string } }>(stack, owner, "/api/apps", {
    method: "POST",
    body: { name: "Dorks" },
  });
  appId = app.body.app.id;
  key = (
    await api<{ key: string }>(stack, owner, `/api/apps/${appId}/keys`, {
      method: "POST",
      body: { name: "backend", permissions: ALL },
    })
  ).body.key;
  local = await localServer((_req, res) => res.end("ok"));
});

afterAll(async () => {
  for (const env of envs) await stopAll(env);
  await local.close();
  await stack.stop();
});

describe("open tunnels", () => {
  it("stop at a tenant's own limit, which leaves other tenants alone", async () => {
    await tenant("small", { activeTunnels: 1 });
    await tenant("roomy");
    const first = await newTunnel("small");
    await share(stack, first.env, local.port);
    const second = await newTunnel("small");
    const refused = await cli([String(local.port)], second.env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("This account already has 1 tunnels open");
    const other = await newTunnel("roomy");
    expect((await cli([String(local.port)], other.env)).code).toBe(0);
  });

  it("follow the application's default for tenants, changed at once", async () => {
    await tenant("defaulted");
    const patched = await api(stack, owner, `/api/apps/${appId}`, {
      method: "PATCH",
      body: { tenantActiveTunnels: 1 },
    });
    expect(patched.status).toBe(200);
    const first = await newTunnel("defaulted");
    await share(stack, first.env, local.port);
    const second = await newTunnel("defaulted");
    expect((await cli([String(local.port)], second.env)).code).not.toBe(0);
    await api(stack, owner, `/api/apps/${appId}`, {
      method: "PATCH",
      body: { tenantActiveTunnels: null },
    });
  });
});

describe("requests", () => {
  // Catches: one tenant's runaway use ending every tenant's tunnels, or the SaaS's whole org.
  it("end only the tenant that used its own allowance, and refuse its new ones", async () => {
    await tenant("metered", { monthlyRequests: 3 });
    await tenant("calm");
    const metered = await newTunnel("metered");
    const calm = await newTunnel("calm");
    const meteredPipe = await share(stack, metered.env, local.port);
    const calmPipe = await share(stack, calm.env, local.port);
    const meteredGrant = { "x-wurmhol-grant": await token(metered.id) };
    const calmGrant = { "x-wurmhol-grant": await token(calm.id) };
    const pid = pidOf(metered.env, meteredPipe.id);
    // Usage reaches the Org object every few seconds: keep asking until the tunnel ends.
    await waitFor(
      async () => {
        await browserFetch(`${metered.url}/`, { headers: meteredGrant }).catch(() => null);
        return !alive(pid);
      },
      { what: "the metered tenant's tunnel to end", timeoutMs: 30_000, intervalMs: 250 },
    );
    const refused = await cli([String(local.port)], metered.env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("used this month's requests");
    expect((await browserFetch(`${calm.url}/`, { headers: calmGrant })).status).toBe(200);
    expect(alive(pidOf(calm.env, calmPipe.id))).toBe(true);
  });

  it("count toward the org, attributed to the application and each tenant", async () => {
    const usage = await embed<{
      window: string;
      app: Counts;
      tenants: Record<string, Counts & { limits: { monthlyRequests: number | null } }>;
    }>("/usage?tenant=metered&tenant=calm&tenant=nobody");
    expect(usage.status).toBe(200);
    const { app, tenants } = usage.body;
    expect(Object.keys(tenants).toSorted()).toEqual(["calm", "metered"]);
    expect(tenants.metered!.requests).toBeGreaterThanOrEqual(3);
    expect(tenants.metered!.limits.monthlyRequests).toBe(3);
    expect(tenants.calm!.requests).toBeGreaterThanOrEqual(1);
    expect(app.requests).toBeGreaterThanOrEqual(tenants.metered!.requests + tenants.calm!.requests);
    expect(JSON.stringify(usage.body)).not.toMatch(/title|favicon|path/);
    // Every request in this org is embedded, so the org's count is the application's.
    const billing = await api<{ usage: { requests: number } }>(stack, owner, "/api/billing");
    expect(billing.body.usage.requests).toBe(app.requests);
  });
});
