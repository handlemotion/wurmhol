#!/usr/bin/env node
// Stress test against a running stack (`pnpm stack:serve`, ENVIRONMENT=development): signs in
// with the logged magic link, starts real shares with the built CLI, and loads them through the
// share hosts the way browsers do. Prints latency percentiles, throughput and errors.
//
//   node scripts/stress.mjs [--requests 2000] [--concurrency 50] [--sockets 100]
//
// WURMHOL_STRESS_URL (default http://localhost:8787) picks the stack.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Agent, request } from "undici";
import WebSocket from "ws";

const root = join(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    requests: { type: "string", default: "2000" },
    concurrency: { type: "string", default: "50" },
    sockets: { type: "string", default: "100" },
  },
});
const base = process.env.WURMHOL_STRESS_URL ?? "http://localhost:8787";
const lookup = (host, options, callback) =>
  options?.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4);
const dispatcher = new Agent({ connect: { lookup }, connections: 256 });

async function call(url, init = {}) {
  const res = await request(url, { dispatcher, ...init });
  const body = Buffer.from(await res.body.arrayBuffer());
  return { status: res.statusCode, headers: res.headers, body };
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
function summary(name, times, errors, ms) {
  const sorted = times.toSorted((a, b) => a - b);
  console.log(
    `${name}: ${times.length} ok, ${errors} errors, ${(times.length / (ms / 1000)).toFixed(0)} req/s, ` +
      `p50 ${percentile(sorted, 50)?.toFixed(1)} ms, p95 ${percentile(sorted, 95)?.toFixed(1)} ms, p99 ${percentile(sorted, 99)?.toFixed(1)} ms`,
  );
}

// --- Sign in, token, local servers ---------------------------------------------------------
const email = `stress-${Date.now()}@example.com`;
await call(`${base}/api/auth/sign-in/magic-link`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email, callbackURL: "/" }),
});
await new Promise((r) => setTimeout(r, 500));
const log = readFileSync(join(root, ".local/serve/worker.log"), "utf8");
const link = log
  .split("\n")
  .filter((l) => l.includes("auth.dev_link") && l.includes(email))
  .at(-1);
if (!link)
  throw new Error(
    "no magic link in .local/serve/worker.log: is the stack ENVIRONMENT=development?",
  );
const verified = await call(JSON.parse(link.slice(link.indexOf("{"))).url);
const session = []
  .concat(verified.headers["set-cookie"])
  .map((c) => c.split(";")[0])
  .join("; ");
const created = await call(`${base}/api/tokens`, {
  method: "POST",
  headers: { cookie: session, origin: base, "content-type": "application/json" },
  body: JSON.stringify({ name: "stress" }),
});
const { token } = JSON.parse(created.body.toString());

const BIG = Buffer.alloc(100 * 1024 * 1024, 7);
const local = http.createServer((req, res) => {
  if (req.url === "/big") return res.writeHead(200, { "content-length": BIG.length }).end(BIG);
  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write("data: x\n\n"), 50);
    return req.on("close", () => clearInterval(timer));
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: req.url }));
});
await new Promise((r) => local.listen(0, "127.0.0.1", r));
const port = local.address().port;
const { WebSocketServer } = await import("ws");
const echo = new WebSocketServer({ port: 0, host: "127.0.0.1" });
echo.on("connection", (s) => s.on("message", (d, binary) => s.send(d, { binary })));
await new Promise((r) => echo.on("listening", r));

const env = {
  ...process.env,
  WURMHOL_URL: base,
  WURMHOL_TOKEN: token,
  WURMHOL_HOME: mkdtempSync(join(tmpdir(), "wurmhol-stress-")),
};
const cli = (...args) =>
  execFileSync(process.execPath, [join(root, "packages/cli/dist/cli.js"), ...args], { env })
    .toString()
    .trim();
