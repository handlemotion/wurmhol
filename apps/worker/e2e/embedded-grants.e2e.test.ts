// Grants (ADR 0032, step 5) on the real stack with the real CLI: a subject reaches an embedded
// tunnel only with a grant the SaaS's backend issued for it, over HTTP, a browser's launch and
// cookie, a WebSocket's header or a page's subprotocol. A grant opens one tunnel for one subject
// on its list; revoking it stops HTTP at once and closes open WebSockets with 4403; expiry
// closes them with 4401; and nothing about a grant reaches the dev server.
import type { IncomingHttpHeaders } from "node:http";
import { GRANT_PROTOCOL, grantProtocols } from "@wurmhol/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import {
  api,
  type ApiResult,
  browserFetch,
  browserSocket,
  cliEnv,
  cookiesOf,
  type JsonValue,
  localServer,
  parseJson,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  waitFor,
} from "./support.ts";

const ALL = ["tunnels:read", "tunnels:manage", "subjects:manage", "grants:issue"];
const LAUNCH = "https://app.dorks.example/wurmhol/launch";
const PAGE_ORIGIN = "https://app.dorks.example";

const issuedGrant = z.object({
  grant: z.object({
    id: z.string(),
    token: z.string().optional(),
    launchUrl: z.string().optional(),
  }),
});

const openedTunnel = z.object({
  tunnel: z.object({ id: z.string(), url: z.string() }),
  connector: z.object({ connector: z.string() }),
});

let stack: Stack;
let apiHost: string;
let owner: Person;
let key: string;
const envs: Record<string, string>[] = [];

/** What the dev server last saw: headers of HTTP requests and of WebSocket handshakes. */
const seen = { http: new Array<IncomingHttpHeaders>(), ws: new Array<IncomingHttpHeaders>() };
let local: Awaited<ReturnType<typeof localServer>>;

/** The subprotocol the dev server picks, from those offered; null picks none. */
let pick: string | null = null;

interface EmbedInit {
  method?: string;
  body?: JsonValue;
  token?: string;
}

/**
 * A bearer call to `/v1/embed…` on the CLI's host. The body is decoded with `schema` (an empty
 * body is `null`); without one it is any JSON value.
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
  const authorization = `Bearer ${init.token ?? key}`;

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

/** A grant's optional terms: its lifetime, and where a browser's launch lands. */
interface GrantTerms {
  ttlSeconds?: number;
  next?: string;
}

async function grant(
  tunnel: string,
  subject: string,
  kind: "client" | "browser",
  terms: GrantTerms = {},
) {
  const made = await embed("/grants", {
    method: "POST",
    body: { tunnel, subject, kind, ...terms },
  });

  expect(made.status).toBe(201);

  return issuedGrant.parse(made.body).grant;
}

async function openTunnel(tenant: string, owner: string, access: string[] = []) {
  const made = await embed("/tunnels", { method: "POST", body: { tenant, owner, access } });
  expect(made.status).toBe(201);
  const { tunnel, connector } = openedTunnel.parse(made.body);
  const env = cliEnv(stack, connector.connector);
  envs.push(env);
  await share(stack, env, local.port);

  return tunnel;
}

/** Opens a WebSocket and resolves once it is open, or with the refusal's status. */
function connect(url: string, protocols: string[], headers: Record<string, string>) {
  return new Promise<{ socket: WebSocket; status: 101 } | { status: number }>((resolve) => {
    const socket = browserSocket(url, protocols, headers);
    socket.on("open", () => resolve({ socket, status: 101 }));
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    socket.on("error", () => resolve({ status: 0 }));
  });
}

/** The socket of a handshake that opened; a refused one fails the test with its status. */
function socketOf(opened: Awaited<ReturnType<typeof connect>>) {
  if (!("socket" in opened)) throw new Error(`the WebSocket was refused: ${opened.status}`);

  return opened.socket;
}

