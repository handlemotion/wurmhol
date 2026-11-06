// E2E support: the real stack, nothing faked. Each test file starts its own `wrangler dev` (real
// workerd, local D1 and Durable Objects persisted to a temp dir), signs people in through Better
// Auth's real magic-link flow, starts the real CLI (built `dist/cli.js`) as a detached process,
// and talks to shares the way a browser does: through the share host, with cookies.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { Agent, request as undiciRequest } from "undici";
import WebSocket from "ws";
import { e2eConfig, workerRoot } from "./global-setup.ts";

const run = promisify(execFile);
export const cliPath = join(workerRoot, "../../packages/cli/dist/cli.js");

/** Every `*.localhost` name is this machine, as browsers treat it. */
function localLookup(
  hostname: string,
  options: unknown,
  callback: (
    error: Error | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const all =
      typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (all) return callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return callback(null, "127.0.0.1", 4);
  }
  return callback(new Error(`e2e lookup refused ${hostname}`), "", 4);
}

const dispatcher = new Agent({ connect: { lookup: localLookup as never } });

/**
 * A request that resolves `*.localhost` like a browser, sends exactly the headers given (fetch
 * would add its own `sec-fetch-mode`), and never follows redirects.
 */
export async function browserFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    cookie?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  const result = await undiciRequest(url, {
    method: (init.method ?? "GET") as "GET",
    headers,
    body: init.body,
    dispatcher,
  });
  const out = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    for (const v of Array.isArray(value) ? value : [value])
      if (v !== undefined) out.append(name, v);
  }
  const empty = [204, 205, 304].includes(result.statusCode) || init.method === "HEAD";
  if (empty) await result.body.dump();
  return new Response(empty ? null : (Readable.toWeb(result.body) as ReadableStream), {
    status: result.statusCode,
    headers: out,
  });
}

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  { timeoutMs = 10_000, intervalMs = 50, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Opens a SQLite file the local stack writes to. workerd holds a write lock while it commits, so
 * the connection waits out a busy database instead of failing with "database is locked".
 */
export function openSqlite(file: string, options: { readOnly?: boolean } = {}) {
  return new DatabaseSync(file, { readOnly: options.readOnly ?? false, timeout: 5000 });
}

export interface Stack {
  url: string;
  /** Everything wrangler dev printed so far (the simulated Email binding logs each email). */
  output(): string;
  port: number;
  shareUrl(id: string): string;
  /** The local D1 database, read-only unless `write` (to seed what has no route, like an OAuth client). */
  db(options?: { write?: boolean }): DatabaseSync;
  /**
   * Stops wrangler dev and starts it again on the same port and persisted state, as a deploy
   * replaces the Worker. `whileStopped` runs in between, with no process holding the state.
   */
  restart(whileStopped?: () => void | Promise<void>): Promise<void>;
  /** The SQLite file of every Durable Object of `className` (e.g. `Org`). */
  durableObjects(className: string): string[];
  stop(): Promise<void>;
}

/** `wrangler dev` with a fresh local D1 (migrated) and fresh Durable Objects. */
export async function startStack(vars: Record<string, string> = {}): Promise<Stack> {
  const persist = mkdtempSync(join(tmpdir(), "wurmhol-e2e-"));
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const wrangler = join(workerRoot, "node_modules/.bin/wrangler");
  await run(
    wrangler,
    ["d1", "migrations", "apply", "wurmhol", "--local", "--persist-to", persist, "-c", e2eConfig],
    {
      cwd: workerRoot,
      env: { ...process.env, CI: "1" },
    },
  );
  const allVars: Record<string, string> = {
    ENVIRONMENT: "test",
    BETTER_AUTH_URL: url,
    BETTER_AUTH_SECRET: "e2e-auth-secret-e2e-auth-secret-e2e-auth",
    SHARE_DOMAIN: "pipe.localhost",
    AUTH_TRUSTED_ORIGINS: url,
    RATE_LIMIT_AUTH: "off",
    RATE_LIMIT_CONNECT: "off",
    RATE_LIMIT_MANAGE: "off",
    ...vars,
  };
  const args = [
    "dev",
    "-c",
    e2eConfig,
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persist,
    "--show-interactive-dev-session=false",
  ];
  for (const [key, value] of Object.entries(allVars)) args.push("--var", `${key}:${value}`);
  let output = "";
  const launch = async () => {
    const inspector = ["--inspector-port", String(await freePort())];
    const child = spawn(wrangler, [...args, ...inspector], {
      cwd: workerRoot,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    try {
      await waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${output}`);
          const response = await fetch(`${url}/health`).catch(() => null);
          return response?.ok;
        },
        { timeoutMs: 60_000, intervalMs: 200, what: "wrangler dev" },
      );
    } catch (error) {
      process.kill(-child.pid!, "SIGKILL");
      throw error;
    }
    return child;
  };
  const kill = async (child: ChildProcess) => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // Already gone.
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  let child = await launch();
  const dbFile = () => {
    const dir = join(persist, "v3/d1/miniflare-D1DatabaseObject");
    const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    if (!file) throw new Error("no local D1 database");
    return join(dir, file);
  };
  return {
    url,
    port,
    output: () => output,
    shareUrl: (id) => `http://${id}.pipe.localhost:${port}`,
    db: (options) => openSqlite(dbFile(), { readOnly: !options?.write }),
    restart: async (whileStopped) => {
      await kill(child);
      await whileStopped?.();
      child = await launch();
    },
    durableObjects: (className) => {
      const dir = join(persist, "v3/do", `wurmhol-${className}`);
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
            .map((f) => join(dir, f))
        : [];
    },
    stop: async () => {
      await kill(child);
      rmSync(persist, { recursive: true, force: true });
    },
  };
}

/** The `name=value` pairs of every Set-Cookie on a response. */
export function cookiesOf(response: Response) {
  return response.headers.getSetCookie().map((c) => c.split(";")[0]!);
}

export interface Person {
  email: string;
  /** The app's session cookie(s), as a Cookie header. */
  cookie: string;
}

/**
 * Signs `email` in through Better Auth's magic-link flow; the link's token is read from D1.
 * `headers` go on the request that creates the session.
 */
export async function signIn(
  stack: Stack,
  email = `${randomUUID()}@example.com`,
  headers: Record<string, string> = {},
): Promise<Person> {
  const sent = await browserFetch(`${stack.url}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: stack.url },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!sent.ok) throw new Error(`magic link: ${sent.status} ${await sent.text()}`);
  const token = await waitFor(
    () => {
      const db = stack.db();
      try {
        const rows = db.prepare("select identifier, value from verifications").all() as {
          identifier: string;
          value: string;
        }[];
        return rows
          .find((r) => r.identifier.startsWith("magic-link:") && r.value.includes(email))
          ?.identifier.slice(11);
      } finally {
        db.close();
      }
    },
    { what: "magic link token" },
  );
  const verified = await browserFetch(
    `${stack.url}/api/auth/magic-link/verify?token=${token}&callbackURL=%2F`,
    { headers },
  );
  const cookie = cookiesOf(verified).join("; ");
  if (!cookie.includes("session_token")) throw new Error(`no session cookie (${verified.status})`);
  return { email, cookie };
}

/** A JSON API call as `person`, from the app's own origin. */
export async function api<T = unknown>(
  stack: Stack,
  person: Person | null,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await browserFetch(`${stack.url}${path}`, {
    method: init.method ?? "GET",
    cookie: person?.cookie,
    headers: { origin: stack.url, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

export async function me(stack: Stack, person: Person) {
  return (await api<{ activeOrgId: string; user: { id: string } }>(stack, person, "/api/me")).body;
}

export async function createToken(
  stack: Stack,
  person: Person,
  name = "e2e",
  options: { scope?: "pipes" | "org"; expiresInDays?: 30 | 90 | null } = {},
) {
  const { status, body } = await api<{
    id: string;
    token: string;
    host: string;
    url: string | null;
  }>(stack, person, "/api/tokens", {
    method: "POST",
    body: { name, ...options },
  });
  if (status !== 201) throw new Error(`token: ${status}`);
  return body;
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs the real CLI to completion (`wurmhol <port>` returns once its daemon is ready). */
export async function cli(
  args: string[],
  env: Record<string, string>,
  options: { cwd?: string } = {},
): Promise<CliRun> {
  const started = Date.now();
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr, ms: Date.now() - started };
}

/** CLI environment for `token` against `stack`, with its own state dir. */
export function cliEnv(stack: Stack, token: string, extra: Record<string, string> = {}) {
  return {
    WURMHOL_URL: stack.url,
    WURMHOL_TOKEN: token,
    WURMHOL_HOME: mkdtempSync(join(tmpdir(), "wurmhol-home-")),
    ...extra,
  };
}

/** Starts a share of `port` and returns its id and URL. */
export async function share(stack: Stack, env: Record<string, string>, port: number) {
  const result = await cli([String(port), "--json"], env);
  if (result.code !== 0) throw new Error(`wurmhol ${port} failed: ${result.stderr}`);
  return {
    ...(JSON.parse(result.stdout.split("\n")[0]!) as { id: string; url: string; port: number }),
    ms: result.ms,
  };
}

/** Stops every share the CLI state dir in `env` knows. */
export async function stopAll(env: Record<string, string>) {
  await cli(["stop", "--all"], env);
}

/** Signs `person` in to a share the way a browser does: share → /open → code → cookie. */
export async function viewerCookie(stack: Stack, person: Person, shareUrl: string) {
  const first = await browserFetch(`${shareUrl}/`, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
  });
  const open = first.headers.get("location");
  if (first.status !== 302 || !open)
    throw new Error(`share did not send the viewer to sign in: ${first.status}`);
  const back = await browserFetch(open, { cookie: person.cookie });
  const callback = back.headers.get("location") ?? "";
  if (!callback.startsWith(shareUrl))
    throw new Error(`/open did not send the viewer back: ${back.status} ${callback}`);
  const set = await browserFetch(callback);
  const cookie = cookiesOf(set).find((c) => c.startsWith("__Host-wurmhol="));
  if (!cookie) throw new Error("no share cookie");
  return cookie;
}

/** A WebSocket client that resolves `*.localhost` like a browser. */
export function browserSocket(url: string, protocols: string[], headers: Record<string, string>) {
  return new WebSocket(url.replace(/^http/, "ws"), protocols, {
    headers,
    lookup: localLookup as never,
  });
}

/** A real local HTTP server for the dev server's side. */
export async function localServer(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, close: () => closeServer(server) };
}

function closeServer(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * An HTTP CONNECT proxy like a sandbox's egress proxy: it tunnels only to allowed ports (403
 * otherwise), and can cut every open tunnel to simulate a dropped connection.
 */
export async function connectProxy(allowPorts: number[]) {
  const tunnels = new Set<Socket>();
  let connects = 0;
  const server = createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client: Socket, head) => {
    connects++;
    const [host, portText] = (req.url ?? "").split(":");
    const port = Number(portText);
    if (!allowPorts.includes(port)) {
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const upstream = netConnect(
      port,
      host === "localhost" || host!.endsWith(".localhost") ? "127.0.0.1" : host!,
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      },
    );
    tunnels.add(client);
    tunnels.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      tunnels.delete(client);
      tunnels.delete(upstream);
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get connects() {
      return connects;
    },
    /** Cuts every tunnel, as a proxy that drops long connections would. */
    cutAll() {
      for (const socket of tunnels) socket.destroy();
      tunnels.clear();
    },
    close: () => {
      for (const socket of tunnels) socket.destroy();
      return closeServer(server);
    },
  };
}

export function sha256(data: Uint8Array | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

/** Whether a process is alive. */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function shareStates(env: Record<string, string>) {
  const dir = join(env.WURMHOL_HOME!, "shares");
  return existsSync(dir) ? readdirSync(dir) : [];
}

export type { ChildProcess };