const t0 = performance.now();
const shareUrl = cli(String(port));
console.log(`share started in ${(performance.now() - t0).toFixed(0)} ms: ${shareUrl}`);
const wsShare = cli(String(echo.address().port));

async function viewerCookie(url) {
  const first = await call(`${url}/`, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
  });
  const back = await call(first.headers.location, { headers: { cookie: session } });
  const set = await call(back.headers.location);
  return []
    .concat(set.headers["set-cookie"])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("__Host-wurmhol="));
}
const cookie = await viewerCookie(shareUrl);
const wsCookie = await viewerCookie(wsShare);

// --- 1. Many small requests, concurrently ------------------------------------------------------
{
  const total = Number(values.requests);
  const concurrency = Number(values.concurrency);
  const times = [];
  let errors = 0;
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        const i = next++;
        const t = performance.now();
        try {
          const res = await call(`${shareUrl}/r/${i}`, { headers: { cookie } });
          if (res.status === 200 && JSON.parse(res.body.toString()).path === `/r/${i}`)
            times.push(performance.now() - t);
          else errors++;
        } catch {
          errors++;
        }
      }
    }),
  );
  summary(
    `small requests x${total} at concurrency ${concurrency}`,
    times,
    errors,
    performance.now() - start,
  );
}

// --- 2. Large downloads in parallel, checked byte for byte -----------------------------------
{
  const expected = createHash("sha256").update(BIG).digest("hex");
  const start = performance.now();
  const results = await Promise.all(
    [0, 1, 2].map(async () => {
      const res = await call(`${shareUrl}/big`, { headers: { cookie } });
      return (
        createHash("sha256").update(res.body).digest("hex") === expected &&
        res.body.length === BIG.length
      );
    }),
  );
  const seconds = (performance.now() - start) / 1000;
  console.log(
    `3 x 100 MB downloads in parallel: ${results.filter(Boolean).length}/3 intact, ` +
      `${((3 * BIG.length) / 1024 / 1024 / seconds).toFixed(1)} MB/s total, ${seconds.toFixed(1)} s`,
  );
}

// --- 3. Small requests while a slow SSE stream and a download are open -------------------------
{
  const sse = await request(`${shareUrl}/sse`, { dispatcher, headers: { cookie } });
  const slow = await request(`${shareUrl}/big`, { dispatcher, headers: { cookie } });
  // The slow reader takes nothing: its stream must not stall the others (flow control).
  const times = [];
  let errors = 0;
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    const res = await call(`${shareUrl}/during/${i}`, { headers: { cookie } }).catch(() => null);
    if (res?.status === 200) times.push(performance.now() - t);
    else errors++;
  }
  summary(
    "requests beside a stalled 100 MB download and an SSE stream",
    times,
    errors,
    performance.now() - start,
  );
  sse.body.destroy();
  slow.body.destroy();
}

// --- 4. Many browser WebSockets at once, echoing ---------------------------------------------
{
  const count = Number(values.sockets);
  const start = performance.now();
  const rtts = [];
  let errors = 0;
  await Promise.all(
    Array.from(
      { length: count },
      (_, i) =>
        new Promise((resolve) => {
          const socket = new WebSocket(`${wsShare.replace("http", "ws")}/`, {
            headers: { cookie: wsCookie, origin: wsShare },
            lookup,
          });
          socket.on("open", async () => {
            for (let n = 0; n < 10; n++) {
              const t = performance.now();
              const reply = await new Promise((r) => {
                socket.once("message", (d) => r(d.toString()));
                socket.send(`${i}:${n}`);
              });
              if (reply === `${i}:${n}`) rtts.push(performance.now() - t);
              else errors++;
            }
            socket.close();
            resolve();
          });
          socket.on("error", () => {
            errors++;
            resolve();
          });
        }),
    ),
  );
  summary(`${count} WebSockets x 10 echoes`, rtts, errors, performance.now() - start);
}

cli("stop", "--all");
local.close();
echo.close();
await dispatcher.close();
