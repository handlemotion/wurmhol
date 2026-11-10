// Custom domains (ADR 0030): adding a hostname to a pipe name, the two proofs it needs before it is
// routed, and what moves it back out. The Worker runs for real (workerd, D1, the real routes); the
// two services it calls out to are local HTTP servers speaking their real wire shapes: Cloudflare's
// custom hostnames API and a DNS-over-HTTPS JSON resolver, because no test may create real
// hostnames or publish real DNS records.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
  browserFetch,
  createToken,
  type Person,
  signIn,
  type Stack,
  startStack,
} from "./support.ts";

const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-e2e-token";

interface Hostname {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
}

/** Cloudflare's custom hostnames API, as much of it as the Worker calls. */
async function fakeCloudflare() {
  const hostnames = new Map<string, Hostname>();
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      });
    }
    const match = new RegExp(`^/client/v4/zones/${ZONE}/custom_hostnames(?:/([^/]+))?$`).exec(
      url.pathname,
    );
    if (!match) return send(404, { success: false, errors: [{ message: "no route" }] });
    const id = match[1];
    const shape = (h: Hostname) => ({
      id: h.id,
      hostname: h.hostname,
      status: h.status,
      ssl: { status: h.sslStatus },
      verification_errors:
        h.status === "pending" ? ["custom hostname does not CNAME to this zone."] : [],
    });
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      calls.push(`${req.method} ${id ? "/:id" : ""}`);
      if (req.method === "POST" && !id) {
        const input = JSON.parse(body) as { hostname: string; ssl: { method: string } };
        if (input.ssl.method !== "http")
          return send(400, { success: false, errors: [{ message: "bad method" }] });
        if (hostnames.has(input.hostname)) {
          return send(400, {
            success: false,
            errors: [{ code: 1406, message: "Duplicate custom hostname found." }],
          });
        }
        const made = {
          id: crypto.randomUUID(),
          hostname: input.hostname,
          status: "pending",
          sslStatus: "pending_validation",
        };
        hostnames.set(input.hostname, made);
        return send(200, { success: true, result: shape(made) });
      }
      if (req.method === "GET" && !id) {
        const found = [...hostnames.values()].filter(
          (h) => h.hostname === url.searchParams.get("hostname"),
        );
        return send(200, { success: true, result: found.map(shape) });
      }
      const found = [...hostnames.values()].find((h) => h.id === id);
      if (!found) return send(404, { success: false, errors: [{ message: "not found" }] });
      if (req.method === "DELETE") {
        hostnames.delete(found.hostname);
        return send(200, { success: true, result: { id: found.id } });
      }
      return send(200, { success: true, result: shape(found) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
    has: (hostname: string) => hostnames.has(hostname),
    calls,
    /** What the customer's DNS and Cloudflare's validation would do. */
    set(hostname: string, state: Partial<Pick<Hostname, "status" | "sslStatus">>) {
      Object.assign(hostnames.get(hostname)!, state);
    },
    close: () => stop(server),
  };
}