function closed(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

let alice: { id: string; url: string };
let bobs: { id: string; url: string };

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "api.localhost", EMBEDDED_ENABLED: "true" });
  apiHost = `http://api.localhost:${stack.port}`;
  owner = await signIn(stack);

  const app = await api(
    stack,
    owner,
    "/api/apps",
    {
      method: "POST",
      body: { name: "Dorks", launchUrl: LAUNCH, allowedOrigins: [PAGE_ORIGIN] },
    },
    z.object({ app: z.object({ id: z.string() }) }),
  );

  key = (
    await api(
      stack,
      owner,
      `/api/apps/${app.body.app.id}/keys`,
      { method: "POST", body: { name: "backend", permissions: ALL } },
      z.object({ key: z.string() }),
    )
  ).body.key;

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => (pick && offered.has(pick) ? pick : false),
  });

  local = await localServer((req, res) => {
    seen.http.push(req.headers);
    res.end("ok");
  });
  local.server.on("upgrade", (req, socket, head) => {
    seen.ws.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(data)));
  });

  for (const [tenant, subject] of [
    ["acme", "alice"],
    ["acme", "bob"],
    ["acme", "dana"],
    ["globex", "carol"],
  ] as const) {
    await embed(`/tenants/${tenant}`, { method: "PUT", body: {} });
    await embed(`/tenants/${tenant}/subjects/${subject}`, {
      method: "PUT",
      body: { kind: "user" },
    });
  }

  alice = await openTunnel("acme", "alice", ["dana"]);
  bobs = await openTunnel("acme", "bob");
});

afterAll(async () => {
  for (const env of envs) await stopAll(env);
  await local.close();
  await stack.stop();
});

