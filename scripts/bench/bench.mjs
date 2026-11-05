#!/usr/bin/env node
// Benchmarks Wurmhol against a running local stack (`pnpm stack:serve`, ENVIRONMENT=development)
// with the built CLI and real local HTTP servers. Every case runs several times; the report gives
// the median and the spread, and compares the pipe with the same request made directly.
//
//   pnpm bench [--runs 5] [--small 50] [--sse 0] [--json out.json]
//
// WURMHOL_BENCH_URL (default http://localhost:8787) picks the stack. See README.md.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Agent, request } from "undici";

const root = join(import.meta.dirname, "../..");
const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    small: { type: "string", default: "50" },
    sse: { type: "string", default: "0" },
    json: { type: "string" },
  },
});
const RUNS = Number(args.runs);
const SMALL = Number(args.small);
const SSE_SECONDS = Number(args.sse);
const MB = 1024 * 1024;
const SIZE = 50 * MB;
const base = process.env.WURMHOL_BENCH_URL ?? "http://localhost:8787";

// *.localhost resolves to loopback in browsers; Node needs telling.
const lookup = (_host, options, callback) =>
  options?.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4);
const dispatcher = new Agent({ connect: { lookup }, connections: 64 });

async function call(url, init = {}) {
  const res = await request(url, { dispatcher, ...init });
  const body = Buffer.from(await res.body.arrayBuffer());
  return { status: res.statusCode, headers: res.headers, body };
}

// --- Statistics ------------------------------------------------------------------------------
const results = [];
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}
const f = (v) => (v === undefined ? "" : v.toFixed(1));
function record(name, via, unit, samples, extra = "") {
  const s = samples.toSorted((a, b) => a - b);
  const row = {
    name,
    via,
    unit,
    n: s.length,
    median: quantile(s, 0.5),
    min: s[0],
    max: s.at(-1),
    p95: s.length >= 20 ? quantile(s, 0.95) : undefined,
    extra,
    samples,
  };
  results.push(row);
  console.log(
    `  ${name} [${via}]: median ${f(row.median)} ${unit}, ${f(row.min)}–${f(row.max)}` +
      (row.p95 === undefined ? "" : `, p95 ${f(row.p95)}`) +
      ` (n=${row.n})${extra ? `, ${extra}` : ""}`,
  );
  return row;
}

// --- Sign in, token ----------------------------------------------------------------------------
const email = `bench-${Date.now()}@example.com`;

