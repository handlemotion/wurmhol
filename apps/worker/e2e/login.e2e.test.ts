// `wurmhol login` (ADR 0008): the real CLI asks for a code on the CLI's host, a signed-in member
// approves it through the console's API, and the CLI stores an org token it then opens pipes with.
// `npx wurmhol <port>` with no token does the same through the link it prints (ADR 0026).
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  alive,
  api,
  browserFetch,
  cli,
  cliEnv,
  cliPath,
  connectProxy,
  createToken,
  type JsonValue,
  localServer,
  me,
  parseJson,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  readJson,
  waitFor,
} from "./support.ts";

let stack: Stack;
let proxy: Awaited<ReturnType<typeof connectProxy>>;
let ada: Person;
let cliHost: string;

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "api.localhost" });
  // The sandbox's egress proxy: the CLI reaches `api.localhost` only through it.
  proxy = await connectProxy([stack.port]);
  cliHost = `http://api.localhost:${stack.port}`;
  ada = await signIn(stack);
});

afterAll(async () => {
  await proxy.close();
  await stack.stop();
});

/** CLI env with no WURMHOL_TOKEN: only what `login` stores. */
function loginEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = cliEnv(stack, "", {
    WURMHOL_URL: cliHost,
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    ...extra,
  });

  delete env.WURMHOL_TOKEN;

  return env;
}

