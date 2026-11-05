// The request log on the agent's machine (ADR 0022): the daemon writes each viewer request's
// method, path without query values, status and duration to its pipe's log, `wurmhol logs` and
// the MCP server's `recent_requests` read it, and nothing else of the request is kept.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  browserFetch,
  cli,
  cliEnv,
  cliPath,
  createToken,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  local = await localServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const failing = req.url?.startsWith("/api/checkout");
      res.writeHead(failing ? 500 : 200, { "content-type": "text/plain" }).end("done");
    });
  });
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

interface Logged {
  event: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
}

async function logged(target: string) {
  const run = await cli(["logs", target, "--json"], env);
  expect(run.stderr).toBe("");
  return run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Logged)
    .filter((r) => r.event === "request");
}

it("logs each request's method, path and status, and none of its query values, body or cookies", async () => {
  const opened = await cli([String(local.port), "--name", "log-test", "--json"], env);
  const pipe = JSON.parse(opened.stdout) as { id: string; url: string };
  const cookie = await viewerCookie(stack, ada, pipe.url);
  await (await browserFetch(`${pipe.url}/`, { cookie })).text();
  const failed = await browserFetch(`${pipe.url}/api/checkout?card=4242424242424242&step=pay`, {
    method: "POST",
    cookie: `${cookie}; app_session=s3cr3t-session`,
    headers: { "content-type": "application/json", authorization: "Bearer app-bearer-value" },
    body: JSON.stringify({ secret: "the-request-body" }),
  });
  expect(failed.status).toBe(500);
  await failed.text();

  // Catches: requests never reaching the log (the daemon ignoring the pipe's request events).
  const requests = await waitFor(
    async () => {
      const found = await logged(String(local.port));
      return found.length >= 2 ? found : null;
    },
    { what: "two logged requests" },
  );
  expect(requests.map(({ method, path, status }) => ({ method, path, status }))).toEqual([
    { method: "GET", path: "/", status: 200 },
    { method: "POST", path: "/api/checkout?card=&step=", status: 500 },
  ]);
  expect(requests[1]!.durationMs).toBeGreaterThanOrEqual(0);
  // By name and by id too, as `wurmhol stop` takes them, in the readable form.
  expect(await logged("log-test")).toEqual(requests);
  const text = await cli(["logs", pipe.id], env);
  expect(text.stdout).toMatch(/ POST \/api\/checkout\?card=&step= {2}500 {2}\d+ ms\n/);

  // Catches: a card number, a token, a cookie or a body written to disk.
  const files = readdirSync(join(env.WURMHOL_HOME!, "logs"));
  const disk = files.map((f) => readFileSync(join(env.WURMHOL_HOME!, "logs", f), "utf8")).join("");
  for (const secret of [
    "4242424242424242",
    "s3cr3t-session",
    "app-bearer-value",
    "the-request-body",
    cookie.split("=")[1]!,
  ]) {
    expect(disk).not.toContain(secret);
  }

  // The log outlives the pipe: an ended pipe's id still reads.
  await cli(["stop", "log-test"], env);
  expect((await logged(pipe.id)).length).toBe(2);
  const missing = await cli(["logs", "log-test"], env);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toBe("wurmhol: No log for log-test. See: wurmhol ls\n");
});

it("--follow prints requests as they happen", async () => {
  const opened = await cli([String(local.port), "--json"], env);
  const pipe = JSON.parse(opened.stdout) as { id: string; url: string };
  const cookie = await viewerCookie(stack, ada, pipe.url);
  const follower = spawn(process.execPath, [cliPath, "logs", pipe.id, "--follow"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  follower.stdout.on("data", (chunk: Buffer) => (output += chunk));
  try {
    // Started: it printed the log so far (the pipe's `connected`).
    await waitFor(() => output.includes("connected"), { what: "the log so far" });
    await (await browserFetch(`${pipe.url}/after-follow`, { cookie })).text();
    // Catches: --follow printing the past and then nothing.
    await waitFor(() => output.includes("GET /after-follow  200"), { what: "a followed request" });
    expect(output.match(/GET \/after-follow {2}200/g)).toHaveLength(1);
  } finally {
    follower.kill();
    await cli(["stop", pipe.id], env);
  }
});

it("keeps each pipe's log bounded, and still shows the latest requests", async () => {
  const opened = await cli([String(local.port), "--json"], env);
  const pipe = JSON.parse(opened.stdout) as { id: string; url: string };
  const cookie = await viewerCookie(stack, ada, pipe.url);
  const long = "x".repeat(8000);
  // About 1.3 MB of log lines: past the 1 MiB at which a log moves to `.1`.
  for (let i = 0; i < 160; i++) {
    await (await browserFetch(`${pipe.url}/${long}/${i}`, { cookie })).text();
  }
  const dir = join(env.WURMHOL_HOME!, "logs");
  const bytes = readdirSync(dir)
    .filter((f) => f.startsWith(pipe.id))
    .reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  // Catches: a log that grows for as long as the pipe is open.
  expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(bytes).toBeGreaterThan(1024 * 1024);
  const latest = await logged(pipe.id);
  expect(latest.at(-1)?.path).toBe(`/${long}/159`);
  await cli(["stop", pipe.id], env);
});

it("recent_requests gives an agent the requests of its own pipes and of npx wurmhol's", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "wurmhol-e2e", version: "0" });
  await client.connect(transport);
  type Result = {
    structuredContent?: { id: string; url: string; requests: Logged[] };
    isError?: boolean;
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;
  try {
    const opened = (await call("open_pipe", { port: local.port })) as {
      structuredContent?: { id: string; url: string };
    };
    const pipe = opened.structuredContent!;
    const cookie = await viewerCookie(stack, ada, pipe.url);
    await (await browserFetch(`${pipe.url}/api/checkout?id=7`, { cookie })).text();
    // Catches: the MCP server's own pipes logging nothing, so the agent sees no failures.
    const own = await waitFor(
      async () => {
        const result = await call("recent_requests", { target: pipe.id });
        return result.structuredContent?.requests.length ? result.structuredContent : null;
      },
      { what: "the MCP pipe's request" },
    );
    expect(own.requests.map(({ method, path, status }) => ({ method, path, status }))).toEqual([
      { method: "GET", path: "/api/checkout?id=", status: 500 },
    ]);

    const daemon = JSON.parse((await cli([String(local.port), "--json"], env)).stdout) as {
      id: string;
      url: string;
    };
    const daemonCookie = await viewerCookie(stack, ada, daemon.url);
    for (const path of ["/one", "/two", "/three"]) {
      await (await browserFetch(`${daemon.url}${path}`, { cookie: daemonCookie })).text();
    }
    const theirs = await waitFor(
      async () => {
        const result = await call("recent_requests", { target: daemon.id, limit: 2 });
        return result.structuredContent?.requests.length === 2 ? result.structuredContent : null;
      },
      { what: "the daemon pipe's requests" },
    );
    expect(theirs.url).toBe(daemon.url);
    expect(theirs.requests.map((r) => r.path)).toEqual(["/two", "/three"]);

    const unknown = await call("recent_requests", { target: "65000" });
    expect(unknown.isError).toBe(true);
    await cli(["stop", daemon.id], env);
  } finally {
    await client.close();
  }
});