/** A DNS-over-HTTPS JSON resolver that answers from a table. */
async function fakeResolver() {
  const records = new Map<string, string[]>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const values = records.get(url.searchParams.get("name") ?? "");
    res.writeHead(200, { "content-type": "application/dns-json" });
    res.end(
      JSON.stringify({
        Status: values ? 0 : 3,
        Answer: (values ?? []).map((v) => ({ type: 16, data: `"${v}"` })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dns-query`,
    publish: (name: string, value: string) => records.set(name, [value]),
    unpublish: (name: string) => records.delete(name),
    close: () => stop(server),
  };
}

function stop(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

interface Domain {
  hostname: string;
  pipe: string;
  state: "pending" | "verifying" | "active" | "failed";
  url: string | null;
  dns: { type: string; name: string; value: string; purpose: string; done: boolean }[];
  error: { code: string; message: string; fix: string } | null;
}

let stack: Stack;
let cloudflare: Awaited<ReturnType<typeof fakeCloudflare>>;
let resolver: Awaited<ReturnType<typeof fakeResolver>>;
let ada: Person;
let bea: Person;

beforeAll(async () => {
  cloudflare = await fakeCloudflare();
  resolver = await fakeResolver();
  stack = await startStack({
    CONNECT_HOST: "api.localhost",
    CUSTOM_DOMAIN_TARGET: "domains.pipe.localhost",
    CLOUDFLARE_ZONE_ID: ZONE,
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_API_URL: cloudflare.url,
    DNS_RESOLVER_URL: resolver.url,
    LIMIT_CUSTOM_DOMAINS: "3",
  });
  ada = await signIn(stack);
  bea = await signIn(stack);
});

afterAll(async () => {
  await stack.stop();
  await cloudflare.close();
  await resolver.close();
});

const add = (person: Person, hostname: string, pipe: string) =>
  api<{ domain?: Domain; error?: string; code?: string }>(stack, person, "/api/domains", {
    method: "POST",
    body: { hostname, pipe },
  });
const verify = (person: Person, hostname: string) =>
  api<{ domain?: Domain; code?: string }>(stack, person, `/api/domains/${hostname}/verify`, {
    method: "POST",
  });
const read = async (person: Person, hostname: string) =>
  (await api<{ domain: Domain }>(stack, person, `/api/domains/${hostname}`)).body.domain;

it("adds a domain with the two records to publish, and returns the same one when asked again", async () => {
  const first = await add(ada, "Preview.Acme-One.test", "acme-one");
  expect(first.status).toBe(201);
  const domain = first.body.domain!;
  expect(domain).toMatchObject({
    hostname: "preview.acme-one.test",
    pipe: "acme-one",
    state: "pending",
    url: null,
  });
  expect(domain.dns).toEqual([
    {
      type: "TXT",
      name: "_wurmhol.preview.acme-one.test",
      value: expect.stringMatching(/^wurmhol-verify=[0-9a-f]{48}$/),
      purpose: "ownership",
      done: false,
    },
    {
      type: "CNAME",
      name: "preview.acme-one.test",
      value: "domains.pipe.localhost",
      purpose: "traffic",
      done: false,
    },
  ]);
  expect(cloudflare.has("preview.acme-one.test")).toBe(true);

  const again = await add(ada, "preview.acme-one.test", "acme-one");
  expect(again.body.domain!.dns[0]!.value).toBe(domain.dns[0]!.value);
});

it("refuses a hostname or pipe name another org has, and a host the install serves", async () => {
  // Catches: one org's claim of a hostname or name silently shadowing another org's.
  expect((await add(bea, "preview.acme-one.test", "bea-pipe")).body.code).toBe("hostname_taken");
  expect((await add(bea, "other.acme-one.test", "acme-one")).body.code).toBe("pipe_taken");
  // Catches: a customer domain that is the console or a pipe host of the install itself.
  for (const host of [
    `foo.pipe.localhost`,
    "domains.pipe.localhost",
    "api.localhost",
    "10.0.0.1",
  ]) {
    const refused = await add(bea, host, "bea-pipe");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.domain).toBeUndefined();
  }
  expect((await add(bea, "x.example.test", "domains")).body.code).toBe("pipe_reserved");
});

it("never routes on Cloudflare's word alone: a CNAME left behind is not ownership", async () => {
  const hostname = "old.acme-one.test";
  await add(ada, hostname, "acme-one");
  // Cloudflare sees the CNAME to the target and the certificate issues. The TXT record is missing.
  cloudflare.set(hostname, { status: "active", sslStatus: "active" });
  const checked = await verify(ada, hostname);
  // Catches: the takeover of a name its owner abandoned: any org could claim it and serve there.
  expect(checked.body.domain!.state).toBe("pending");
  expect(checked.body.domain!.url).toBeNull();

  const domain = await read(ada, hostname);
  resolver.publish(`_wurmhol.${hostname}`, domain.dns[0]!.value);
  const proven = await verify(ada, hostname);
  expect(proven.body.domain).toMatchObject({
    state: "active",
    url: `http://${hostname}:${stack.port}`,
  });
  expect(proven.body.domain!.dns.map((r) => r.done)).toEqual([true, true]);
});

it("stops routing when the CNAME goes away, which the daily job notices", async () => {
  const hostname = "old.acme-one.test";
  expect((await read(ada, hostname)).state).toBe("active");
  cloudflare.set(hostname, { status: "moved" });
  expect((await browserFetch(`${stack.url}/cdn-cgi/local/scheduled`)).ok).toBe(true);
  const after = await read(ada, hostname);
  expect(after.state).toBe("verifying");
  // The TXT proof stays proven, so the CNAME coming back is enough.
  cloudflare.set(hostname, { status: "active" });
  expect((await verify(ada, hostname)).body.domain!.state).toBe("active");
});

it("expires a domain that was never finished and frees its Cloudflare hostname", async () => {
  const hostname = "late.acme-one.test";
  await add(ada, hostname, "acme-one");
  const db = stack.db({ write: true });
  try {
    db.prepare("update custom_domains set expires_at = ? where hostname = ?").run(
      Date.now() - 1000,
      hostname,
    );
  } finally {
    db.close();
  }
  const expired = await verify(ada, hostname);
  expect(expired.body.domain).toMatchObject({ state: "failed", error: { code: "expired" } });
  expect(cloudflare.has(hostname)).toBe(false);
});

it("limits domains per org, and removing is idempotent and clears Cloudflare", async () => {
  // ada holds three (preview, old, late); the limit is 3.
  const over = await add(ada, "fourth.acme-one.test", "acme-one");
  expect(over.status).toBe(403);
  expect(over.body.code).toBe("domain_limit");

  const removed = await api(stack, ada, "/api/domains/late.acme-one.test", { method: "DELETE" });
  expect(removed.status).toBe(200);
  expect(
    (await api(stack, ada, "/api/domains/late.acme-one.test", { method: "DELETE" })).status,
  ).toBe(200);
  // Catches: an org that cannot free the hostname it no longer wants, which another then cannot take.
  expect((await add(bea, "late.acme-one.test", "bea-pipe")).status).toBe(201);
  // Another org's hostname does not exist for you.
  expect((await api(stack, ada, "/api/domains/late.acme-one.test")).status).toBe(404);
});

it("answers on the CLI's host to an org token, and not to a pipes token", async () => {
  const host = `http://api.localhost:${stack.port}`;
  const org = await createToken(stack, ada, "orgs", { scope: "org" });
  const pipes = await createToken(stack, ada, "pipes");
  const listed = await browserFetch(`${host}/v1/domains`, {
    headers: { authorization: `Bearer ${org.token}` },
  });
  expect(listed.status).toBe(200);
  const hostnames = ((await listed.json()) as { domains: Domain[] }).domains.map((d) => d.hostname);
  expect(hostnames).toContain("preview.acme-one.test");
  const refused = await browserFetch(`${host}/v1/domains`, {
    headers: { authorization: `Bearer ${pipes.token}` },
  });
  expect(refused.status).toBe(403);
});

it("is off unless configured: every call says so, and nothing else changes", async () => {
  const plain = await startStack();
  try {
    const person = await signIn(plain);
    const answer = await api<{ code?: string }>(plain, person, "/api/domains");
    // Catches: a self-hosted install that never set up Cloudflare for SaaS reaching for it anyway.
    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe("custom_domains_off");
  } finally {
    await plain.stop();
  }
});
