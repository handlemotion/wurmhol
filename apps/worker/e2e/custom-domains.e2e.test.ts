// Custom domains (ADR 0033): adding a hostname to a pipe name, the two proofs it needs before it is
// routed, and what moves it back out. The Worker runs for real (workerd, D1, the real routes); the
// two services it calls out to are local HTTP servers speaking their real wire shapes: Cloudflare's
// custom hostnames API and a DNS-over-HTTPS JSON resolver, because no test may create real
// hostnames or publish real DNS records.
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
import { fakeCloudflare, fakeResolver, TOKEN, ZONE } from "./domain-fakes.ts";

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

it("frees the Cloudflare hostname of a domain Cloudflare refuses", async () => {
  const carl = await signIn(stack);
  const hostname = "blocked.carl.test";
  const added = (await add(carl, hostname, "carl-app")).body.domain!;
  resolver.publish(`_wurmhol.${hostname}`, added.dns[0]!.value);
  cloudflare.set(hostname, { status: "blocked" });
  const failed = await verify(carl, hostname);
  expect(failed.body.domain).toMatchObject({
    state: "failed",
    error: { code: "hostname_blocked" },
  });
  // Catches: a failed domain that is never checked again keeping a billed hostname for good.
  expect(cloudflare.has(hostname)).toBe(false);
});

it("holds the limit when adds arrive together, and a refused add keeps no pipe name", async () => {
  const dana = await signIn(stack);
  const hosts = ["a", "b", "c", "d", "e", "f"].map((label) => `${label}.dana.test`);
  const answers = await Promise.all(hosts.map((host) => add(dana, host, "dana-app")));
  // Catches: concurrent adds that all read the count below the limit and all get a domain. Adds
  // that overlap may all back out, so fewer than three can pass; never more.
  const passed = answers.filter((answer) => answer.status === 201).length;
  expect(passed).toBeLessThanOrEqual(3);
  expect(answers.every((a) => a.status === 201 || a.body.code === "domain_limit")).toBe(true);
  const count = async () =>
    (await api<{ domains: Domain[] }>(stack, dana, "/api/domains")).body.domains.length;
  expect(await count()).toBe(passed);
  // The ones that backed out left nothing at Cloudflare.
  expect(hosts.filter((host) => cloudflare.has(host))).toHaveLength(passed);
  for (const host of hosts.slice(0, 3 - passed).map((h) => `again-${h}`)) {
    expect((await add(dana, host, "dana-app")).status).toBe(201);
  }
  expect(await count()).toBe(3);

  // Catches: a refused add that still reserved a fresh pipe name for the org, for good.
  expect((await add(dana, "g.dana.test", "dana-spare")).body.code).toBe("domain_limit");
  expect((await add(dana, "preview.acme-one.test", "dana-other")).body.code).toBe("hostname_taken");
  const erin = await signIn(stack);
  expect((await add(erin, "spare.erin.test", "dana-spare")).status).toBe(201);
  expect((await add(erin, "other.erin.test", "dana-other")).status).toBe(201);
});

it("moves a domain whose check fails to the back of the daily job's queue", async () => {
  const fay = await signIn(stack);
  const hostname = "servfail.fay.test";
  await add(fay, hostname, "fay-app");
  resolver.fail(`_wurmhol.${hostname}`);
  const checkedAt = () => {
    const db = stack.db();
    try {
      return (
        db
          .prepare("select checked_at as at from custom_domains where hostname = ?")
          .get(hostname) as {
          at: number;
        }
      ).at;
    } finally {
      db.close();
    }
  };
  const before = checkedAt();
  expect((await browserFetch(`${stack.url}/cdn-cgi/local/scheduled`)).ok).toBe(true);
  // Catches: a domain whose DNS keeps failing staying the oldest checked, so the daily job's batch
  // fills with the same failures and never reaches the rest.
  expect(checkedAt()).toBeGreaterThan(before);
});

it("deleting an org takes its domains out of Cloudflare, and waits while Cloudflare is down", async () => {
  const gus = await signIn(stack);
  const hal = await signIn(stack);
  const gusOrg = (await api<{ activeOrgId: string }>(stack, gus, "/api/me")).body.activeOrgId;
  // Gus joins Hal's org, so his own is not his only one, then goes back to his own.
  const invite = await api<{ url: string }>(stack, hal, "/api/invites", { method: "POST" });
  const code = invite.body.url.split("/join/")[1]!;
  expect((await api(stack, gus, `/api/invites/${code}/accept`, { method: "POST" })).status).toBe(
    200,
  );
  await api(stack, gus, "/api/auth/organization/set-active", {
    method: "POST",
    body: { organizationId: gusOrg },
  });
  const hostname = "brand.gus.test";
  expect((await add(gus, hostname, "gus-app")).status).toBe(201);

  cloudflare.setDown(true);
  try {
    const refused = await api(stack, gus, "/api/org", { method: "DELETE" });
    // Catches: the org's rows going while Cloudflare keeps its billed hostnames, with nothing
    // left to find them by.
    expect(refused.status).toBe(502);
    expect(cloudflare.has(hostname)).toBe(true);
  } finally {
    cloudflare.setDown(false);
  }
  expect((await api(stack, gus, "/api/org", { method: "DELETE" })).status).toBe(200);
  expect(cloudflare.has(hostname)).toBe(false);
});
