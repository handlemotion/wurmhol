// Routing on a custom domain (ADR 0030): a verified hostname serves its pipe name's open pipe behind
// the same sign-in wall, signing in comes back to the host the viewer used, and a host that is not
// proven, or not known, is never the console and never a pipe.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openPipe } from "wurmhol";
import { fakeCloudflare, fakeResolver, TOKEN, ZONE } from "./domain-fakes.ts";
import {
  api,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
} from "./support.ts";

const OPERATOR_TOKEN = "e2e-operator-token-e2e-operator-token";
const navigate = { accept: "text/html", "sec-fetch-mode": "navigate" };

let stack: Stack;
let cloudflare: Awaited<ReturnType<typeof fakeCloudflare>>;
let resolver: Awaited<ReturnType<typeof fakeResolver>>;
let ada: Person;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;

beforeAll(async () => {
  cloudflare = await fakeCloudflare();
  resolver = await fakeResolver();
  stack = await startStack({
    CUSTOM_DOMAIN_TARGET: "domains.pipe.localhost",
    CLOUDFLARE_ZONE_ID: ZONE,
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_API_URL: cloudflare.url,
    DNS_RESOLVER_URL: resolver.url,
    OPERATOR_TOKEN,
  });
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  local = await localServer((req, res) => res.end(`host ${req.headers["x-forwarded-host"]}`));
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
  await cloudflare.close();
  await resolver.close();
});

const customUrl = (hostname: string) => `http://${hostname}:${stack.port}`;

/** Adds a domain and walks it through both proofs, as its owner would. */
async function activate(hostname: string, pipe: string) {
  const added = await api<{ domain: { dns: { value: string }[] } }>(stack, ada, "/api/domains", {
    method: "POST",
    body: { hostname, pipe },
  });
  expect(added.status).toBe(201);
  resolver.publish(`_wurmhol.${hostname}`, added.body.domain.dns[0]!.value);
  cloudflare.set(hostname, { status: "active", sslStatus: "active" });
  const verified = await api<{ domain: { state: string } }>(
    stack,
    ada,
    `/api/domains/${hostname}/verify`,
    { method: "POST" },
  );
  expect(verified.body.domain.state).toBe("active");
}

it("serves the name's pipe on the custom host, and signing in comes back to that host", async () => {
  await activate("preview.acme.localhost", "acme-app");
  const opened = await cli([String(local.port), "--name", "acme-app", "--json"], env);
  expect(opened.code).toBe(0);
  const pipe = JSON.parse(opened.stdout) as { id: string; url: string };
  // The pipe's URL is the custom domain: what the CLI prints and the wall shows.
  expect(pipe.url).toBe(customUrl("preview.acme.localhost"));

  const first = await browserFetch(`${customUrl("preview.acme.localhost")}/`, {
    headers: navigate,
  });
  expect(first.status).toBe(302);
  const open = new URL(first.headers.get("location")!);
  expect(`${open.origin}${open.pathname}`).toBe(`${stack.url}/open`);
  expect(open.searchParams.get("share")).toBe(pipe.id);
  expect(open.searchParams.get("host")).toBe("preview.acme.localhost");

  const back = await browserFetch(open.toString(), { cookie: ada.cookie });
  // Catches: sending the viewer to `<name>.<SHARE_DOMAIN>`, where the app they were using on their
  // own domain has no session, so every custom-domain sign-in would land on a different site.
  expect(back.headers.get("location")).toMatch(
    new RegExp(`^${customUrl("preview.acme.localhost")}/__wurmhol/auth\\?code=`),
  );
  const set = await browserFetch(back.headers.get("location")!);
  const cookie = set.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("__Host-wurmhol="))!;
  // The dev server is told the host the viewer used, so the redirect URIs it builds are the brand's.
  const page = await browserFetch(`${customUrl("preview.acme.localhost")}/`, { cookie });
  expect(await page.text()).toBe(`host preview.acme.localhost:${stack.port}`);

  // The pipe still answers on its own host, and there the dev server is told that host instead.
  const canonical = stack.shareUrl("acme-app");
  const canonicalCookie = await viewerCookie(stack, ada, canonical);
  expect(await (await browserFetch(`${canonical}/`, { cookie: canonicalCookie })).text()).toBe(
    `host acme-app.pipe.localhost:${stack.port}`,
  );

  // Catches: a crafted /open link carrying a host that is not the pipe's, which would hand the
  // one-time code to another site.
  const crafted = new URL(open);
  crafted.searchParams.set("host", "evil.localhost");
  const refused = await browserFetch(crafted.toString(), { cookie: ada.cookie });
  expect(refused.headers.get("location")).toMatch(
    new RegExp(`^${canonical}/__wurmhol/auth\\?code=`),
  );
});

