// The ports this computer serves web pages on, for `wurmhol host` (ADR 0018). Listening TCP
// ports come from the OS (Linux's /proc, `lsof` on macOS, `netstat` on Windows); each new one is
// asked for `/` once, and only those that answer HTTP are offered, with their page's <title>.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LocalPort {
  port: number;
  title: string | null;
}

/** Most ports the CLI reports: the relay refuses more. */
const MAX_PORTS = 64;
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
  return text.slice(0, 200) || null;
}

/** Whether the port answers HTTP, and the title of its `/` when it is HTML. Null if not HTTP. */
function probe(port: number): Promise<LocalPort | null> {
  return new Promise((resolve) => {
    let answered = false;
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { host: `localhost:${port}` },
        timeout: PROBE_MS,
      },
      (res) => {
        answered = true;
        if (!/text\/html/i.test(res.headers["content-type"] ?? "")) {
          res.resume();
          return resolve({ port, title: null });
        }
        let html = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          html += chunk;
          // The title is in the head; no need to read a whole page.
          if (html.length > 64 * 1024 || /<\/title>/i.test(html)) res.destroy();
        });
        res.on("close", () => resolve({ port, title: titleOf(html) }));
      },
    );
    req.on("timeout", () => req.destroy());
    // Once it answered, a reset is only the page cut short after its title.
    req.on("error", () => answered || resolve(null));
  });
}

/** A port that did not answer HTTP is asked again after this: a dev server may still be starting. */
const RETRY_MS = 30_000;

/** Watches this computer's web ports; remembers each port's answer while it stays open. */
export class PortScanner {
  #known = new Map<number, { answer: LocalPort | null; at: number }>();
  readonly #skip: Set<number>;

  /** `skip`: ports never to offer, like a pipe's own local listener. */
  constructor(skip: Iterable<number> = []) {
    this.#skip = new Set(skip);
  }

  async scan(): Promise<LocalPort[]> {
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
      .filter((p): p is LocalPort => p !== null)
      .toSorted((a, b) => a.port - b.port)
      .slice(0, MAX_PORTS);
  }
}