/** A fresh magic link for `email`, read from the Worker's log (ENVIRONMENT=development). */
async function magicLink() {
  const seen = readFileSync(join(root, ".local/serve/worker.log"), "utf8").length;
  await call(`${base}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  let line;
  for (let i = 0; i < 50 && !line; i++) {
    await new Promise((r) => setTimeout(r, 100));
    line = readFileSync(join(root, ".local/serve/worker.log"), "utf8")
      .slice(seen)
      .split("\n")
      .findLast((l) => l.includes("auth.dev_link") && l.includes(email));
  }
  if (!line)
    throw new Error("no magic link in .local/serve/worker.log: run `pnpm stack:serve` first");
  return JSON.parse(line.slice(line.indexOf("{"))).url;
}

async function signIn() {
  const verified = await call(await magicLink());
  const session = []
    .concat(verified.headers["set-cookie"])
    .map((c) => c.split(";")[0])
    .join("; ");
  const created = await call(`${base}/api/tokens`, {
    method: "POST",
    headers: { cookie: session, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ name: "bench" }),
  });
  return { session, token: JSON.parse(created.body.toString()).token };
}

// --- The dev server being shared ---------------------------------------------------------------
const BIG = randomBytes(SIZE);
const BIG_SHA = createHash("sha256").update(BIG).digest("hex");
const SMALL_BODY = JSON.stringify({ ok: true, pad: "x".repeat(200) });
function origin() {
  const server = http.createServer((req, res) => {
    if (req.url === "/big") return res.writeHead(200, { "content-length": SIZE }).end(BIG);
    if (req.url === "/upload") {
      const hash = createHash("sha256");
      let length = 0;
      req.on("data", (d) => {
        hash.update(d);
        length += d.length;
      });
      return req.on("end", () =>
        res.writeHead(200).end(JSON.stringify({ sha: hash.digest("hex"), length })),
      );
    }
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const timer = setInterval(() => res.write(`id: ${n}\ndata: ${n++}\n\n`), 1000);
      return req.on("close", () => clearInterval(timer));
    }
    res.writeHead(200, { "content-type": "application/json" }).end(SMALL_BODY);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

// --- CLI ---------------------------------------------------------------------------------------
const run = promisify(execFile);
let env;
const cli = async (...a) =>
  (await run(process.execPath, [join(root, "packages/cli/dist/cli.js"), ...a], { env })).stdout
    .toString()
    .trim();

async function viewerCookie(url, session) {
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

// --- Cases -------------------------------------------------------------------------------------
async function timeToUrl(port) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const out = JSON.parse(await cli(String(port), "--json"));
    times.push(performance.now() - t);
    if (!out.url) throw new Error(`no URL printed: ${JSON.stringify(out)}`);
    await cli("stop", out.id);
  }
  record("`wurmhol <port>` to printed URL", "pipe", "ms", times);
}

async function small(url, headers, via) {
  await call(url, { headers }); // warm the connection
  const ttfb = [];
  const total = [];
  for (let i = 0; i < SMALL; i++) {
    const t = performance.now();
    const res = await request(url, { dispatcher, headers });
    ttfb.push(performance.now() - t);
    const body = await res.body.text();
    total.push(performance.now() - t);
    if (res.statusCode !== 200 || body !== SMALL_BODY) throw new Error(`small ${via}: bad reply`);
  }
  record("small GET, time to first byte", via, "ms", ttfb);
  record("small GET, total", via, "ms", total);
}

// Browsers open six connections per host, so a page's subresources arrive six at a time.
async function concurrent(url, headers, via) {
  for (const c of [1, 6]) {
    const rates = [];
    const latency = [];
    for (let r = 0; r < RUNS; r++) {
      let next = 0;
      const t = performance.now();
      await Promise.all(
        Array.from({ length: c }, async () => {
          while (next++ < SMALL * 2) {
            const s = performance.now();
            const res = await call(url, { headers });
            if (res.status !== 200) throw new Error(`concurrent ${via}: ${res.status}`);
            latency.push(performance.now() - s);
          }
        }),
      );
      rates.push((SMALL * 2) / ((performance.now() - t) / 1000));
    }
    const median = quantile(
      latency.toSorted((a, b) => a - b),
      0.5,
    );
    record(
      `small GETs, ${c} at a time`,
      via,
      "req/s",
      rates,
      `median latency ${median.toFixed(1)} ms`,
    );
  }
}

async function download(url, headers, via) {
  const rates = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const res = await call(url, { headers });
    const s = (performance.now() - t) / 1000;
    if (createHash("sha256").update(res.body).digest("hex") !== BIG_SHA)
      throw new Error(`download ${via}: body differs`);
    rates.push(SIZE / MB / s);
  }
  record("50 MB download", via, "MB/s", rates, "sha-256 checked");
}

async function upload(url, headers, via) {
  const rates = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const res = await call(url, { method: "POST", headers, body: BIG });
    const s = (performance.now() - t) / 1000;
    const got = JSON.parse(res.body.toString());
    if (got.sha !== BIG_SHA || got.length !== SIZE) throw new Error(`upload ${via}: body differs`);
    rates.push(SIZE / MB / s);
  }
  record("50 MB upload", via, "MB/s", rates, "sha-256 checked");
}

async function busy(shareUrl, headers) {
  const latencies = async () => {
    const times = [];
    for (let i = 0; i < SMALL; i++) {
      const t = performance.now();
      const res = await call(`${shareUrl}/busy/${i}`, { headers });
      if (res.status !== 200) throw new Error(`busy: ${res.status}`);
      times.push(performance.now() - t);
    }
    return times;
  };
  // A download read as fast as it arrives, restarted until the samples are taken.
  const done = new AbortController();
  let moved = 0;
  const pump = (async () => {
    while (!done.signal.aborted) {
      const res = await request(`${shareUrl}/big`, { dispatcher, headers });
      for await (const chunk of res.body) {
        moved += chunk.length;
        if (done.signal.aborted) break;
      }
      if (done.signal.aborted) res.body.destroy();
    }
  })();
  const t = performance.now();
  const flowing = await latencies();
  const rate = moved / MB / ((performance.now() - t) / 1000);
  done.abort();
  await pump.catch(() => {});
  record(
    "small GET beside a flowing 50 MB download",
    "pipe",
    "ms",
    flowing,
    `download ran at ${rate.toFixed(1)} MB/s`,
  );

  // A download nobody reads: flow control must keep it from stalling the other streams.
  const stalled = await request(`${shareUrl}/big`, { dispatcher, headers });
  await new Promise((r) => setTimeout(r, 1000));
  record("small GET beside a stalled 50 MB download", "pipe", "ms", await latencies());
  stalled.body.destroy();
}

async function sse(shareUrl, headers) {
  const res = await request(`${shareUrl}/sse`, {
    dispatcher,
    headers: { ...headers, accept: "text/event-stream" },
    bodyTimeout: 0,
  });
  let text = "";
  const deadline = Date.now() + SSE_SECONDS * 1000;
  for await (const chunk of res.body) {
    text += chunk.toString();
    if (Date.now() >= deadline) break;
  }
  res.body.destroy();
  const ids = [...text.matchAll(/^data: (\d+)$/gm)].map((m) => Number(m[1]));
  const inOrder = ids.every((v, i) => v === i);
  const expected = Math.floor(SSE_SECONDS) - 1;
  console.log(
    `  SSE for ${SSE_SECONDS} s: ${ids.length} events (about ${expected} expected), ${inOrder ? "in order, none missing" : "GAPS OR REORDERING"}`,
  );
  results.push({ name: `SSE stream, ${SSE_SECONDS} s`, via: "pipe", events: ids.length, inOrder });
  if (!inOrder || ids.length < expected) throw new Error("SSE stream lost events");
}

// A vanilla Vite app with a wide module graph (JS and CSS modules), plus one module that accepts
// hot updates, so a load fetches hundreds of modules and an edit exercises Vite's websocket.
const GROUPS = 20;
const LEAVES = 15;
function viteProject() {
  const dir = mkdtempSync(join(tmpdir(), "wurmhol-bench-vite-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><title>bench</title><div id="out"></div><div id="hmr"></div><script type="module" src="/src/main.js"></script>`,
  );
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    const leaves = [];
    for (let l = 0; l < LEAVES; l++) {
      writeFileSync(
        join(dir, `src/leaf-${g}-${l}.js`),
        `export const v = ${l};\nexport const label = ${JSON.stringify("leaf ".repeat(40))};\n`,
      );
      leaves.push(`import { v as v${l} } from "./leaf-${g}-${l}.js";`);
    }
    writeFileSync(join(dir, `src/group-${g}.css`), `.g${g} { color: #${g}${g}${g}; }\n`);
    writeFileSync(
      join(dir, `src/group-${g}.js`),
      `import "./group-${g}.css";\n${leaves.join("\n")}\nexport const sum = ${Array.from({ length: LEAVES }, (_, l) => `v${l}`).join(" + ")};\n`,
    );
    groups.push(`import { sum as s${g} } from "./group-${g}.js";`);
  }
  writeFileSync(join(dir, "src/hmr.js"), hmrModule("start"));
  writeFileSync(
    join(dir, "src/main.js"),
    `${groups.join("\n")}\nimport "./hmr.js";\ndocument.getElementById("out").textContent = String(${Array.from({ length: GROUPS }, (_, g) => `s${g}`).join(" + ")});\n`,
  );
  return dir;
}
const hmrModule = (text) =>
  `document.getElementById("hmr").textContent = ${JSON.stringify(text)};\nif (import.meta.hot) import.meta.hot.accept();\n`;