describe("a program's grant", () => {
  it("opens its subject's tunnel, and the dev server never sees it", async () => {
    const { token } = await grant(alice.id, "alice", "client");
    expect(token).toMatch(/^whg_/);
    seen.http.length = 0;

    const response = await browserFetch(`${alice.url}/`, {
      headers: { "x-wurmhol-grant": token! },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(JSON.stringify(seen.http)).not.toContain(token!);
    expect(seen.http[0]).not.toHaveProperty("x-wurmhol-grant");
  });

  // Catches: Alice opening Bob's tunnel, or the backend granting past a tunnel's list.
  it("opens no other tunnel, and is never issued past the list or the tenant", async () => {
    const { token } = await grant(alice.id, "alice", "client");
    const crossed = await browserFetch(`${bobs.url}/`, { headers: { "x-wurmhol-grant": token! } });
    expect(crossed.status).toBe(401);

    const notListed = await embed("/grants", {
      method: "POST",
      body: { tunnel: bobs.id, subject: "alice", kind: "client" },
    });

    expect(notListed.status).toBe(403);

    const otherTenant = await embed("/grants", {
      method: "POST",
      body: { tunnel: alice.id, subject: "carol", kind: "client" },
    });

    expect(otherTenant.status).toBe(403);
  });

  it("is refused once revoked, at the next request", async () => {
    const issued = await grant(alice.id, "alice", "client");
    const headers = { "x-wurmhol-grant": issued.token! };
    expect((await browserFetch(`${alice.url}/`, { headers })).status).toBe(200);
    expect((await embed(`/grants/${issued.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await browserFetch(`${alice.url}/`, { headers })).status).toBe(401);
  });

  it("is refused once its subject is off the list", async () => {
    const { token } = await grant(alice.id, "dana", "client");
    const headers = { "x-wurmhol-grant": token! };
    expect((await browserFetch(`${alice.url}/`, { headers })).status).toBe(200);
    const removed = await embed(`/tunnels/${alice.id}/access/dana`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await browserFetch(`${alice.url}/`, { headers })).status).toBe(401);
    await embed(`/tunnels/${alice.id}/access/dana`, { method: "PUT" });
  });
});

describe("a WebSocket's grant", () => {
  it("closes with 4403 the moment it is revoked", async () => {
    const issued = await grant(alice.id, "alice", "client");
    const opened = await connect(`${alice.url}/ws`, [], { "x-wurmhol-grant": issued.token! });
    expect(opened.status).toBe(101);
    const socket = socketOf(opened);
    const echoed = new Promise((resolve) => socket.once("message", resolve));
    socket.send("hi");
    expect(String(await echoed)).toBe("hi");
    const end = closed(socket);
    const revokedAt = Date.now();
    await embed(`/grants/${issued.id}`, { method: "DELETE" });
    expect(await end).toEqual({ code: 4403, reason: "grant revoked" });
    // At once, by the revocation's push: not at the next minute's recheck.
    expect(Date.now() - revokedAt).toBeLessThan(10_000);
  });

  it("closes with 4401 when it expires", { timeout: 120_000 }, async () => {
    const issued = await grant(alice.id, "alice", "client", { ttlSeconds: 60 });
    const opened = await connect(`${alice.url}/ws`, [], { "x-wurmhol-grant": issued.token! });
    expect(opened.status).toBe(101);
    const end = await closed(socketOf(opened));
    expect(end).toEqual({ code: 4401, reason: "grant expired" });
  });

  // Catches: the grant token reaching the dev server in the subprotocol list, the app's own
  // protocols lost, or a browser failing a handshake whose protocols got no answer.
  it("comes as a page's subprotocol from an allowed origin, and stays with the relay", async () => {
    const { token } = await grant(alice.id, "alice", "client");
    seen.ws.length = 0;
    pick = "chat";

    const chat = await connect(`${alice.url}/ws`, grantProtocols(token!, ["chat"]), {
      origin: PAGE_ORIGIN,
    });

    expect(chat.status).toBe(101);
    const chatSocket = socketOf(chat);
    expect(chatSocket.protocol).toBe("chat");
    chatSocket.close();
    expect(JSON.stringify(seen.ws)).not.toContain(token!);
    expect(seen.ws[0]?.["sec-websocket-protocol"]).toBe("chat");

    pick = null;
    const none = await connect(`${alice.url}/ws`, grantProtocols(token!), { origin: PAGE_ORIGIN });
    expect(none.status).toBe(101);
    const noneSocket = socketOf(none);
    expect(noneSocket.protocol).toBe(GRANT_PROTOCOL);
    noneSocket.close();
  });

  it("is refused as a subprotocol from any other origin", async () => {
    const { token } = await grant(alice.id, "alice", "client");

    const elsewhere = await connect(`${alice.url}/ws`, grantProtocols(token!), {
      origin: "https://evil.example",
    });

    expect(elsewhere.status).toBe(401);
  });
});

describe("a browser's grant", () => {
  it("launches once into a cookie that opens the tunnel and stays with the relay", async () => {
    const issued = await grant(alice.id, "alice", "browser", { next: "/inbox?x=1" });
    expect(issued.launchUrl).toContain(`${alice.url}/__wurmhol/launch?code=`);
    const launched = await browserFetch(issued.launchUrl!);
    expect(launched.status).toBe(302);
    expect(launched.headers.get("location")).toBe("/inbox?x=1");
    const cookie = cookiesOf(launched).find((c) => c.startsWith("__Host-wurmhol="))!;
    expect(cookie).toBeTruthy();
    seen.http.length = 0;
    const page = await browserFetch(`${alice.url}/inbox?x=1`, { cookie });
    expect(page.status).toBe(200);
    expect(seen.http[0]?.cookie ?? "").not.toContain("__Host-wurmhol");
    expect((await browserFetch(issued.launchUrl!)).status).toBe(400);
    // The cookie names Alice's tunnel: it opens nothing on Bob's.
    expect((await browserFetch(`${bobs.url}/`, { cookie })).status).toBe(401);
  });

  it("is sent to the application's launch URL without a grant", async () => {
    const page = await browserFetch(`${alice.url}/inbox`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });

    expect(page.status).toBe(302);
    const location = new URL(page.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(LAUNCH);
    expect(location.searchParams.get("tunnel")).toBe(alice.id);
    expect(location.searchParams.get("next")).toBe("/inbox");
    const fetched = await browserFetch(`${alice.url}/inbox`);
    expect(fetched.status).toBe(401);
  });

  // Catches: an org member, the owner included, reaching a user's tunnel with their own sign-in.
  it("is not something an org owner's session stands in for", async () => {
    const page = await browserFetch(`${alice.url}/`, { cookie: owner.cookie });
    expect(page.status).toBe(401);
  });

  it("stops once revoked, sending the page back to launch", async () => {
    const issued = await grant(alice.id, "alice", "browser");

    const cookie = cookiesOf(await browserFetch(issued.launchUrl!)).find((c) =>
      c.startsWith("__Host-wurmhol="),
    )!;

    expect((await browserFetch(`${alice.url}/`, { cookie })).status).toBe(200);
    await embed(`/grants/${issued.id}`, { method: "DELETE" });

    const after = await browserFetch(`${alice.url}/`, {
      cookie,
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });

    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toContain(LAUNCH);
  });
});

describe("issuing", () => {
  it("needs grants:issue, and is logged", async () => {
    const app = await api(
      stack,
      owner,
      "/api/apps",
      {},
      z.object({ apps: z.array(z.object({ id: z.string() })) }),
    );

    const reader = await api(
      stack,
      owner,
      `/api/apps/${app.body.apps[0]!.id}/keys`,
      { method: "POST", body: { name: "reader", permissions: ["tunnels:read"] } },
      z.object({ key: z.string() }),
    );

    const refused = await embed("/grants", {
      token: reader.body.key,
      method: "POST",
      body: { tunnel: alice.id, subject: "alice", kind: "client" },
    });

    expect(refused.status).toBe(403);

    // Loose throughout: the whole log is searched for grant secrets.
    const log = await embed(
      `/tunnels/${alice.id}/grants`,
      {},
      z.looseObject({
        events: z.array(z.looseObject({ event: z.string(), subject: z.string().optional() })),
      }),
    );

    expect(log.body.events.some((e) => e.event === "issued" && e.subject === "alice")).toBe(true);
    expect(log.body.events.some((e) => e.event === "revoked")).toBe(true);
    expect(JSON.stringify(log.body)).not.toMatch(/whg_|code=/);
  });

  it("refuses a lifetime past 24 hours", async () => {
    const tooLong = await embed("/grants", {
      method: "POST",
      body: { tunnel: alice.id, subject: "alice", kind: "client", ttlSeconds: 86_401 },
    });

    expect(tooLong.status).toBe(400);
  });

  it("keeps no grant past its subject being disabled", async () => {
    const { token } = await grant(alice.id, "dana", "client");
    const headers = { "x-wurmhol-grant": token! };
    expect((await browserFetch(`${alice.url}/`, { headers })).status).toBe(200);
    await embed("/tenants/acme/subjects/dana", {
      method: "PUT",
      body: { kind: "user", disabled: true },
    });
    await waitFor(async () => (await browserFetch(`${alice.url}/`, { headers })).status === 401, {
      what: "the disabled subject's grant to stop",
    });
  });
});

describe("retention", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Runs the Worker's daily cron as if it fired at `at` (Miniflare's trigger endpoint). */
  async function runRetention(at: number) {
    const response = await fetch(`${stack.url}/cdn-cgi/local/scheduled?cron=17+3+*+*+*&time=${at}`);
    expect(response.status).toBe(200);
  }

  function count(sql: string, ...params: string[]) {
    const db = stack.db();

    try {
      return z.object({ n: z.number() }).parse(db.prepare(sql).get(...params)).n;
    } finally {
      db.close();
    }
  }

  // Catches: who was let into which tunnel kept forever, past the history it explains.
  it("deletes grants and their log 90 days after they ended, like pipe history", async () => {
    const issued = await grant(alice.id, "alice", "client");
    await embed(`/grants/${issued.id}`, { method: "DELETE" });

    const left = () => ({
      grants: count("select count(*) as n from embed_grants where id = ?", issued.id),
      events: count("select count(*) as n from embed_grant_events where grant_id = ?", issued.id),
    });

    expect(left()).toEqual({ grants: 1, events: 2 });
    await runRetention(Date.now() + 89 * DAY_MS);
    expect(left()).toEqual({ grants: 1, events: 2 });
    await runRetention(Date.now() + 91 * DAY_MS);
    expect(left()).toEqual({ grants: 0, events: 0 });
    // The tunnel and its subjects stay: they belong to the application, not to a grant.
    expect(count("select count(*) as n from embed_tunnels where id = ?", alice.id)).toBe(1);
  });
});
