// A pipe in the caller's process: `openPipe`, the `wurmhol` package's export, and the CLI's daemon, which
// adds only its state file and log on top (ADR 0008, section 3).
import { EventEmitter } from "node:events";
import {
  isEndReason,
  parseDuration,
  PIPE_NAME_RULE,
  pipeName,
  SOURCE_FIELDS,
  SOURCE_FIXES,
  sourceField,
} from "@wurmhol/protocol";
import pkg from "../package.json" with { type: "json" };
import { FixError } from "./errors.ts";
import { type RequestEvent, Tunnel } from "./tunnel.ts";

/** The CLI dials api.wurmhol.com; people sign in and make tokens at the console (ADR 0006). */
export const DEFAULT_SERVER = "https://api.wurmhol.com";
export const DEFAULT_CONSOLE = "https://dirt.wurmhol.com";

export type { RequestEvent };

/** Where a pipe comes from, as the wall shows it. Every field is optional. */
export interface PipeSource {
  /** The forge's host, like `github.com`. */
  repoHost: string | null;
  /** The repo's path on the forge, like `owner/name`. */
  repo: string | null;
  branch: string | null;
  /** The full commit hash. */
  commit: string | null;
  /** An http(s) link to show with the pipe, like its issue. */
  link: string | null;
  /** One line of text, at most 280 characters. */
  note: string | null;
  /** The agent that opened it, like `Claude Code`. */
  agent: string | null;
  /** The agent session's page, http(s). */
  agentUrl: string | null;
}

/** A caller's source, checked field by field; null when it sets nothing. */
function checkSource(raw: Partial<PipeSource> | undefined): PipeSource | null {
  if (!raw) return null;
  const source = Object.fromEntries(SOURCE_FIELDS.map((f) => [f, null])) as Record<
    keyof PipeSource,
    string | null
  >;
  let any = false;
  for (const field of SOURCE_FIELDS) {
    const value = raw[field];
    if (value === null || value === undefined) continue;
    const checked = sourceField(field, value);
    if (checked === null) throw new FixError(SOURCE_FIXES[field]);
    source[field] = checked;
    any = true;
  }
  return any ? source : null;
}

/**
 * Why a pipe ended. Every reason is final: open a new pipe to share the port again. Spelled out,
 * not imported, so the public `.d.ts` stands alone; `onEnd` fails to compile if protocol's
 * `EndReason` gains a reason this lacks.
 */
export type CloseReason =
  | "stopped"
  | "terminated"
  | "expired"
  | "revoked"
  | "limit"
  | "disconnected"
  | "no_subscription";

export interface OpenPipeOptions {
  /** The local port the dev server listens on. */
  port: number;
  /** A token from the org (`wh_…`): the console's menu → Tokens. */
  token: string;
  /** A self-hosted install's origin. Default `https://api.wurmhol.com`. */
  server?: string;
  /**
   * Where the dev server listens. Default: `127.0.0.1`, or `::1` when only that answers (Vite on
   * Node 17+). Either way it sees `Host: localhost:<port>`.
   */
  host?: string;
  /**
   * How long the pipe lasts: seconds, or a duration like `"90m"` or `"8h"`. Default 4 hours on
   * wurmhol.com, at most 12; a longer one rejects with a fix that names the limit.
   */
  ttl?: number | string;
  /**
   * Emails of the org members who may open the pipe. They must be members of the token's org, or
   * `openPipe` rejects. Default: every member of the org.
   */
  viewers?: string[];
  /**
   * A name for a pipe that keeps its URL: `"my-app"` opens `https://my-app.wurmhol.dev` every
   * time, so it can be registered as an OAuth redirect URI. The first org to use a name keeps it;
   * one pipe per name is open at a time.
   */
  name?: string;
  /**
   * Where the pipe comes from, shown on the wall: `{ repo: "acme/app", branch: "feat/x",
   * link: "https://…", note: "…" }` and the rest of the fields of `PipeSource`. Every field is
   * optional; an invalid one rejects with a fix. The CLI fills it from git and the environment.
   */
  source?: Partial<PipeSource>;
  /** Aborting rejects a pending `openPipe`, or closes an open pipe. */
  signal?: AbortSignal;
  /**
   * The connection's own events, for diagnosing a pipe: `connected`, `disconnected` (`code`,
   * `reason`), `reconnected`, `reconnect.failed` (`message`), `heartbeat.missed`, `socket.error`,
   * `protocol.error` and `ended` (`reason`). Never request contents. A throw here is ignored.
   */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** The CLI's daemon logs to a file named after the share, so it also needs the share id. */
export interface Internals {
  log?: (shareId: string | null, event: string, fields: Record<string, unknown>) => void;
}

export interface PipeEvents {
  /** A viewer request the dev server answered. Never sent anywhere: it stays in this process. */
  request: (event: RequestEvent) => void;
  /** The pipe ended for good. Emitted once. */
  close: (reason: CloseReason) => void;
}

/** An open pipe. Emits `request` per answered viewer request and `close` once when it ends. */
export interface Pipe {
  /** The share id, as on the wall and in `wurmhol ls`. */
  readonly id: string;
  /** The private URL to send the humans. */
  readonly url: string;
  readonly port: number;
  /** When the relay ends the pipe (reason `expired`). */
  readonly endsAt: Date;
  on<E extends keyof PipeEvents>(event: E, listener: PipeEvents[E]): this;
  once<E extends keyof PipeEvents>(event: E, listener: PipeEvents[E]): this;
  off<E extends keyof PipeEvents>(event: E, listener: PipeEvents[E]): this;
  /** Ends the pipe on purpose; resolves once it has ended (the relay ends it at once). */
  close(): Promise<void>;
}

class OpenPipe implements Pipe {
  readonly id: string;
  readonly url: string;
  readonly port: number;
  readonly endsAt: Date;
  readonly #events = new EventEmitter();
  readonly #tunnel: Tunnel;
  readonly #closed: Promise<CloseReason>;