const EXPECTED_SUM = String(GROUPS * ((LEAVES * (LEAVES - 1)) / 2));
const MODULES = GROUPS * (LEAVES + 2) + 2; // leaves, group js + css, main, hmr

async function vite(shareFor) {
  const requireWeb = createRequire(join(root, "apps/web/package.json"));
  const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
  const { chromium } = createRequire(import.meta.url)("playwright");
  const dir = viteProject();
  const port = await freePort();
  const server = await createServer({
    root: dir,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  const direct = `http://localhost:${port}`;
  const shareUrl = await shareFor(port);
  const browser = await chromium.launch();

  // One profile per side. The pipe's profile carries the Wurmhol session and goes through the
  // real viewer sign-in redirects once, so the timed loads below see only the page.
  async function context(url) {
    const ctx = await browser.newContext();
    if (url === direct) return ctx;
    const signin = await ctx.newPage();
    await signin.goto(await magicLink(), { waitUntil: "load" });
    await signin.close();
    const page = await ctx.newPage();
    await page.goto(`${url}/`, { waitUntil: "load" });
    if (!page.url().startsWith(url)) throw new Error(`viewer sign-in ended at ${page.url()}`);
    await page.close();
    return ctx;
  }

  async function load(url, via) {
    const ctx = await context(url);
    const times = [];
    const counts = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      let n = 0;
      page.on("requestfinished", () => n++);
      const t = performance.now();
      await page.goto(`${url}/`, { waitUntil: "load" });
      await page.waitForFunction(
        (s) => document.getElementById("out")?.textContent === s,
        EXPECTED_SUM,
      );
      times.push(performance.now() - t);
      counts.push(n);
      await page.close();
    }
    await ctx.close();
    record(
      `Vite page, ${MODULES}-module graph, cache disabled`,
      via,
      "ms",
      times,
      `${Math.min(...counts)}–${Math.max(...counts)} requests`,
    );
  }

  async function hmr(url, via) {
    writeFileSync(join(dir, "src/hmr.js"), hmrModule("start"));
    await new Promise((r) => setTimeout(r, 300));
    const ctx = await context(url);
    const page = await ctx.newPage();
    await page.goto(`${url}/`, { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("hmr")?.textContent === "start");
    await page.evaluate(() => (window.benchKept = true));
    await new Promise((r) => setTimeout(r, 500)); // let Vite's websocket connect
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const text = `${via}-${i}-${Date.now()}`;
      const t = performance.now();
      writeFileSync(join(dir, "src/hmr.js"), hmrModule(text));
      await page.waitForFunction((s) => document.getElementById("hmr")?.textContent === s, text, {
        timeout: 15_000,
      });
      times.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 300));
    }
    const kept = await page.evaluate(() => window.benchKept === true);
    if (!kept) throw new Error(`hmr ${via}: the page reloaded instead of hot-updating`);
    record("Vite hot update, file write to DOM change", via, "ms", times, "no full reload");
    await ctx.close();
  }

  try {
    await load(direct, "direct (cold Vite)"); // fills Vite's transform cache for both sides
    await load(direct, "direct");
    await load(shareUrl, "pipe");
    await hmr(direct, "direct");
    await hmr(shareUrl, "pipe");
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Main --------------------------------------------------------------------------------------
console.log(
  `Wurmhol bench: ${base}, node ${process.version}, ${cpus().length} CPUs, runs=${RUNS}, small=${SMALL}\n`,
);
const { session, token } = await signIn();
env = {
  ...process.env,
  WURMHOL_URL: base,
  WURMHOL_TOKEN: token,
  WURMHOL_HOME: mkdtempSync(join(tmpdir(), "wurmhol-bench-")),
};
const local = await origin();
const port = local.address().port;
const direct = `http://127.0.0.1:${port}`;
try {
  console.log("Time to URL");
  await timeToUrl(port);

  const shareUrl = await cli(String(port));
  const headers = { cookie: await viewerCookie(shareUrl, session) };

  console.log("Small request");
  await small(`${direct}/small`, {}, "direct");
  await small(`${shareUrl}/small`, headers, "pipe");
  await concurrent(`${direct}/small`, {}, "direct");
  await concurrent(`${shareUrl}/small`, headers, "pipe");

  console.log("Throughput");
  await download(`${direct}/big`, {}, "direct");
  await download(`${shareUrl}/big`, headers, "pipe");
  await upload(`${direct}/upload`, {}, "direct");
  await upload(`${shareUrl}/upload`, headers, "pipe");

  console.log("Latency while another stream is busy");
  await busy(shareUrl, headers);

  if (SSE_SECONDS > 0) {
    console.log("SSE");
    await sse(shareUrl, headers);
  }

  console.log("Vite");
  await vite(async (p) => cli(String(p)));
} finally {
  await cli("stop", "--all").catch(() => {});
  local.close();
  await dispatcher.close();
}

console.log("\n| Case | Via | n | Median | Min–max | p95 |\n| --- | --- | --: | --: | --: | --: |");
for (const r of results.filter((row) => row.unit)) {
  const u = (v) => (v === undefined ? "–" : `${v.toFixed(1)} ${r.unit}`);
  console.log(
    `| ${r.name}${r.extra ? ` (${r.extra})` : ""} | ${r.via} | ${r.n} | ${u(r.median)} | ${r.min.toFixed(1)}–${r.max.toFixed(1)} | ${u(r.p95)} |`,
  );
}
if (args.json)
  writeFileSync(args.json, JSON.stringify({ base, node: process.version, results }, null, 2));
