#!/usr/bin/env node
// End-to-end proof against the real local stack: signs in through the magic-link flow, creates an
// org token, shares a local HTTP server with the built CLI, and requests it through the share's
// public URL. Prints each observation so a hand-off can quote it. Starts `stack:serve` when it is
// not already answering and leaves it running; stops the share and the local server it started.
//
//   node scripts/verify.mjs          (pnpm verify)
//
// PORT (default 8787) picks the stack's port, as for scripts/serve.mjs.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, request } from "undici";

const root = join(import.meta.dirname, "..");
const cliPath = join(root, "packages/cli/dist/cli.js");
const logFile = join(root, ".local/serve/worker.log");
const port = Number(process.env.PORT ?? 8787);

// The origin Better Auth trusts locally (apps/worker/.dev.vars.example BETTER_AUTH_URL).
const origin = `http://localhost:${port}`;

// Share hosts are `<id>.pipe.localhost`; resolve every `*.localhost` name to this machine the way
// browsers do, and refuse anything else so the check cannot leave the machine.
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (hostname !== "localhost" && !hostname.endsWith(".localhost")) {
        callback(new Error(`verify refuses to resolve ${hostname}`), "", 4);

        return;
      }

      if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    },
  },
});

function step(message) {
  process.stdout.write(`✓ ${message}\n`);
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });

  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
}

async function send(url, init = {}) {
  const response = await request(url, { dispatcher, ...init });
  const body = await response.body.text();

  return { status: response.statusCode, headers: response.headers, body };
}

async function waitFor(what, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await probe();

    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return fail(`timed out waiting for ${what}`);
}

async function ensureStack() {
  const healthy = await send(`${origin}/health`).then(
    (response) => response.status === 200,
    () => false,
  );

  if (!healthy) run("node", ["scripts/serve.mjs", "start"]);
  step(`stack answers ${origin}/health`);
}

function ensureCli() {
  if (!existsSync(cliPath)) run("pnpm", ["--filter", "wurmhol", "build"]);
  step(`CLI built at ${cliPath}`);
}

/** The `auth.dev_link` URL the Worker logged for `email`, once it has. */
function devLinkFor(email) {
  const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : [];

  for (const line of lines) {
    if (!line.includes('"auth.dev_link"') || !line.includes(email)) continue;
    const match = /"url":"([^"]+)"/.exec(line);

    if (match) return match[1];
  }

  return undefined;
}

async function signIn() {
  const email = `verify-${randomUUID()}@example.com`;

  const sent = await send(`${origin}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });

  if (sent.status !== 200) fail(`magic link request: ${sent.status} ${sent.body}`);
  const link = await waitFor("the auth.dev_link log line", () => devLinkFor(email));
  const verified = await send(link);
  const setCookie = [verified.headers["set-cookie"] ?? []].flat();
  const cookie = setCookie.map((value) => value.split(";")[0]).join("; ");

  if (!cookie.includes("session_token")) fail(`no session cookie (${verified.status})`);
  step(`signed in as ${email} through the magic link`);

  return cookie;
}

async function createToken(cookie) {
  const created = await send(`${origin}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ name: "verify" }),
  });

  if (created.status !== 201) fail(`token: ${created.status} ${created.body}`);
  step("created an org token");

  return JSON.parse(created.body).token;
}

async function startLocalServer(marker) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>verify</title><p>${marker} ${req.method} ${req.url}</p>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A TCP listener's address is always an { address, family, port } record.
  const { port } = server.address();
  step(`local dev server on 127.0.0.1:${port}`);

  return { server, port };
}

function cli(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
  });

  if (result.status !== 0) fail(`wurmhol ${args.join(" ")}: ${result.stderr}`);

  return result.stdout;
}

async function main() {
  await ensureStack();
  ensureCli();
  const cookie = await signIn();
  const token = await createToken(cookie);
  const marker = randomBytes(8).toString("hex");
  const local = await startLocalServer(marker);
  const home = mkdtempSync(join(tmpdir(), "wurmhol-verify-"));
  const accessKey = randomBytes(24).toString("base64url");

  const env = {
    WURMHOL_URL: origin,
    WURMHOL_TOKEN: token,
    WURMHOL_HOME: home,
    WURMHOL_ACCESS_KEY: accessKey,
  };

  try {
    const shared = JSON.parse(cli([String(local.port), "--json"], env).split("\n")[0]);
    step(`CLI shared port ${local.port} at ${shared.url}`);
    const refused = await send(`${shared.url}/`);

    if (refused.status === 200) fail("the share answered a request with no session or key");
    step(`without a session or key the share answers ${refused.status}`);

    const opened = await send(`${shared.url}/hello?from=verify`, {
      headers: { "x-wurmhol-key": accessKey },
    });

    if (opened.status !== 200 || !opened.body.includes(marker))
      fail(`share request: ${opened.status} ${opened.body.slice(0, 200)}`);
    step(`GET ${shared.url}/hello?from=verify → ${opened.status}, body from the local server`);
  } finally {
    cli(["stop", "--all"], env);
    local.server.close();
    rmSync(home, { recursive: true, force: true });
  }

  step("share stopped; stack left running (pnpm stack:serve:stop)");
}

await main();