/** Starts `wurmhol login` and returns the code it prints, plus a promise of how it ends. */
async function startLogin(env: Record<string, string>) {
  const child = spawn(process.execPath, [cliPath, "login"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );

  const line = await waitFor(() => /^Open (\S+) and enter (\S+)$/m.exec(stdout), {
    what: `the login prompt (stderr: ${stderr})`,
  });

  return { url: line[1]!, code: line[2]!, done };
}

/** The CLI's own calls, made directly where a test needs to place a step between two of them. */
const post = (path: string, body: JsonValue) =>
  browserFetch(`${cliHost}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const device = (person: Person, path: string, code: string) =>
  api(stack, person, `/api/device/${path}`, { method: "POST", body: { code } });

const count = z.object({ n: z.number() });
const pipeLink = z.object({ url: z.string() });
const deviceError = z.object({ error: z.string() });
const tokenNames = z.object({ tokens: z.array(z.object({ name: z.string() })) });
const devicePipe = z.object({ url: z.string().nullable() });

it("login prints the console's /device and a code; approving stores a token that opens a pipe", async () => {
  const env = loginEnv();
  const login = await startLogin(env);
  expect(login.url).toBe(`${stack.url}/device`);
  expect(login.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const shown = await api(
    stack,
    ada,
    `/api/device?code=${login.code.toLowerCase()}`,
    {},
    z.object({
      code: z.string(),
      name: z.string(),
      status: z.string(),
      org: z.object({ id: z.string() }),
    }),
  );

  expect(shown.status).toBe(200);
  expect(shown.body).toMatchObject({ code: login.code, name: hostname(), status: "pending" });
  expect(shown.body.org.id).toBe((await me(stack, ada)).activeOrgId);

  expect((await device(ada, "approve", login.code)).status).toBe(200);
  const ended = await login.done;
  expect({ code: ended.code, stderr: ended.stderr }).toMatchObject({ code: 0 });
  expect(ended.stdout).toContain(`as ${hostname()}`);

  const file = join(env.WURMHOL_HOME!, "credentials.json");
  // One descriptor for both the mode and the contents: they describe the same file.
  const fd = openSync(file, "r");
  let saved: { token: string; server: string };

  try {
    expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    saved = parseJson(
      z.object({ token: z.string(), server: z.string() }),
      readFileSync(fd, "utf8"),
    );
  } finally {
    closeSync(fd);
  }

  expect(saved.token).toMatch(/^wh_/);
  expect(saved.server).toBe(cliHost);

  // An org token named after the computer, for pipes only, for 90 days; the session the plugin
  // made is gone.
  const tokens = await api(
    stack,
    ada,
    "/api/tokens",
    {},
    z.object({
      tokens: z.array(
        z.object({ name: z.string(), scope: z.string(), expiresAt: z.string().nullable() }),
      ),
    }),
  );

  const minted = tokens.body.tokens.find((t) => t.name === hostname());
  expect(minted?.scope).toBe("pipes");
  // A missing expiry parses to NaN, which fails both bounds below.
  const days = (Date.parse(minted?.expiresAt ?? "") - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(89.9);
  expect(days).toBeLessThanOrEqual(90);
  const db = stack.db();

  try {
    const { user } = await me(stack, ada);

    const sessions = count.parse(
      db.prepare("select count(*) as n from sessions where user_id = ?").get(user.id),
    );

    expect(sessions.n).toBe(1);
    const codes = count.parse(db.prepare("select count(*) as n from device_codes").get());
    expect(codes.n).toBe(0);
  } finally {
    db.close();
  }

  const local = await localServer((_req, res) => res.end("logged in"));
  const opened = await cli([String(local.port), "--json"], env);
  expect({ code: opened.code, stderr: opened.stderr }).toMatchObject({ code: 0 });
  const { url } = parseJson(pipeLink, opened.stdout);
  const cookie = await viewerCookie(stack, ada, url);
  expect(await (await browserFetch(`${url}/`, { cookie })).text()).toBe("logged in");
  await stopAll(env);

  // WURMHOL_TOKEN wins over the stored token.
  const overridden = await cli([String(local.port)], { ...env, WURMHOL_TOKEN: "wh_not_a_token" });
  expect(overridden.code).toBe(1);
  expect(overridden.stderr).toContain("Create a new token");

  const out = await cli(["logout"], env);
  expect(out.code).toBe(0);
  expect(existsSync(file)).toBe(false);
  // Logged out, a share waits for approval instead of failing; stopping it ends the wait.
  const after = await cli([String(local.port)], env);
  expect({ code: after.code, stderr: after.stderr }).toMatchObject({ code: 0 });
  expect(after.stdout).toContain(`${stack.url}/device?code=`);
  expect((await cli(["stop", String(local.port)], env)).code).toBe(0);
  expect(JSON.parse((await cli(["ls", "--json"], env)).stdout)).toEqual([]);
  await local.close();
});

it("with no token, a share prints a link; approving it there opens that pipe and logs the computer in", async () => {
  const env = loginEnv();
  const local = await localServer((_req, res) => res.end("approved from the link"));
  const first = await cli([String(local.port), "--json"], env);
  expect({ code: first.code, stderr: first.stderr }).toMatchObject({ code: 0 });

  const waiting = parseJson(
    z.object({ url: z.string(), port: z.number(), approval: z.boolean().optional() }),
    first.stdout,
  );

  expect(waiting).toMatchObject({ port: local.port, approval: true });
  expect(waiting.url.startsWith(`${stack.url}/device?code=`)).toBe(true);
  // Agents re-run commands: the same link, not a second code.
  const again = await cli([String(local.port), "--json"], env);
  expect(JSON.parse(again.stdout)).toMatchObject({ url: waiting.url, approval: true });

  const code = new URL(waiting.url).searchParams.get("code")!;

  const shown = await api(
    stack,
    ada,
    `/api/device?code=${code}`,
    {},
    z.object({ name: z.string(), port: z.number().nullable() }),
  );

  expect(shown.body).toMatchObject({ name: hostname(), port: local.port });

  const pipeOf = (person: Person) =>
    api(stack, person, `/api/device/pipe?code=${code}`, {}, devicePipe);

  expect((await pipeOf(ada)).body.url).toBeNull();

  expect((await device(ada, "approve", code)).status).toBe(200);

  // The page follows the approved code to the pipe it opened.
  const url = await waitFor(async () => (await pipeOf(ada)).body.url, {
    timeoutMs: 20_000,
    intervalMs: 500,
    what: "the approved share's pipe",
  });

  const cookie = await viewerCookie(stack, ada, url);
  expect(await (await browserFetch(`${url}/`, { cookie })).text()).toBe("approved from the link");
  // Someone in another org learns nothing from the code.
  const bo = await signIn(stack);
  expect((await pipeOf(bo)).body.url).toBeNull();

  // Logged in now: `ls` shows the pipe, and the next share opens with no approval.
  const listed = parseJson(z.array(pipeLink), (await cli(["ls", "--json"], env)).stdout);
  expect(listed.map((s) => s.url)).toEqual([url]);
  const other = await localServer((_req, res) => res.end("second"));

  const next = parseJson(
    z.object({ url: z.string(), approval: z.boolean().optional() }),
    (await cli([String(other.port), "--json"], env)).stdout,
  );

  expect(next.approval).toBeUndefined();
  expect(next.url).not.toBe(url);
  await stopAll(env);
  await Promise.all([local.close(), other.close()]);
});

// Catches a second tokenless share starting its own code: two links for the human and two
// tokens minted for one computer, or a second share that never opens once the first is approved.
it("a second share with no token waits on the first one's link and opens once it is approved", async () => {
  const env = loginEnv();

  const computers = async () =>
    (await api(stack, ada, "/api/tokens", {}, tokenNames)).body.tokens.filter(
      (t) => t.name === hostname(),
    ).length;

  const before = await computers();
  const app = await localServer((_req, res) => res.end("first port"));
  const web = await localServer((_req, res) => res.end("second port"));

  const first = await cli([String(app.port), "--json"], env);
  expect({ code: first.code, stderr: first.stderr }).toMatchObject({ code: 0 });
  const link = parseJson(pipeLink, first.stdout).url;
  const second = await cli([String(web.port), "--json"], env);
  expect({ code: second.code, stderr: second.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(second.stdout)).toMatchObject({ url: link, port: web.port, approval: true });
  expect(second.stderr).toContain("another share is already waiting on this link");
  // Re-run, the second share prints the same link and says the same.
  const again = await cli([String(web.port)], env);
  expect(again.stdout.trim()).toBe(link);
  expect(again.stderr).toContain("another share is already waiting on this link");

  const waiting = parseJson(
    z.array(z.object({ port: z.number(), approval: z.boolean().optional() })),
    (await cli(["ls", "--json"], env)).stdout,
  );

  expect(waiting.map((s) => [s.port, s.approval])).toEqual([
    [app.port, true],
    [web.port, true],
  ]);

  const code = new URL(link).searchParams.get("code")!;
  expect((await device(ada, "approve", code)).status).toBe(200);

  const open = await waitFor(
    async () => {
      const listed = parseJson(
        z.array(z.object({ port: z.number(), url: z.string(), approval: z.boolean().optional() })),
        (await cli(["ls", "--json"], env)).stdout,
      );

      return listed.length === 2 && listed.every((s) => !s.approval) ? listed : null;
    },
    { timeoutMs: 20_000, intervalMs: 500, what: "both shares' pipes" },
  );

  for (const [port, body] of [
    [app.port, "first port"],
    [web.port, "second port"],
  ] as const) {
    const url = open.find((s) => s.port === port)!.url;
    const cookie = await viewerCookie(stack, ada, url);
    expect(await (await browserFetch(`${url}/`, { cookie })).text()).toBe(body);
  }

  // The approval page asked to open the first port: it goes there, though the second opened later.
  const page = await api(
    stack,
    ada,
    `/api/device/pipe?code=${code}&port=${app.port}`,
    {},
    devicePipe,
  );

  expect(page.body.url).toBe(open.find((s) => s.port === app.port)!.url);
  // One approval, one token for this computer.
  expect(await computers()).toBe(before + 1);
  await stopAll(env);
  await Promise.all([app.close(), web.close()]);
});

it("with no plan, a share's approval page says so instead of waiting for a pipe that /connect refuses", async () => {
  // Billing on and no subscription: what a new hosted org looks like before it subscribes.
  const billed = await startStack({
    STRIPE_SECRET_KEY: "sk_test_e2e_not_a_real_key",
    STRIPE_WEBHOOK_SECRET: "whsec_e2e_wurmhol_webhook_secret",
    STRIPE_PRICE_FRIENDS: "price_e2e_friends",
    STRIPE_PRICE_BUSINESS: "price_e2e_business",
    STRIPE_PRICE_BUSINESS_REQUESTS: "price_e2e_business_requests",
  });

  const local = await localServer((_req, res) => res.end("never served"));
  const env: Record<string, string> = cliEnv(billed, "");
  delete env.WURMHOL_TOKEN;

  try {
    const cy = await signIn(billed);
    const first = await cli([String(local.port), "--json"], env);
    expect({ code: first.code, stderr: first.stderr }).toMatchObject({ code: 0 });

    const code = new URL(parseJson(pipeLink, first.stdout).url).searchParams.get("code")!;

    const shown = await api(
      billed,
      cy,
      `/api/device?code=${code}`,
      {},
      z.object({ port: z.number().nullable(), role: z.string(), standing: z.json() }),
    );

    expect(shown.body).toMatchObject({
      port: local.port,
      role: "owner",
      standing: { ok: false, reason: "no_subscription" },
    });

    // Approved anyway (an old page, a direct call): the computer logs in and /connect refuses
    // the pipe. The page's fallback hint, `wurmhol logs <port>`, finds why after the daemon exits.
    const approved = await api(billed, cy, "/api/device/approve", {
      method: "POST",
      body: { code },
    });

    expect(approved.status).toBe(200);

    const failed = await waitFor(
      async () => {
        const logs = await cli(["logs", String(local.port)], env);

        return /open\.failed .*no plan yet/.test(logs.stdout) ? logs.stdout : null;
      },
      { timeoutMs: 20_000, intervalMs: 500, what: "the refused pipe in wurmhol logs" },
    );

    expect(failed).toContain("trial at");
    expect(
      (await api(billed, cy, `/api/device/pipe?code=${code}`, {}, devicePipe)).body.url,
    ).toBeNull();
  } finally {
    await stopAll(env);
    await local.close();
    await billed.stop();
  }
});

it("a denied login stores nothing and says so", async () => {
  const env = loginEnv();
  const login = await startLogin(env);
  expect((await device(ada, "deny", login.code)).status).toBe(200);
  const ended = await login.done;
  expect(ended.code).toBe(1);
  expect(ended.stderr).toContain("The login was denied");
  expect(existsSync(join(env.WURMHOL_HOME!, "credentials.json"))).toBe(false);
});

it("a wrong code, someone else's code, and the plugin's own routes are refused", async () => {
  expect((await device(ada, "approve", "ZZZZ-ZZZZ")).status).toBe(404);
  expect((await api(stack, null, "/api/device?code=ZZZZ-ZZZZ")).status).toBe(401);

  const env = loginEnv();
  const login = await startLogin(env);
  // Ada opens it first, which claims it; Bo cannot see, approve or deny it.
  expect((await api(stack, ada, `/api/device?code=${login.code}`)).status).toBe(200);
  const bo = await signIn(stack);
  expect((await api(stack, bo, `/api/device?code=${login.code}`)).status).toBe(404);
  expect((await device(bo, "approve", login.code)).status).toBe(404);
  expect((await device(bo, "deny", login.code)).status).toBe(404);

  // The plugin's endpoints would hand out a session or approve with no org: closed.
  for (const path of [
    "/api/auth/device/code",
    "/api/auth/device/token",
    "/api/auth/device/approve",
  ]) {
    const response = await api(stack, ada, path, { method: "POST", body: {} });
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }

  // Nothing of the console's API is on the CLI's host.
  const viaCliHost = await browserFetch(`${cliHost}/api/device?code=${login.code}`, {
    cookie: ada.cookie,
  });

  expect(viaCliHost.status).toBe(404);

  expect((await device(ada, "deny", login.code)).status).toBe(200);
  expect((await login.done).code).toBe(1);
  // A decided code cannot be decided again.
  expect((await device(ada, "approve", login.code)).status).toBe(404);
});

it("an approver who leaves the org before the CLI redeems gets no token for it", async () => {
  const bo = await signIn(stack);
  const boOrg = (await me(stack, bo)).activeOrgId;
  const invite = await api(stack, bo, "/api/invites", { method: "POST" }, pipeLink);
  const cy = await signIn(stack);
  const joinCode = invite.body.url.split("/join/")[1]!;
  expect((await api(stack, cy, `/api/invites/${joinCode}/accept`, { method: "POST" })).status).toBe(
    200,
  );
  expect((await me(stack, cy)).activeOrgId).toBe(boOrg);

  // The removal lands between approval and redemption.
  const issued = await readJson(
    z.object({ device_code: z.string(), user_code: z.string() }),
    await post("/device/code", { name: "cy-laptop" }),
  );

  const pending = await post("/device/token", { device_code: issued.device_code });
  expect(pending.status).toBe(400);
  expect((await readJson(deviceError, pending)).error).toBe("authorization_pending");

  expect((await device(cy, "approve", issued.user_code)).status).toBe(200);

  const members = await api(
    stack,
    bo,
    "/api/members",
    {},
    z.object({ members: z.array(z.object({ id: z.string(), email: z.string() })) }),
  );

  const cyMember = members.body.members.find((m) => m.email === cy.email)!;
  expect((await api(stack, bo, `/api/members/${cyMember.id}`, { method: "DELETE" })).status).toBe(
    200,
  );

  // Past the polling interval, so the answer is about membership, not `slow_down`.
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  const refused = await post("/device/token", { device_code: issued.device_code });
  expect(refused.status).toBe(403);
  expect((await readJson(deviceError, refused)).error).toBe("access_denied");
  const tokens = await api(stack, bo, "/api/tokens", {}, tokenNames);
  expect(tokens.body.tokens.map((t) => t.name)).not.toContain("cy-laptop");
  const db = stack.db();

  try {
    const { user } = await me(stack, cy);

    const sessions = count.parse(
      db.prepare("select count(*) as n from sessions where user_id = ?").get(user.id),
    );

    expect(sessions.n).toBe(1);
  } finally {
    db.close();
  }
});

it("polling faster than the interval gets slow_down", async () => {
  const issued = await readJson(
    z.object({ device_code: z.string(), interval: z.number() }),
    await post("/device/code", { name: "fast" }),
  );

  expect(issued.interval).toBeGreaterThan(0);
  await post("/device/token", { device_code: issued.device_code });
  const fast = await post("/device/token", { device_code: issued.device_code });
  expect((await readJson(deviceError, fast)).error).toBe("slow_down");
});

it("a signed-in computer is listed by when it was approved and last used; signing it out stops its token at once", async () => {
  const env = loginEnv();
  const login = await startLogin(env);
  expect((await device(ada, "approve", login.code)).status).toBe(200);
  expect((await login.done).code).toBe(0);

  const local = await localServer((_req, res) => res.end("from this computer"));
  const opened = await cli([String(local.port), "--json"], env);
  expect({ code: opened.code, stderr: opened.stderr }).toMatchObject({ code: 0 });
  const started = parseJson(z.object({ id: z.string(), url: z.string() }), opened.stdout);
  const cookie = await viewerCookie(stack, ada, started.url);
  expect(await (await browserFetch(`${started.url}/`, { cookie })).text()).toBe(
    "from this computer",
  );

  const listedTokens = z.object({
    tokens: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        source: z.string(),
        createdAt: z.string(),
        lastUsedAt: z.string().nullable(),
      }),
    ),
  });

  const listed = await api(stack, ada, "/api/tokens", {}, listedTokens);
  const computers = listed.body.tokens.filter((t) => t.source === "login");
  const computer = computers.find((t) => t.name === hostname());
  expect(computer).toBeDefined();
  // Approved just now, and used to open the pipe since.
  expect(Date.now() - Date.parse(computer!.createdAt)).toBeLessThan(60_000);
  expect(Date.parse(computer!.lastUsedAt!)).toBeGreaterThanOrEqual(Date.parse(computer!.createdAt));
  // Console tokens are not computers.
  await createToken(stack, ada, "made in the console");
  const after = await api(stack, ada, "/api/tokens", {}, listedTokens);
  expect(after.body.tokens.find((t) => t.name === "made in the console")?.source).toBe("console");

  const pid = parseJson(
    z.object({ pid: z.number() }),
    readFileSync(join(env.WURMHOL_HOME!, "shares", `${started.id}.json`), "utf8"),
  ).pid;

  const signedOut = await api(stack, ada, `/api/tokens/${computer!.id}`, { method: "DELETE" });
  expect(signedOut.status).toBe(200);

  // At once: its open pipe ends, its CLI exits, and the stored token opens nothing.
  const ended = await browserFetch(`${started.url}/`, { cookie });
  expect(ended.status).toBe(410);
  await waitFor(() => !alive(pid), { what: "the signed-out computer's CLI to exit" });
  const again = await cli([String(local.port)], env);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("Create a new token");
  const gone = await api(stack, ada, "/api/tokens", {}, listedTokens);
  expect(gone.body.tokens.map((t) => t.id)).not.toContain(computer!.id);
  await local.close();
});
