// `wurmhol domain` and the SDK's `domains()` client (ADR 0033): the same API as the console, from
// the shell, with the token an orchestrator holds.
import { afterAll, beforeAll, expect, it } from "vitest";
import { DomainError, domains } from "wurmhol";
import { fakeCloudflare, fakeResolver, TOKEN, ZONE } from "./domain-fakes.ts";
import {
  cli,
  cliEnv,
  createToken,
  localServer,
  shareStates,
  type Person,
  signIn,
  type Stack,
  startStack,
} from "./support.ts";

let stack: Stack;
let cloudflare: Awaited<ReturnType<typeof fakeCloudflare>>;
let resolver: Awaited<ReturnType<typeof fakeResolver>>;
let ada: Person;
let org: Record<string, string>;
let pipesOnly: Record<string, string>;

beforeAll(async () => {
  cloudflare = await fakeCloudflare();
  resolver = await fakeResolver();
  stack = await startStack({
    CUSTOM_DOMAIN_TARGET: "domains.pipe.localhost",
    CLOUDFLARE_ZONE_ID: ZONE,
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_API_URL: cloudflare.url,
    DNS_RESOLVER_URL: resolver.url,
  });
  ada = await signIn(stack);
  org = cliEnv(stack, (await createToken(stack, ada, "org", { scope: "org" })).token);
  pipesOnly = cliEnv(stack, (await createToken(stack, ada, "pipes")).token);
});

afterAll(async () => {
  await stack.stop();
  await cloudflare.close();
  await resolver.close();
});

interface Domain {
  hostname: string;
  state: string;
  dns: { type: string; name: string; value: string; done: boolean }[];
}

it("adds a domain, waits until its records are published, lists it and removes it", async () => {
  const added = await cli(
    ["domain", "add", "preview.acme-cli.test", "--name", "acme-cli", "--json"],
    org,
  );
  expect(added.code).toBe(0);
  const domain = JSON.parse(added.stdout) as Domain;
  expect(domain.state).toBe("pending");
  expect(domain.dns.map((r) => r.type)).toEqual(["TXT", "CNAME"]);

  // The owner publishes both records while `--wait` is looking.
  const waiting = cli(["domain", "verify", "preview.acme-cli.test", "--wait", "--json"], org);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  resolver.publish("_wurmhol.preview.acme-cli.test", domain.dns[0]!.value);
  cloudflare.set("preview.acme-cli.test", { status: "active", sslStatus: "active" });
  const verified = await waiting;
  expect(verified.code).toBe(0);
  expect((JSON.parse(verified.stdout) as Domain).state).toBe("active");

  // A pipe opened with the name now has the domain as its URL, and is still found by its name.
  const local = await localServer((_req, res) => res.end("ok"));
  try {
    const opened = await cli([String(local.port), "--name", "acme-cli", "--json"], pipesOnly);
    expect(opened.code).toBe(0);
    expect((JSON.parse(opened.stdout) as { url: string }).url).toBe(
      `http://preview.acme-cli.test:${stack.port}`,
    );
    // Catches: `stop <name>` matching the first label of the URL (`preview`) instead of the name.
    expect((await cli(["stop", "preview"], pipesOnly)).code).toBe(1);
    expect((await cli(["stop", "acme-cli"], pipesOnly)).code).toBe(0);
    expect(shareStates(pipesOnly)).toHaveLength(0);
  } finally {
    await local.close();
  }

  const listed = await cli(["domain", "ls", "--json"], org);
  expect(
    (JSON.parse(listed.stdout) as { domains: Domain[] }).domains.map((d) => d.hostname),
  ).toEqual(["preview.acme-cli.test"]);
  expect((await cli(["domain", "rm", "preview.acme-cli.test"], org)).code).toBe(0);
  expect(cloudflare.has("preview.acme-cli.test")).toBe(false);
});

it("says what to do instead when the token cannot manage the org", async () => {
  const refused = await cli(["domain", "ls"], pipesOnly);
  expect(refused.code).toBe(1);
  // Catches: a bare HTTP 403, which leaves an agent with a pipes-only token nowhere to go.
  expect(refused.stderr).toContain("Create one that can list and close every pipe");
});

it("tells a person which record is missing when time runs out", async () => {
  await cli(["domain", "add", "slow.acme-cli.test", "--name", "acme-cli"], org);
  // verify --wait gives up with the fix, not a state dump: the interval is the CLI's, so use the
  // one-shot form and read what is missing.
  const once = await cli(["domain", "verify", "slow.acme-cli.test"], org);
  expect(once.code).toBe(0);
  expect(once.stdout).toContain("publish  TXT   _wurmhol.slow.acme-cli.test");
  expect(once.stdout).toContain("publish  CNAME slow.acme-cli.test");
});

it("the SDK's waitActive keeps to its timeout and its signal", async () => {
  const client = domains({ token: org.WURMHOL_TOKEN!, server: stack.url });
  await client.add({ hostname: "patient.acme-cli.test", pipe: "acme-cli" });

  // Catches: a timeout shorter than the interval giving up after the first look, at once.
  const started = Date.now();
  const late = await client
    .waitActive("patient.acme-cli.test", { timeoutMs: 1500, intervalMs: 10_000 })
    .catch((error: unknown) => error);
  expect(late).toBeInstanceOf(DomainError);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  expect(Date.now() - started).toBeLessThan(10_000);

  // Catches: an aborted wait that still looks, and can report success after its caller gave up.
  const reason = new Error("stopped by the caller");
  const aborted = new AbortController();
  aborted.abort(reason);
  resolver.publish(
    "_wurmhol.patient.acme-cli.test",
    (await client.get("patient.acme-cli.test")).dns[0]!.value,
  );
  cloudflare.set("patient.acme-cli.test", { status: "active", sslStatus: "active" });
  await expect(client.waitActive("patient.acme-cli.test", { signal: aborted.signal })).rejects.toBe(
    reason,
  );
  expect((await client.get("patient.acme-cli.test")).state).toBe("pending");
});
