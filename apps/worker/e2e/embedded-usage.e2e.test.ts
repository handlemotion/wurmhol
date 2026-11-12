// Embedded tunnels' usage and limits (ADR 0032, step 6) on the real stack with billing on: every
// request counts toward the org's Business usage, attributed to its application and tenant; a
// tenant's own limits end and refuse only that tenant's tunnels; and the integration reads the
// counts, never anything from inside a tunnel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  alive,
  api,
  type ApiResult,
  browserFetch,
  cli,
  cliEnv,
  type JsonValue,
  localServer,
  me,
  parseJson,
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

interface EmbedInit {
  method?: string;
  body?: JsonValue;
}

/**
 * A bearer call to `/v1/embed…` on the CLI's host with the app's key. The body is decoded with
 * `schema` (an empty body is `null`); without one it is any JSON value.
 */
async function embed(path: string, init?: EmbedInit): Promise<ApiResult<JsonValue>>;
async function embed<S extends z.ZodType>(
  path: string,
  init: EmbedInit,
  schema: S,
): Promise<ApiResult<z.output<S>>>;
async function embed<T>(
  path: string,
  init: EmbedInit = {},
  schema?: z.ZodType<T>,
): Promise<ApiResult<T | JsonValue>> {
  const authorization = `Bearer ${key}`;

  const response = await browserFetch(`${apiHost}/v1/embed${path}`, {
    method: init.method ?? "GET",
    headers: init.body ? { authorization, "content-type": "application/json" } : { authorization },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = (await response.text()) || "null";

  return {
    status: response.status,
    body: schema ? parseJson(schema, text) : parseJson(z.json(), text),
  };
}

/** A tenant's own limits; one left out follows the application's default. */
type TenantLimits = {
  activeTunnels?: number;
  monthlyRequests?: number;
};

async function tenant(id: string, body: TenantLimits = {}) {
  expect((await embed(`/tenants/${id}`, { method: "PUT", body })).status).toBe(200);

  const subject = await embed(`/tenants/${id}/subjects/user`, {
    method: "PUT",
    body: { kind: "user" },
  });

  expect(subject.status).toBe(200);
}

async function newTunnel(tenantId: string) {
  const made = await embed("/tunnels", {
    method: "POST",
    body: { tenant: tenantId, owner: "user" },
  });

  expect(made.status).toBe(201);

  const { tunnel, connector } = z
    .object({
      tunnel: z.object({ id: z.string(), url: z.string() }),
      connector: z.object({ connector: z.string() }),
    })
    .parse(made.body);

  const env = cliEnv(stack, connector.connector);
  envs.push(env);

  return { ...tunnel, env };
}

async function token(tunnel: string) {
  const made = await embed(
    "/grants",
    { method: "POST", body: { tunnel, subject: "user", kind: "client" } },
    z.object({ grant: z.object({ token: z.string() }) }),
  );

  return made.body.grant.token;
}

function pidOf(env: Record<string, string>, id: string) {
  const file = join(env.WURMHOL_HOME!, "shares", `${id}.json`);

  return parseJson(z.object({ pid: z.number() }), readFileSync(file, "utf8")).pid;
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

  const app = await api(
    stack,
    owner,
    "/api/apps",
    { method: "POST", body: { name: "Dorks" } },
    z.object({ app: z.object({ id: z.string() }) }),
  );

  appId = app.body.app.id;
  key = (
    await api(
      stack,
      owner,
      `/api/apps/${appId}/keys`,
      { method: "POST", body: { name: "backend", permissions: ALL } },
      z.object({ key: z.string() }),
    )
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
    // Loose throughout: the whole answer is searched for anything from inside a tunnel.
    const usage = await embed(
      "/usage?tenant=metered&tenant=calm&tenant=nobody",
      {},
      z.looseObject({
        app: z.looseObject({ requests: z.number() }),
        tenants: z.record(
          z.string(),
          z.looseObject({
            requests: z.number(),
            limits: z.looseObject({ monthlyRequests: z.number().nullable() }).optional(),
          }),
        ),
      }),
    );

    expect(usage.status).toBe(200);
    const { app, tenants } = usage.body;
    expect(Object.keys(tenants).toSorted()).toEqual(["calm", "metered"]);
    expect(tenants.metered!.requests).toBeGreaterThanOrEqual(3);
    expect(tenants.metered!.limits?.monthlyRequests).toBe(3);
    expect(tenants.calm!.requests).toBeGreaterThanOrEqual(1);
    expect(app.requests).toBeGreaterThanOrEqual(tenants.metered!.requests + tenants.calm!.requests);
    expect(JSON.stringify(usage.body)).not.toMatch(/title|favicon|path/);

    // Every request in this org is embedded, so the org's count is the application's.
    const billing = await api(
      stack,
      owner,
      "/api/billing",
      {},
      z.object({ usage: z.object({ requests: z.number() }) }),
    );

    expect(billing.body.usage.requests).toBe(app.requests);
  });
});