  constructor(
    info: { id: string; url: string; endsAt: string; port: number },
    tunnel: Tunnel,
    closed: Promise<CloseReason>,
  ) {
    this.id = info.id;
    this.url = info.url;
    this.port = info.port;
    this.endsAt = new Date(info.endsAt);
    this.#tunnel = tunnel;
    this.#closed = closed;
  }

  on<E extends keyof PipeEvents>(event: E, listener: PipeEvents[E]) {
    this.#events.on(event, listener);
    return this;
  }

  once<E extends keyof PipeEvents>(event: E, listener: PipeEvents[E]) {
    this.#events.once(event, listener);
    return this;
  }

  off<E extends keyof PipeEvents>(event: E, listener: PipeEvents[E]) {
    this.#events.off(event, listener);
    return this;
  }

  emit<E extends keyof PipeEvents>(event: E, ...args: Parameters<PipeEvents[E]>) {
    this.#events.emit(event, ...args);
  }

  async close() {
    await this.#tunnel.stop();
    await this.#closed;
  }
}

/** A server URL's origin, or a FixError naming WURMHOL_URL, where the CLI's server comes from. */
export function originOf(server: string) {
  try {
    return new URL(server).origin;
  } catch {
    throw new FixError(`WURMHOL_URL is not a URL: ${server}`);
  }
}

/**
 * Opens a pipe to `port` and resolves once the relay has given it its URL, or rejects with a
 * `FixError` whose message is the one-line fix the CLI prints.
 */
export async function openPipe(options: OpenPipeOptions, internals: Internals = {}): Promise<Pipe> {
  const server = originOf(options.server ?? DEFAULT_SERVER);
  const token = options.token?.trim();
  if (!token) {
    const console = options.server ? server : DEFAULT_CONSOLE;
    throw new FixError(`Set WURMHOL_TOKEN to a token from ${console} (menu → Tokens).`);
  }
  const ttl = typeof options.ttl === "string" ? parseDuration(options.ttl) : options.ttl;
  if (ttl !== undefined && (ttl === null || !Number.isSafeInteger(ttl) || ttl < 1)) {
    throw new FixError(`Not a lifetime: ${options.ttl}. Use one like 90m or 8h.`);
  }
  const name = options.name === undefined ? undefined : pipeName(options.name);
  if (name === null) {
    throw new FixError(`Not a pipe name: ${options.name}. Use ${PIPE_NAME_RULE}.`);
  }
  const source = checkSource(options.source);
  const { signal } = options;
  signal?.throwIfAborted();

  let pipe: OpenPipe | null = null;
  let markClosed!: (reason: CloseReason) => void;
  const closed = new Promise<CloseReason>((resolve) => (markClosed = resolve));
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    internals.log?.(tunnel.share?.id ?? null, event, fields);
    try {
      options.log?.(event, fields);
    } catch {
      // The caller's logging must never take the pipe down.
    }
  };
  const tunnel: Tunnel = new Tunnel({
    server,
    token,
    port: options.port,
    host: options.host,
    ttl,
    viewers: options.viewers ?? [],
    name,
    source,
    version: pkg.version,
    log,
    onRequest: (event) => pipe?.emit("request", event),
    onEnd: (raw) => {
      log("ended", { reason: raw });
      signal?.removeEventListener("abort", onAbort);
      // A refusal on reconnect can carry the relay's own words; any of those means the pipe
      // could not be resumed.
      const reason: CloseReason = isEndReason(raw) ? raw : "disconnected";
      markClosed(reason);
      pipe?.emit("close", reason);
    },
  });
  const onAbort = () => void tunnel.stop();

  const started = tunnel.start();
  let info;
  if (signal) {
    let stopWaiting!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      const listener = () => reject(signal.reason);
      signal.addEventListener("abort", listener, { once: true });
      stopWaiting = () => signal.removeEventListener("abort", listener);
    });
    try {
      info = await Promise.race([started, aborted]);
    } catch (error) {
      // Aborted mid-dial: end the pipe if the dial still succeeds.
      started.then(
        () => tunnel.stop(),
        () => {},
      );
      throw error;
    } finally {
      stopWaiting();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  } else {
    info = await started;
  }
  pipe = new OpenPipe({ ...info, port: options.port }, tunnel, closed);
  return pipe;
}
