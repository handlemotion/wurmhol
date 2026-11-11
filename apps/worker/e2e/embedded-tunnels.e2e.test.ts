// Embedded tunnels' lifecycle (ADR 0032, step 4) on the real stack with the real CLI: a SaaS's
// backend makes tenants, subjects and tunnels with its integration key; an agent opens its one
// tunnel with a connector; the tunnel never reaches the wall, the org's pipes API, a member's
// sign-in or an access key; and stop, rotate, delete and takedown end it as they say.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alive,
  api,
  browserFetch,
  browserSocket,
  cli,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  waitFor,
} from "./support.ts";

const OPERATOR_TOKEN = "operator-token-for-e2e-0123456789abcdef";
const ALL = ["tunnels:read", "tunnels:manage", "subjects:manage", "grants:issue"];

interface Tunnel {
  id: string;
  url: string;
  tenant: string;
  owner: string;
  state: string;
  session: { id: string; bytes: number } | null;
  lastEnd: { reason: string } | null;
  access?: string[];
}

let stack: Stack;
let apiHost: string;
let owner: Person;
let key: string;
let local: Awaited<ReturnType<typeof localServer>>;
const envs: Record<string, string>[] = [];

/** A bearer call to `/v1/embed…` on the CLI's host. */
async function embed<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) {
  const response = await browserFetch(`${apiHost}/v1/embed${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.token ?? key}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function makeKey(person: Person, permissions: string[]) {
  const app = await api<{ app: { id: string } }>(stack, person, "/api/apps", {
    method: "POST",
    body: { name: "Dorks" },
  });
  const made = await api<{ key: string }>(stack, person, `/api/apps/${app.body.app.id}/keys`, {
    method: "POST",
    body: { name: "backend", permissions },
  });
  return { appId: app.body.app.id, key: made.body.key };
}

async function subject(tenant: string, id: string) {
  expect((await embed(`/tenants/${tenant}`, { method: "PUT", body: {} })).status).toBe(200);
  const put = await embed(`/tenants/${tenant}/subjects/${id}`, {
    method: "PUT",
    body: { kind: "user" },
  });
  expect(put.status).toBe(200);
}

async function newTunnel(tenant: string, ownerId: string, access: string[] = []) {
  const made = await embed<{ tunnel: Tunnel; connector: { id: string; connector: string } }>(
    "/tunnels",
    { method: "POST", body: { tenant, owner: ownerId, access } },
  );
  expect(made.status).toBe(201);
  return made.body;
}

function agentEnv(connector: string) {
  const env = cliEnv(stack, connector);
  envs.push(env);
  return env;
}

function pidOf(env: Record<string, string>, id: string) {
  const file = join(env.WURMHOL_HOME!, "shares", `${id}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
}

/** The status a WebSocket handshake with `token` gets: 101 when it opened. */
function handshake(url: string, token: string) {
  return new Promise<number>((resolve) => {
    const socket = browserSocket(url, [], { authorization: `Bearer ${token}` });
    socket.on("upgrade", () => {
      socket.terminate();
      resolve(101);
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on("error", () => resolve(0));
  });
}

async function tunnel(id: string) {
  return (await embed<{ tunnel: Tunnel }>(`/tunnels/${id}`)).body.tunnel;
}

beforeAll(async () => {
  stack = await startStack({
    CONNECT_HOST: "api.localhost",
    EMBEDDED_ENABLED: "true",
    OPERATOR_TOKEN,
  });
  apiHost = `http://api.localhost:${stack.port}`;
  owner = await signIn(stack);
  key = (await makeKey(owner, ALL)).key;
  local = await localServer((_req, res) => res.end("ok"));
  await subject("acme", "alice");
  await subject("acme", "bob");
  await subject("globex", "carol");
});

afterAll(async () => {
  for (const env of envs) await stopAll(env);
  await local.close();
  await stack.stop();
});

describe("tenants and subjects", () => {
  it("keeps a subject's kind", async () => {
    const changed = await embed("/tenants/acme/subjects/alice", {
      method: "PUT",
      body: { kind: "service" },
    });
    expect(changed.status).toBe(409);
  });

  // Catches: a tunnel whose access list reaches into another customer's account.
  it("never puts a subject of another tenant on a tunnel", async () => {
    const crossed = await embed("/tunnels", {
      method: "POST",
      body: { tenant: "acme", owner: "alice", access: ["carol"] },
    });
    expect(crossed.status).toBe(404);
    const { tunnel: made } = await newTunnel("acme", "alice");
    expect((await embed(`/tunnels/${made.id}/access/carol`, { method: "PUT" })).status).toBe(404);
    expect((await embed(`/tunnels/${made.id}/access/bob`, { method: "PUT" })).status).toBe(200);
    expect((await tunnel(made.id)).access?.toSorted()).toEqual(["alice", "bob"]);
    const removeOwner = await embed(`/tunnels/${made.id}/access/alice`, { method: "DELETE" });
    expect(removeOwner.status).toBe(409);
  });
});

describe("an agent opens its tunnel", () => {
  let made: Awaited<ReturnType<typeof newTunnel>>;
  let env: Record<string, string>;
  let opened: Awaited<ReturnType<typeof share>>;

  beforeAll(async () => {
    made = await newTunnel("acme", "alice");
    env = agentEnv(made.connector.connector);
  });

  it("at the tunnel's own host, with health and nothing from its pages", async () => {
    expect(made.tunnel.state).toBe("never");
    expect(made.connector.connector).toMatch(/^whc_/);
    expect(new URL(made.tunnel.url).hostname).toMatch(/^e[a-z0-9]{15}\./);
    opened = await share(stack, env, local.port);
    expect(opened.url).toBe(made.tunnel.url);
    const live = await tunnel(made.tunnel.id);
    expect(live).toMatchObject({ state: "live", tenant: "acme", owner: "alice" });
    expect(live.session?.id).toBe(opened.id);
    expect(JSON.stringify(live)).not.toMatch(/title|favicon/);
  });

  it("is not on the wall, nor in the org's pipes API", async () => {
    const wall = await api<{ shares: { id: string }[] }>(stack, owner, "/api/shares");
    expect(wall.body.shares.map((s) => s.id)).not.toContain(opened.id);
    const terminate = await api(stack, owner, `/api/shares/${opened.id}/terminate`, {
      method: "POST",
    });
    expect(terminate.status).toBe(404);
    const orgToken = (await createToken(stack, owner, "org", { scope: "org" })).token;
    const pipes = await browserFetch(`${apiHost}/v1/pipes`, {
      headers: { authorization: `Bearer ${orgToken}` },
    });
    const listed = (await pipes.json()) as { pipes: { id: string }[] };
    expect(listed.pipes.map((p) => p.id)).not.toContain(opened.id);
    const end = await browserFetch(`${apiHost}/v1/pipes/${opened.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${orgToken}` },
    });
    expect(end.status).toBe(404);
  });

  // Catches: an org member, the owner included, getting into a user's tunnel by default.
  it("opens to no member's sign-in and no access key", async () => {
    const page = await browserFetch(`${opened.url}/`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(page.status).toBe(401);
    expect(page.headers.get("location")).toBeNull();
    const open = await browserFetch(`${stack.url}/open?share=${opened.id}&next=%2F`, {
      cookie: owner.cookie,
    });
    expect(open.status).toBe(410);
    const keyed = await browserFetch(`${opened.url}/`, {
      headers: { "x-wurmhol-key": "k".repeat(40) },
    });
    expect(keyed.status).toBe(401);
  });

  // Catches: a CLI credential reaching billing, org management or another org API.
  it("lets its connector reach nothing but /connect", async () => {
    const bearer = { authorization: `Bearer ${made.connector.connector}` };
    for (const path of ["/v1/pipes", "/v1/embed/tunnels", "/api/me", "/api/billing", "/api/apps"]) {
      const response = await browserFetch(`${apiHost}${path}`, { headers: bearer });
      expect([401, 403, 404]).toContain(response.status);
    }
    expect(await handshake(`${apiHost}/host`, made.connector.connector)).toBe(401);
  });

  it("gives its name to no classic pipe", async () => {
    const name = new URL(opened.url).hostname.split(".")[0]!;
    const classic = cliEnv(stack, (await createToken(stack, owner, "classic")).token);
    envs.push(classic);
    const taken = await cli([String(local.port), "--name", name], classic);
    expect(taken.code).not.toBe(0);
    expect(taken.stderr).toContain("embedded tunnels");
  });

  it("reconnects to no other tunnel's session", async () => {
    const bobs = await newTunnel("acme", "bob");
    const bobOpened = await share(stack, agentEnv(bobs.connector.connector), local.port);
    const hijack = await handshake(
      `${stack.url}/connect?share=${bobOpened.id}`,
      made.connector.connector,
    );
    expect(hijack).not.toBe(101);
    expect(hijack).toBeGreaterThanOrEqual(400);
    expect((await tunnel(bobs.tunnel.id)).state).toBe("live");
  });

  it("stops at its integration's word, and opens again from the agent", async () => {
    const pid = pidOf(env, opened.id);
    expect((await embed(`/tunnels/${made.tunnel.id}/stop`, { method: "POST" })).status).toBe(200);
    await waitFor(() => !alive(pid), { what: "the agent to exit" });
    expect((await tunnel(made.tunnel.id)).state).toBe("stopped");
    const again = await share(stack, env, local.port);
    expect(again.url).toBe(made.tunnel.url);
    expect((await tunnel(made.tunnel.id)).state).toBe("live");
    opened = again;
  });

  it("ends when its connector is rotated, and the old one opens nothing", async () => {
    const pid = pidOf(env, opened.id);
    const rotated = await embed<{ connector: { connector: string } }>(
      `/tunnels/${made.tunnel.id}/connectors`,
      { method: "POST", body: { rotate: true } },
    );
    expect(rotated.status).toBe(201);
    await waitFor(() => !alive(pid), { what: "the agent to exit" });
    expect((await tunnel(made.tunnel.id)).lastEnd?.reason).toBe("revoked");
    const old = await cli([String(local.port)], env);
    expect(old.code).not.toBe(0);
    const fresh = await share(stack, agentEnv(rotated.body.connector.connector), local.port);
    expect(fresh.url).toBe(made.tunnel.url);
  });

  it("is gone for good once deleted", async () => {
    expect((await embed(`/tunnels/${made.tunnel.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await embed(`/tunnels/${made.tunnel.id}`)).status).toBe(404);
    await waitFor(async () => (await browserFetch(`${made.tunnel.url}/`)).status === 404, {
      what: "the session to end",
    });
  });
});

describe("integration keys", () => {
  it("do only what their permissions say", async () => {
    const reader = (await makeKey(owner, ["tunnels:read"])).key;
    expect((await embed("/tunnels", { token: reader })).status).toBe(200);
    const create = await embed("/tunnels", {
      token: reader,
      method: "POST",
      body: { tenant: "acme", owner: "alice" },
    });
    expect(create.status).toBe(403);
    expect((await embed("/tenants/x", { token: reader, method: "PUT", body: {} })).status).toBe(
      403,
    );
  });

  it("see no other application's tunnels", async () => {
    const { tunnel: made } = await newTunnel("acme", "alice");
    const stranger = await signIn(stack);
    const theirs = (await makeKey(stranger, ALL)).key;
    expect((await embed(`/tunnels/${made.id}`, { token: theirs })).status).toBe(404);
    expect(
      (await embed(`/tunnels/${made.id}/stop`, { token: theirs, method: "POST" })).status,
    ).toBe(404);
    const listed = await embed<{ tunnels: Tunnel[] }>("/tunnels", { token: theirs });
    expect(listed.body.tunnels).toEqual([]);
  });

  it("are refused once the application is deleted, which ends its tunnels", async () => {
    const { appId, key: doomed } = await makeKey(owner, ALL);
    await embed("/tenants/t1", { token: doomed, method: "PUT", body: {} });
    await embed("/tenants/t1/subjects/u1", {
      token: doomed,
      method: "PUT",
      body: { kind: "user" },
    });
    const made = await embed<{ tunnel: Tunnel; connector: { connector: string } }>("/tunnels", {
      token: doomed,
      method: "POST",
      body: { tenant: "t1", owner: "u1" },
    });
    const opened = await share(stack, agentEnv(made.body.connector.connector), local.port);
    expect((await api(stack, owner, `/api/apps/${appId}`, { method: "DELETE" })).status).toBe(200);
    expect((await embed("/tunnels", { token: doomed })).status).toBe(401);
    await waitFor(async () => (await browserFetch(`${opened.url}/`)).status === 404, {
      what: "the application's tunnel to end",
    });
  });
});

describe("operator takedown", () => {
  it("ends an embedded tunnel's session and revokes its connector", async () => {
    const made = await newTunnel("acme", "bob");
    const env = agentEnv(made.connector.connector);
    const opened = await share(stack, env, local.port);
    const done = await browserFetch(`${stack.url}/operator/takedown`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ pipe: new URL(opened.url).host }),
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { connectorRevoked: string; endedPipes: string[] };
    expect(body.connectorRevoked).toBe(made.connector.id);
    expect(body.endedPipes).toContain(opened.id);
    const again = await cli([String(local.port)], env);
    expect(again.code).not.toBe(0);
  });
});

describe("the console", () => {
  // Catches: the Apps link shown to someone who can't use it, or hidden from an owner who can.
  it("offers apps to owners, and to no member", async () => {
    const me = await api<{ apps: boolean; role: string }>(stack, owner, "/api/me");
    expect(me.body).toMatchObject({ apps: true, role: "owner" });
    const invite = await api<{ url: string }>(stack, owner, "/api/invites", { method: "POST" });
    const member = await signIn(stack);
    const code = invite.body.url.split("/join/")[1];
    await api(stack, member, `/api/invites/${code}/accept`, { method: "POST" });
    const theirs = await api<{ apps: boolean; role: string }>(stack, member, "/api/me");
    expect(theirs.body).toMatchObject({ apps: false, role: "member" });
    expect((await api(stack, member, "/api/apps")).status).toBe(403);
  });

  it("shows an app's pipes and usage, and stops and deletes them, never opens them", async () => {
    const { appId, key: appKey } = await makeKey(owner, ALL);
    const as = { token: appKey };
    await embed("/tenants/console", { ...as, method: "PUT", body: {} });
    await embed("/tenants/console/subjects/dana", { ...as, method: "PUT", body: { kind: "user" } });
    const made = await embed<{ tunnel: Tunnel; connector: { connector: string } }>("/tunnels", {
      ...as,
      method: "POST",
      body: { tenant: "console", owner: "dana" },
    });
    const env = agentEnv(made.body.connector.connector);
    const opened = await share(stack, env, local.port);

    const listed = await api<{ apps: { id: string; usage: { openTunnels: number } }[] }>(
      stack,
      owner,
      "/api/apps",
    );
    expect(listed.body.apps.find((app) => app.id === appId)?.usage.openTunnels).toBe(1);
    const tunnels = await api<{ tunnels: Tunnel[] }>(stack, owner, `/api/apps/${appId}/tunnels`);
    expect(tunnels.body.tunnels).toEqual([
      expect.objectContaining({
        id: made.body.tunnel.id,
        state: "live",
        tenant: "console",
        owner: "dana",
      }),
    ]);
    expect(JSON.stringify(tunnels.body)).not.toMatch(/title|favicon|whc_|whg_/);

    const pid = pidOf(env, opened.id);
    const stop = await api(stack, owner, `/api/apps/${appId}/tunnels/${made.body.tunnel.id}/stop`, {
      method: "POST",
    });
    expect(stop.status).toBe(200);
    await waitFor(() => !alive(pid), { what: "the agent to stop" });
    const stopped = await api<{ tunnels: Tunnel[] }>(stack, owner, `/api/apps/${appId}/tunnels`);
    expect(stopped.body.tunnels[0]?.state).toBe("stopped");

    const removed = await api(stack, owner, `/api/apps/${appId}/tunnels/${made.body.tunnel.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const after = await api<{ tunnels: Tunnel[] }>(stack, owner, `/api/apps/${appId}/tunnels`);
    expect(after.body.tunnels).toEqual([]);
    expect((await cli([String(local.port)], env)).code).not.toBe(0);
  });

  it("finds no other org's app's pipes", async () => {
    const { appId } = await makeKey(owner, ALL);
    const stranger = await signIn(stack);
    expect((await api(stack, stranger, `/api/apps/${appId}/tunnels`)).status).toBe(404);
  });
});
