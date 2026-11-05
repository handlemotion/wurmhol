// The ports this computer serves web pages on, for `wurmhol host` (ADR 0018). Listening TCP
// ports come from the OS (Linux's /proc, `lsof` on macOS, `netstat` on Windows); each new one is
// asked for `/` once, and offered with its page's <title> when it answers like a dev server.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import { MACHINE_LIMITS, type MachinePort } from "@wurmhol/protocol";

const run = promisify(execFile);

/** System services sit below 1024; dev servers do not. */
const MIN_PORT = 1024;
const PROBE_MS = 1500;

/** Listening ports in /proc/net/tcp{,6}: state 0A, the local port in hex after the colon. */
function fromProc(text: string) {
  const ports: number[] = [];
  for (const line of text.split("\n").slice(1)) {
    const [, local, , state] = line.trim().split(/\s+/);
    if (state !== "0A" || !local) continue;
    ports.push(Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16));
  }
  return ports;
}

/** `lsof -Fn` names (`n*:5173`, `n[::1]:3000`) or `netstat` rows (`TCP 0.0.0.0:5173 … LISTENING`). */
function fromAddresses(lines: string[]) {
  return lines.map((line) => Number(/:(\d+)$/.exec(line.trim())?.[1])).filter(Boolean);
}

async function listening(): Promise<number[]> {
  try {
    if (process.platform === "linux") {
      const files = await Promise.all(
        ["/proc/net/tcp", "/proc/net/tcp6"].map((f) => readFile(f, "utf8").catch(() => "")),
      );
      return files.flatMap(fromProc);
    }
    if (process.platform === "win32") {
      const { stdout } = await run("netstat", ["-ano", "-p", "TCP"]);
      const rows = stdout.split("\n").filter((l) => /LISTENING/i.test(l));
      return fromAddresses(rows.map((row) => row.trim().split(/\s+/)[1] ?? ""));
    }
    const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    return fromAddresses(stdout.split("\n").filter((l) => l.startsWith("n")));
  } catch {
    return [];
  }
}

/** The `<title>` of a page, decoded enough to show. */
function titleOf(html: string) {
  const raw = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  if (!raw) return null;
  const text = raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Last, so `&amp;lt;` reads as `&lt;`, not `<`.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return text.slice(0, MACHINE_LIMITS.title) || null;
}

/** `GET path` on the port, or null when nothing answers HTTP in time. */
function get(port: number, path: string): Promise<http.IncomingMessage | null> {
  return new Promise((resolve) => {
    const req = http.get(
      // A `localhost` Host passes dev servers' host checks (Vite's, webpack's).
      { host: "127.0.0.1", port, path, headers: { host: `localhost:${port}` }, timeout: PROBE_MS },
      resolve,
    );
    req.on("timeout", () => req.destroy());
    // After a response this is only its body cut short, which `read` ends on.
    req.on("error", () => resolve(null));
  });
}

/** The start of a response's body: up to 64 KiB, or less once `enough` says so. */
function read(res: http.IncomingMessage, enough: (text: string) => boolean = () => false) {
  return new Promise<string>((resolve) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 64 * 1024 || enough(text)) res.destroy();
    });
    res.on("close", () => resolve(text));
  });
}

/**
 * Whether the port is a DevTools debugger (Node's, Deno's, Chrome's, workerd's and wrangler's
 * inspectors): they all describe themselves at `/json/version` with a `Protocol-Version`.
 */
async function isDebugger(port: number) {
  const res = await get(port, "/json/version");
  if (!res) return false;
  try {
    return "Protocol-Version" in JSON.parse(await read(res));
  } catch {
    return false;
  }
}

/**
 * The port as offered, or null. A dev server answers `/` with a page, a redirect or JSON; an API
 * with no root route answers 404, so a 404 is offered too unless the port is a debugger. Other
 * errors are what debuggers (400, 500), proxies (405) and helpers that want a key (401, 403)
 * answer, and are not offered.
 */
async function probe(port: number): Promise<MachinePort | null> {
  const res = await get(port, "/");
  if (!res) return null;
  const status = res.statusCode ?? 0;
  let title: string | null = null;
  if (/text\/html/i.test(res.headers["content-type"] ?? "")) {
    // The title is in the head; no need to read a whole page.
    title = titleOf(await read(res, (text) => /<\/title>/i.test(text)));
  } else {
    res.resume();
  }
  if (status < 400 || (status === 404 && !(await isDebugger(port)))) return { port, title };
  return null;
}

/**
 * Ports never to offer: those in WURMHOL_HOST_IGNORE (`9229,5555`), and the CLI's own server's
 * when it is a local one, since a pipe to it would loop back through itself.
 */
function ignored(server: string) {
  const ports = (process.env.WURMHOL_HOST_IGNORE ?? "").split(/[\s,]+/).map(Number);
  const own = new URL(server);
  if (["localhost", "127.0.0.1", "[::1]"].includes(own.hostname)) ports.push(Number(own.port));
  return ports.filter((port) => Number.isInteger(port) && port > 0);
}

/** A port that was not offered is asked again after this: a dev server may still be starting. */
const RETRY_MS = 30_000;

/** Watches this computer's web ports; remembers each port's answer while it stays open. */
export class PortScanner {
  #known = new Map<number, { answer: MachinePort | null; at: number }>();
  readonly #skip: Set<number>;

  /** `server`: the origin the CLI dials, never offered when it is on this computer. */
  constructor(server: string) {
    this.#skip = new Set(ignored(server));
  }

  async scan(): Promise<MachinePort[]> {
    const open = new Set((await listening()).filter((p) => p >= MIN_PORT && !this.#skip.has(p)));
    for (const port of this.#known.keys()) if (!open.has(port)) this.#known.delete(port);
    const now = Date.now();
    const fresh = [...open].filter((port) => {
      const known = this.#known.get(port);
      return !known || (known.answer === null && now - known.at > RETRY_MS);
    });
    const answers = await Promise.all(fresh.map((port) => probe(port)));
    fresh.forEach((port, i) => this.#known.set(port, { answer: answers[i] ?? null, at: now }));
    return [...this.#known.values()]
      .map((known) => known.answer)
      .filter((p): p is MachinePort => p !== null)
      .toSorted((a, b) => a.port - b.port)
      .slice(0, MACHINE_LIMITS.ports);
  }
}
