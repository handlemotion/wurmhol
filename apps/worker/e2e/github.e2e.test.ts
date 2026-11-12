// Pull request previews through a GitHub App (ADR 0016), on the real stack. Off by default:
// nothing changes and nothing talks to GitHub. With an App configured, the webhook takes only
// signed calls and linking an installation takes only the state made for that person.
// The calls to GitHub itself need a real App and are not exercised here.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  api,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  parseJson,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
} from "./support.ts";

const WEBHOOK_SECRET = "e2e-webhook-secret";
let plain: Stack;
let withApp: Stack;
let local: Awaited<ReturnType<typeof localServer>>;

beforeAll(async () => {
  [plain, withApp] = await Promise.all([
    startStack(),
    startStack({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "wurmhol-e2e",
      GITHUB_APP_CLIENT_ID: "Iv1.e2e",
      GITHUB_APP_CLIENT_SECRET: "e2e-client-secret",
      GITHUB_APP_PRIVATE_KEY: "e2e-not-a-key",
      GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_WEB_URL: "https://github.example",
      GITHUB_API_URL: "https://api.github.example",
    }),
  ]);
  local = await localServer((_req, res) => res.end("ok"));
});

afterAll(async () => {
  await local.close();
  await Promise.all([plain.stop(), withApp.stop()]);
});

function webhook(stack: Stack, body: string, signature?: string) {
  const headers = { "content-type": "application/json", "x-github-event": "pull_request" };

  return browserFetch(`${stack.url}/api/github/webhook`, {
    method: "POST",
    headers: signature === undefined ? headers : { ...headers, "x-hub-signature-256": signature },
    body,
  });
}

it("without a GitHub App, a pipe from a GitHub repo opens as before and nothing offers GitHub", async () => {
  const ada = await signIn(plain);
  const env = cliEnv(plain, (await createToken(plain, ada)).token);
  const repo = mkdtempSync(join(tmpdir(), "wurmhol-repo-"));
  execFileSync("git", ["init", "-q", "-b", "feat/x"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: repo });
  const run = await cli([String(local.port), "--json"], env, { cwd: repo });
  expect(run.code).toBe(0);
  const { id } = parseJson(z.object({ id: z.string() }), run.stdout);

  const wall = await api(
    plain,
    ada,
    "/api/shares",
    {},
    z.object({ shares: z.array(z.object({ id: z.string(), preview: z.json() })) }),
  );

  expect(wall.body.shares.find((share) => share.id === id)?.preview).toBeNull();
  expect((await api(plain, ada, "/api/github")).body).toEqual({
    available: false,
    installations: [],
  });
  expect((await api(plain, ada, "/api/github/install")).status).toBe(404);
  expect((await webhook(plain, "{}")).status).toBe(404);
  await stopAll(env);
});

it("refuses a webhook that is unsigned or signed with another secret", async () => {
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    pull_request: { head: { ref: "feat/x", repo: { full_name: "acme/shop" } } },
  });

  const sign = (secret: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  expect((await webhook(withApp, body)).status).toBe(401);
  expect((await webhook(withApp, body, sign("another-secret"))).status).toBe(401);
  // Signed right, for an installation no org linked: accepted, and nothing to post.
  expect((await webhook(withApp, body, sign(WEBHOOK_SECRET))).status).toBe(200);
});

it("linking starts at GitHub, and another person cannot finish someone's link", async () => {
  const ada: Person = await signIn(withApp);
  expect((await api(withApp, ada, "/api/github")).body).toEqual({
    available: true,
    installations: [],
  });
  const install = await browserFetch(`${withApp.url}/api/github/install`, { cookie: ada.cookie });
  expect(install.status).toBe(302);
  expect(install.headers.get("location")).toBe(
    "https://github.example/apps/wurmhol-e2e/installations/new",
  );

  const setup = await browserFetch(
    `${withApp.url}/api/github/setup?installation_id=42&setup_action=install`,
    { cookie: ada.cookie },
  );

  expect(setup.status).toBe(302);
  const authorize = new URL(setup.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe(
    "https://github.example/login/oauth/authorize",
  );
  expect(authorize.searchParams.get("client_id")).toBe("Iv1.e2e");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${withApp.url}/api/github/callback`);
  const state = authorize.searchParams.get("state")!;

  // Catches: someone else (here, the owner of another org) linking an installation into an org
  // with a state that was made for Ada.
  const bob = await signIn(withApp);

  const stolen = await browserFetch(
    `${withApp.url}/api/github/callback?code=x&state=${encodeURIComponent(state)}`,
    { cookie: bob.cookie },
  );

  expect(stolen.status).toBe(400);
  // Catches: a state edited to name another installation still being accepted.
  const [body, mac] = state.split(".");
  const edited = JSON.parse(Buffer.from(body!, "base64url").toString());
  edited.installationId = 43;
  const forged = `${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${mac}`;

  const tampered = await browserFetch(
    `${withApp.url}/api/github/callback?code=x&state=${encodeURIComponent(forged)}`,
    { cookie: ada.cookie },
  );

  expect(tampered.status).toBe(400);
  const db = withApp.db();

  try {
    expect(db.prepare("select count(*) as n from github_installations").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