it("does not serve a domain that is not proven, and never answers as the console", async () => {
  // The pipe is open, the domain is added, but the owner has not published the TXT record.
  const added = await api(stack, ada, "/api/domains", {
    method: "POST",
    body: { hostname: "unproven.acme.localhost", pipe: "acme-app" },
  });
  expect(added.status).toBe(201);
  cloudflare.set("unproven.acme.localhost", { status: "active", sslStatus: "active" });
  const unproven = await browserFetch(`${customUrl("unproven.acme.localhost")}/`, {
    headers: navigate,
  });
  expect(unproven.status).toBe(404);
  expect(await unproven.text()).toContain("not connected to a pipe");

  // Catches: a host the zone's `*/*` route sends here, with no domain behind it, falling through
  // to the app and serving the console on a name nobody configured.
  const stranger = await browserFetch(`${customUrl("nothing.acme.localhost")}/`, {
    headers: navigate,
  });
  expect(stranger.status).toBe(404);
  expect(await stranger.text()).not.toContain("<div id=");
  expect((await browserFetch(`${stack.url}/health`)).status).toBe(200);
});

it("stops serving the moment the domain is removed, by its org or by the operator", async () => {
  const gone = "preview.acme.localhost";
  const removed = await api(stack, ada, `/api/domains/${gone}`, { method: "DELETE" });
  expect(removed.status).toBe(200);
  const after = await browserFetch(`${customUrl(gone)}/`, { headers: navigate });
  expect(after.status).toBe(404);

  await activate("again.acme.localhost", "acme-app");
  const taken = await browserFetch(`${stack.url}/operator/domains/again.acme.localhost`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  expect(taken.status).toBe(200);
  expect(cloudflare.has("again.acme.localhost")).toBe(false);
  expect((await browserFetch(`${customUrl("again.acme.localhost")}/`)).status).toBe(404);
});

it("lets a client with the pipe's access key in on the custom host, and no one else (ADR 0028)", async () => {
  await activate("keyed.acme.localhost", "acme-key");
  const seen: string[] = [];
  const dev = await localServer((req, res) => {
    seen.push(Object.keys(req.headers).join(","));
    res.end("ok");
  });
  const accessKey = randomBytes(24).toString("hex");
  const pipe = await openPipe({
    port: dev.port,
    token: (await createToken(stack, ada, "sdk")).token,
    server: stack.url,
    name: "acme-key",
    accessKey,
  });
  try {
    const url = customUrl("keyed.acme.localhost");
    expect(pipe.url).toBe(url);
    const ok = await browserFetch(`${url}/`, { headers: { "x-wurmhol-key": accessKey } });
    expect(ok.status).toBe(200);
    // Catches: the key reaching the dev server, or a custom host that skips the key check.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/x-wurmhol|cookie/);
    expect(
      (await browserFetch(`${url}/`, { headers: { "x-wurmhol-key": `${accessKey}x` } })).status,
    ).toBe(401);
    expect((await browserFetch(`${url}/`)).status).toBe(401);
    expect(seen).toHaveLength(1);
  } finally {
    await pipe.close();
    await dev.close();
  }
});
