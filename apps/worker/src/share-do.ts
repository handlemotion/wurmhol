// One Share Durable Object per share (spec section 5). It holds the CLI's WebSocket (hibernation
// API), multiplexes every viewer request and browser WebSocket over it as streams
// (`@wurmhol/protocol`), records the page title and the last request for the wall, and enforces
// the share's limits: its lifetime, the org's monthly bytes, and membership of each viewer (and,
// when the CLI named some, that the viewer is one of them). It keeps the view log: per viewer,
// first and last seen and a request count, never paths, IPs or user agents (ADR 0008).
//
// A new pipe's title and favicon are on the wall before anyone opens it: the object asks the dev
// server for `/` itself (`#probe`) and reads the page's start, the same as a viewer's first page.
//
// Request and response bodies pass through and are never logged or stored. Only the `<title>`
// of HTML responses and the favicon are kept, while the share is open: at its end the object
// keeps a tombstone (`state`, `endReason`) and nothing else. The viewer's IP is not forwarded.
import { DurableObject } from "cloudflare:workers";
import {
  createDb,
  findMember,
  randomSecret,
  recordShareEnd,
  recordShareViews,
  type ShareView,
  sha256Hex,
} from "@wurmhol/db";
import {
  chunk,
  CLOSE_CODES,
  decodeFrame,
  encodeFrame,
  type EndReason,
  FIRST_STREAM_ID,
  forwardable,
  forwardedHeaders,
  type Frame,
  HttpStreamOrder,
  nextStreamId,
  PING_TEXT,
  pipeSetCookie,
  type PipeSource,
  PONG_TEXT,
  ProtocolError,
  ReceiveWindow,
  RECONNECT_GRACE_MS,
  REPLACED_CLOSE_CODE,
  type RequestHead,
  type ResponseHead,
  SendWindow,
  sendableCloseCode,
  SHARE_HEADERS,
  viewerRequestHeaders,
  WAITING_HEADER,
  type WsClosePayload,
  type WsOpenPayload,
} from "@wurmhol/protocol";
import { refuse } from "./bearer.ts";
import { loadConfig } from "./env.ts";
import { type Preview, postPreview, retirePreview } from "./github.ts";
import { createLogger } from "./log.ts";
import { orgStub } from "./org-do.ts";
import { extractFaviconPath, extractTitle, readStart } from "./html-head.ts";
import { errorPage } from "./pages.ts";

/** What the Worker tells a new share's object when its CLI first connects. */
export interface ShareInit {
  id: string;
  orgId: string;
  tokenId: string;
  port: number;
  url: string;
  startedBy: string | null;
  startedAt: number;
  /** User ids that may open it (`--only`); null: every member of the org. */
  viewers: string[] | null;
  /** Where it came from (ADR 0015), as the CLI said; null when it said nothing. */
  source: PipeSource | null;
  limits: { seconds: number; monthlyBytes: number };
}

interface Meta extends ShareInit {
  state: "live" | "away";
  awaySince: number | null;
  title: string | null;
  faviconPath: string | null;
  favicon: boolean;
  lastRequestAt: number | null;
  bytes: number;
  /** When the start-of-pipe probe (`#probe`) runs again, and which retry that is; null: done. */
  probe?: { at: number; attempt: number } | null;
  /** Deployments on the pipe's pull request (ADR 0016); absent in pipes from before it. */
  previews?: Preview[];
}

/** One viewer's line in the view log, with their name for the wall once looked up. */
interface View extends ShareView {
  name: string | null;
  flushedAt: number;
}

/** All an ended share keeps: enough to answer "ended", and why, to a viewer or its CLI. */
interface Tombstone {
  state: "ended";
  endReason: EndReason;
}

/** Headers the Worker uses to talk to this object; never forwarded, never trusted from clients. */
const INTERNAL_HEADERS = {
  /** To the object: the CLI's socket, from the bearer-checked `/connect` route only. */
  cli: "x-wurmhol-cli",
  /** To the object: a new share's `ShareInit`, as JSON. */
  init: "x-wurmhol-init",
  /** To the object: the signed-in viewer's user id. */
  viewer: "x-wurmhol-viewer",
  /** From the object: the viewer may no longer open the share. */
  refused: "x-wurmhol-refused",
} as const;

/** The share's Durable Object: one per share, named by its id. */
export function shareStub(env: Env, shareId: string) {
  return env.SHARE.get(env.SHARE.idFromName(shareId));
}

/**
 * A client's request rebuilt for the object: our own headers are never taken from the client,
 * only the ones set here. `cli` is the CLI's socket, a bodiless GET to `/connect` (with a new
 * share's `ShareInit`, or null to bring one back); `viewer` is a signed-in viewer's request.
 */
export function toShare(
  raw: Request,
  internal: { cli: ShareInit | null } | { viewer: string },
): Request {
  const headers = new Headers(raw.headers);
  for (const name of Object.values(INTERNAL_HEADERS)) headers.delete(name);
  if ("viewer" in internal) {
    headers.set(INTERNAL_HEADERS.viewer, internal.viewer);
    return new Request(raw, { headers });
  }
  headers.set(INTERNAL_HEADERS.cli, "1");
  if (internal.cli) headers.set(INTERNAL_HEADERS.init, JSON.stringify(internal.cli));
  return new Request(new URL("/connect", raw.url), { headers });
}

/**
 * The refusal for a CLI coming back to a share that ended (with why), or that is not its own or
 * never existed (`null`).
 */
export function shareGone(reason: EndReason | null) {
  const fix = "Start a new pipe: npx wurmhol <port>.";
  return reason ? refuse(410, "share ended", fix, { reason }) : refuse(404, "share not found", fix);
}

/** Whether the object refused the viewer (removed from the org, or not on the share's list). */
export function refusedViewer(response: Response) {
  return response.headers.has(INTERNAL_HEADERS.refused);
}

/** How long a viewer's membership check stays good before D1 is asked again. */
const MEMBERSHIP_TTL_MS = 10_000;
/** Longest wait for the local server's status line. Cloudflare's own edge gives up at 100 s. */
const RESPONSE_HEAD_TIMEOUT_MS = 100_000;
/** How long a viewer request waits for an away CLI to come back before it is answered. */
const AWAY_WAIT_MS = 10_000;
/** Bytes of an HTML response read for its `<title>`. */
const TITLE_SCAN_BYTES = 64 * 1024;
const FAVICON_MAX_BYTES = 100 * 1024;
/**
 * When a new pipe connects, the relay asks the dev server for `/` itself, so the wall has the
 * favicon (and title) before anyone opens it. A server not listening yet answers with the CLI's
 * waiting page (`WAITING_HEADER`); the probe tries again after each of these delays.
 */
const PROBE_RETRY_MS = [2_000, 5_000, 10_000, 20_000];
const PROBE_FIRST_MS = 1_000;
/** Usage goes to the Org object at most this often, or once this many bytes piled up. */
const USAGE_FLUSH_MS = 5_000;
const USAGE_FLUSH_BYTES = 8 * 1024 * 1024;
/** The wall's "last request" line updates at most this often. */
const LAST_REQUEST_PUSH_MS = 5_000;
/** A viewer's counts go to D1 and the wall when they first open the share, then at most this often. */
const VIEW_FLUSH_MS = 30_000;
/** One-time viewer codes (spec section 6). */
const CODE_TTL_MS = 60_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A stream that fails before anyone awaits it must not become an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface HttpStream {
  kind: "http";
  order: HttpStreamOrder;
  /** Credit for the request body we send. */
  send: SendWindow;
  /** Credit we grant for the response body. */
  receive: ReceiveWindow;
  head: Deferred<ResponseHead>;
  queue: Uint8Array[];
  wake: (() => void) | null;
  ended: boolean;
  error: string | null;
  closed: boolean;
}

interface WsStream {
  kind: "ws";
  opened: Deferred<WsOpenPayload>;
}

const textDecoder = new TextDecoder();

export class Share extends DurableObject<Env> {
  #streams = new Map<number, HttpStream | WsStream>();
  #members = new Map<string, number>();
  #pendingUsage = 0;
  #lastUsageFlush = 0;
  #lastRequestPush = 0;
  #previewing: Promise<void> | null = null;
  #log = createLogger({ component: "share" });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The CLI's heartbeat is answered by the runtime, without waking this object (ADR 0002).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
  }

  // --- State -------------------------------------------------------------------------------

  #stored(): Meta | Tombstone | undefined {
    return this.ctx.storage.kv.get<Meta | Tombstone>("meta");
  }

  /** The open share's meta; undefined when it never started or has ended. */
  #meta(): Meta | undefined {
    const stored = this.#stored();
    return stored?.state === "ended" ? undefined : stored;
  }

  /** Writes an open share's meta. Never over a tombstone: a request in flight at the end must
   * not bring the title back. */
  #save(meta: Meta) {
    if (this.#stored()?.state === "ended") return;
    this.ctx.storage.kv.put("meta", meta);
  }

  #org(orgId: string) {
    return orgStub(this.env, orgId);
  }

  #cli(): WebSocket | null {
    return (
      this.ctx.getWebSockets("cli").find((socket) => socket.readyState === WebSocket.OPEN) ?? null
    );
  }

  /** Kept in storage: a viewer's WebSocket stream outlives hibernation, so its id must too. */
  #nextStream() {
    const id = this.ctx.storage.kv.get<number>("nextStream") ?? FIRST_STREAM_ID;
    this.ctx.storage.kv.put("nextStream", nextStreamId(id));
    return id;
  }

  #send(frame: Frame) {
    const cli = this.#cli();
    if (!cli) throw new ProtocolError("the CLI is not connected");
    cli.send(encodeFrame(frame));
  }

  #armAlarm(meta: Meta) {
    const expires = meta.startedAt + meta.limits.seconds * 1000;
    const away = meta.awaySince === null ? Infinity : meta.awaySince + RECONNECT_GRACE_MS;
    const probe = meta.probe?.at ?? Infinity;
    void this.ctx.storage.setAlarm(Math.min(expires, away, probe));
  }

  // --- RPC from the Worker ------------------------------------------------------------------

  /** The share's state for the Worker's routing: unknown, open (live or away), or ended. */
  status() {
    const stored = this.#stored();
    if (!stored) return { state: "unknown" as const };
    if (stored.state === "ended") return { state: "ended" as const };
    return { state: stored.state, orgId: stored.orgId, tokenId: stored.tokenId, port: stored.port };
  }

  /** A one-time code for `userId` (60 s, single use), after the app checked their membership. */
  async issueCode(userId: string) {
    const code = randomSecret(24);
    this.ctx.storage.kv.put(`code:${await sha256Hex(code)}`, {
      userId,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    return code;
  }

  /** Whether `userId` is on the share's list of viewers, when it has one. Membership is separate. */
  mayView(userId: string) {
    const viewers = this.#meta()?.viewers;
    return !viewers || viewers.includes(userId);
  }

  /** Swaps a one-time code for the user it was issued to, once. */
  async redeemCode(code: string): Promise<string | null> {
    const key = `code:${await sha256Hex(code)}`;
    const entry = this.ctx.storage.kv.get<{ userId: string; expiresAt: number }>(key);
    if (!entry) return null;
    this.ctx.storage.kv.delete(key);
    return entry.expiresAt > Date.now() ? entry.userId : null;
  }

  /** Ends the share now: the wall's Terminate, a revoked token, a lapsed plan. */
  async terminate(reason: EndReason) {
    await this.#end(reason);
  }

  /**
   * Posts the pipe to the open pull request of its branch, once (ADR 0016): when it starts, and
   * again when GitHub says a pull request for its branch opened. Calls at once share one attempt.
   */
  preview() {
    this.#previewing ??= this.#preview().finally(() => (this.#previewing = null));
    return this.#previewing;
  }

  async #preview() {
    const meta = this.#meta();
    const config = loadConfig(this.env);
    if (!meta?.source || !config.github || meta.previews?.length) return;
    try {
      const preview = await postPreview(config.github, createDb(this.env.DB), meta);
      if (!preview) return;
      const current = this.#meta();
      if (!current) {
        // The pipe ended while the deployment was being made: retire it now.
        await retirePreview(config.github, preview);
        return;
      }
      current.previews = [preview];
      this.#save(current);
      await this.#org(current.orgId).update(current.id, {
        preview: { pullRequest: preview.pullRequest, url: preview.pullRequestUrl },
      });
      this.#log.info("share.preview_posted", { shareId: meta.id, orgId: meta.orgId });
    } catch (error) {
      this.#log.warn("share.preview_failed", { shareId: meta.id, orgId: meta.orgId, error });
    }
  }

  /** The dev server's favicon, as last fetched through the CLI, or null. */
  favicon(): { type: string; body: ArrayBuffer } | null {
    return this.ctx.storage.kv.get<{ type: string; body: ArrayBuffer }>("favicon") ?? null;
  }

  // --- Fetch: the CLI's socket and viewer traffic ----------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Only the bearer-checked route marks the CLI's socket. A viewer's `/connect` on the pipe
    // host is a path of the dev server like any other.
    if (path === "/connect" && request.headers.has(INTERNAL_HEADERS.cli)) {
      return this.#connect(request);
    }
    return this.#view(request);
  }

  /** Accepts the CLI's WebSocket: a new share, or the same CLI coming back within the grace. */
  #connect(request: Request) {
    const stored = this.#stored();
    if (stored?.state === "ended") return shareGone(stored.endReason);
    let meta = stored;
    const init = request.headers.get(INTERNAL_HEADERS.init);
    const isNew = !meta;
    if (!meta) {
      if (!init) return shareGone(null);
      const parsed = JSON.parse(init) as ShareInit;
      meta = {
        ...parsed,
        state: "live",
        awaySince: null,
        title: null,
        faviconPath: null,
        favicon: false,
        lastRequestAt: null,
        bytes: 0,
      };
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // One CLI per share: a reconnect replaces a socket the proxy left half-open.
    for (const old of this.ctx.getWebSockets("cli")) {
      try {
        old.close(REPLACED_CLOSE_CODE, "replaced by a reconnect");
      } catch {
        // Already closed.
      }
    }
    this.ctx.acceptWebSocket(server, ["cli"]);
    const wasAway = meta.state === "away";
    meta.state = "live";
    meta.awaySince = null;
    this.#save(meta);
    this.#armAlarm(meta);
    if (wasAway) this.ctx.waitUntil(this.#org(meta.orgId).update(meta.id, { state: "live" }));
    if (isNew && meta.source) this.ctx.waitUntil(this.preview());
    if (isNew) {
      // From the alarm, a moment after the socket is up: older CLIs drop a frame that arrives
      // in the same packet as the upgrade.
      meta.probe = { at: Date.now() + PROBE_FIRST_MS, attempt: 0 };
      this.#save(meta);
      this.#armAlarm(meta);
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        [SHARE_HEADERS.id]: meta.id,
        [SHARE_HEADERS.url]: meta.url,
        [SHARE_HEADERS.endsAt]: new Date(meta.startedAt + meta.limits.seconds * 1000).toISOString(),
      },
    });
  }

  /** One viewer request (HTTP or a browser WebSocket), already signed in by the Worker. */
  async #view(request: Request): Promise<Response> {
    const meta = this.#meta();
    if (!meta) return errorPage(410, "This pipe has ended.");
    const viewer = request.headers.get(INTERNAL_HEADERS.viewer);
    if (!viewer || !this.mayView(viewer) || !(await this.#isMember(viewer, meta.orgId))) {
      return new Response("not a member", {
        status: 403,
        headers: { [INTERNAL_HEADERS.refused]: "1" },
      });
    }
    if (!this.#cli() && !(await this.#waitForCli())) {
      return errorPage(503, "The pipe's CLI is reconnecting. This page retries on its own.", {
        refresh: 2,
      });
    }
    this.#touch(meta);
    this.#noteView(meta, viewer);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#openViewerSocket(request, meta);
    }
    return this.#relay(this.#requestHead(request, meta), request.body, meta);
  }

  async #isMember(userId: string, orgId: string) {
    const checked = this.#members.get(userId);
    if (checked && Date.now() - checked < MEMBERSHIP_TTL_MS) return true;
    const member = await findMember(createDb(this.env.DB), userId, orgId);
    if (!member) {
      this.#members.delete(userId);
      return false;
    }
    this.#members.set(userId, Date.now());
    return true;
  }

  async #waitForCli() {
    const deadline = Date.now() + AWAY_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!this.#meta()) return false;
      if (this.#cli()) return true;
    }
    return false;
  }

  #touch(meta: Meta) {
    meta.lastRequestAt = Date.now();
    this.#save(meta);
    if (meta.lastRequestAt - this.#lastRequestPush >= LAST_REQUEST_PUSH_MS) {
      this.#lastRequestPush = meta.lastRequestAt;
      this.ctx.waitUntil(
        this.#org(meta.orgId).update(meta.id, { lastRequestAt: meta.lastRequestAt }),
      );
    }
  }

  /** Counts one request for the view log. */
  #noteView(meta: Meta, userId: string) {
    // A request still in flight when the share ended must not write the log back.
    if (!this.#meta()) return;
    const now = Date.now();
    const key = `view:${userId}`;
    const seen = this.ctx.storage.kv.get<View>(key);
    const view: View = seen
      ? { ...seen, lastSeenAt: now, requests: seen.requests + 1 }
      : { userId, name: null, firstSeenAt: now, lastSeenAt: now, requests: 1, flushedAt: 0 };
    this.ctx.storage.kv.put(key, view);
    if (now - view.flushedAt >= VIEW_FLUSH_MS) this.ctx.waitUntil(this.#flushViews(meta));
  }

  #views() {
    return [...this.ctx.storage.kv.list<View>({ prefix: "view:" })].map(([, view]) => view);
  }

  /**
   * Writes the view log to D1 and the wall's card, naming viewers seen for the first time.
   * `final` is the flush at the share's end; any other flush stops writing to storage once the
   * share has ended, so the tombstone stays all the object keeps.
   */
  async #flushViews(meta: Meta, final = false) {
    const put = (view: View) => {
      if (final || this.#meta()) this.ctx.storage.kv.put(`view:${view.userId}`, view);
    };
    try {
      const now = Date.now();
      for (const view of this.#views()) put({ ...view, flushedAt: now });
      const db = createDb(this.env.DB);
      const unnamed = this.#views()
        .filter((view) => view.name === null)
        .map((view) => view.userId);
      if (unnamed.length) {
        const users = await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, unnamed),
          columns: { id: true, name: true, email: true },
        });
        for (const user of users) {
          const view = this.ctx.storage.kv.get<View>(`view:${user.id}`);
          if (view) put({ ...view, name: user.name || user.email });
        }
      }
      const views = this.#views();
      await recordShareViews(db, meta, views);
      await this.#org(meta.orgId).update(meta.id, {
        views: views
          .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt)
          .map((view) => ({ name: view.name ?? "Someone", lastSeenAt: view.lastSeenAt })),
      });
    } catch (error) {
      this.#log.warn("share.views_failed", { shareId: meta.id, error });
    }
  }

  #requestHead(request: Request, meta: Meta): RequestHead {
    const url = new URL(request.url);
    return {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: viewerRequestHeaders(request.headers, meta.url),
    };
  }

  /** Sends one HTTP request down the CLI's socket and streams its response back. */
  async #relay(
    head: RequestHead,
    body: ReadableStream<Uint8Array> | null,
    meta: Meta,
    options: { scanTitle?: boolean } = { scanTitle: true },
  ): Promise<Response> {
    const id = this.#nextStream();
    const stream: HttpStream = {
      kind: "http",
      order: new HttpStreamOrder("response"),
      send: new SendWindow(),
      receive: new ReceiveWindow(),
      head: deferred(),
      queue: [],
      wake: null,
      ended: false,
      error: null,
      closed: false,
    };
    this.#streams.set(id, stream);
    try {
      this.#send({ stream: id, type: "request", payload: head });
    } catch {
      this.#streams.delete(id);
      return errorPage(503, "The pipe's CLI is reconnecting. This page retries on its own.", {
        refresh: 2,
      });
    }
    this.ctx.waitUntil(this.#pumpRequestBody(id, stream, body));

    let responseHead: ResponseHead;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      responseHead = await Promise.race([
        stream.head.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("the local server took too long to answer")),
            RESPONSE_HEAD_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.#cancel(id, stream, "no response");
      return errorPage(502, (error as Error).message);
    } finally {
      clearTimeout(timer);
    }

    const headers = new Headers();
    for (const [name, raw] of forwardable(responseHead.headers)) {
      const value = name.toLowerCase() === "set-cookie" ? pipeSetCookie(raw) : raw;
      if (value === null) continue;
      try {
        headers.append(name, value);
      } catch {
        // A header the runtime refuses (invalid characters): dropped, not fatal.
      }
    }
    const isHtml = /^text\/html\b/i.test(headers.get("content-type") ?? "");
    let scan = options.scanTitle && isHtml && !headers.has(WAITING_HEADER) ? "" : null;
    const noBody = head.method === "HEAD" || [101, 204, 205, 304].includes(responseHead.status);

    const readable = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (!stream.queue.length && !stream.ended && !stream.closed) {
            await new Promise<void>((resolve) => (stream.wake = resolve));
          }
          const next = stream.queue.shift();
          if (next) {
            if (scan !== null && scan.length < TITLE_SCAN_BYTES) {
              scan += textDecoder.decode(next, { stream: true });
              this.#noteHtml(scan, scan.length >= TITLE_SCAN_BYTES);
              if (/<\/title>/i.test(scan) || scan.length >= TITLE_SCAN_BYTES) scan = null;
            }
            controller.enqueue(next);
            const grant = stream.receive.consumed(next.byteLength);
            if (grant && !stream.ended) {
              try {
                this.#send({ stream: id, type: "window", payload: { bytes: grant } });
              } catch {
                // CLI gone: the close handler fails this stream.
              }
            }
            return;
          }
          this.#streams.delete(id);
          if (stream.error) controller.error(new Error(stream.error));
          else controller.close();
        },
        cancel: () => {
          // The viewer went away (closed the tab, an SSE client disconnected).
          this.#cancel(id, stream, "cancelled");
        },
      },
      { highWaterMark: 0 },
    );
    if (noBody) {
      // Drain whatever the server sent so the stream ends cleanly.
      void readable.pipeTo(new WritableStream()).catch(() => {});
      return new Response(null, { status: responseHead.status, headers });
    }
    return new Response(readable, { status: responseHead.status, headers });
  }

  #noteHtml(html: string, final: boolean) {
    const title = extractTitle(html);
    if (!title && !final) return;
    const meta = this.#meta();
    if (!meta) return;
    const faviconPath = extractFaviconPath(html) ?? "/favicon.ico";
    const changed = title !== null && title !== meta.title;
    if (title) meta.title = title;
    const fetchFavicon = !meta.favicon || meta.faviconPath !== faviconPath;
    meta.faviconPath = faviconPath;
    this.#save(meta);
    if (changed) this.ctx.waitUntil(this.#org(meta.orgId).update(meta.id, { title }));
    if (fetchFavicon) this.ctx.waitUntil(this.#fetchFavicon(meta));
  }

  /**
   * Requests `/` through the CLI as soon as the pipe starts and reads the start of the page for
   * its title and favicon, as from a viewer's first page. Nothing else of the response is kept.
   */
  async #probe(attempt = 0) {
    const meta = this.#meta();
    // Ended, or a viewer's page got there first.
    if (!meta || meta.favicon) return;
    try {
      if (!this.#cli()) throw new Error("the CLI is reconnecting");
      const response = await this.#relay(
        {
          method: "GET",
          path: "/",
          // As on a viewer's request, for apps that build absolute URLs.
          headers: [["accept", "text/html"], ...forwardedHeaders(meta.url)],
        },
        null,
        meta,
        { scanTitle: false },
      );
      if (response.headers.has(WAITING_HEADER)) {
        await response.body?.cancel();
        throw new Error("the dev server is not listening yet");
      }
      const isHtml = /^text\/html\b/i.test(response.headers.get("content-type") ?? "");
      if (response.ok && isHtml && response.body) {
        this.#noteHtml(await readStart(response.body, TITLE_SCAN_BYTES), true);
      } else {
        await response.body?.cancel();
        // No page to read (a redirect to sign in, JSON): the default favicon may still be there.
        await this.#fetchFavicon(meta);
      }
    } catch (error) {
      const delay = PROBE_RETRY_MS[attempt];
      const current = this.#meta();
      if (delay === undefined || !current) {
        this.#log.info("share.probe_gave_up", { shareId: meta.id, error });
        return;
      }
      current.probe = { at: Date.now() + delay, attempt: attempt + 1 };
      this.#save(current);
      this.#armAlarm(current);
    }
  }

  /** Fetches the dev server's favicon through the CLI once, for the wall. */
  async #fetchFavicon(meta: Meta) {
    try {
      const response = await this.#relay(
        {
          method: "GET",
          path: meta.faviconPath ?? "/favicon.ico",
          headers: [["accept", "image/*"]],
        },
        null,
        meta,
        { scanTitle: false },
      );
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/^image\//i.test(type)) {
        await response.body?.cancel();
        return;
      }
      const body = await response.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > FAVICON_MAX_BYTES) return;
      this.ctx.storage.kv.put("favicon", { type, body });
      const current = this.#meta();
      if (!current) return;
      current.favicon = true;
      this.#save(current);
      await this.#org(current.orgId).update(current.id, { favicon: true });
    } catch (error) {
      this.#log.warn("share.favicon_failed", { shareId: meta.id, error });
    }
  }

  async #pumpRequestBody(id: number, stream: HttpStream, body: ReadableStream<Uint8Array> | null) {
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const piece of chunk(value)) {
            await stream.send.ready(piece.byteLength);
            if (stream.closed) {
              await reader.cancel();
              return;
            }
            stream.send.take(piece.byteLength);
            this.#send({ stream: id, type: "data", payload: piece });
            this.#count(piece.byteLength);
          }
        }
      }
      if (!stream.closed) this.#send({ stream: id, type: "end", payload: {} });
    } catch (error) {
      if (stream.closed) return;
      this.#cancel(id, stream, `request body failed: ${(error as Error).message}`);
    }
  }

  /** Stops a stream from this side and tells the CLI to stop too. */
  #cancel(id: number, stream: HttpStream, reason: string) {
    if (stream.closed) return;
    stream.closed = true;
    stream.send.release();
    stream.wake?.();
    this.#streams.delete(id);
    try {
      this.#send({ stream: id, type: "end", payload: { error: reason } });
    } catch {
      // CLI gone already.
    }
  }

  async #openViewerSocket(request: Request, meta: Meta) {
    const id = this.#nextStream();
    const stream: WsStream = { kind: "ws", opened: deferred() };
    this.#streams.set(id, stream);
    const head = this.#requestHead(request, meta);
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    try {
      this.#send({
        stream: id,
        type: "ws-open",
        payload: {
          path: head.path,
          headers: head.headers,
          protocols,
        },
      });
    } catch {
      this.#streams.delete(id);
      return errorPage(503, "The pipe's CLI is reconnecting.");
    }
    let opened: WsOpenPayload;
    try {
      opened = await Promise.race([
        stream.opened.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 15_000)),
      ]);
    } catch {
      this.#streams.delete(id);
      return new Response("the local server did not accept the websocket", { status: 502 });
    }
    this.#streams.delete(id);
    if (!opened.accepted) {
      return new Response("the local server refused the websocket", { status: 502 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged with its stream, so frames find it again after this object hibernates.
    this.ctx.acceptWebSocket(server, [`v:${id}`]);
    const headers = new Headers();
    if (opened.protocol) headers.set("sec-websocket-protocol", opened.protocol);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  // --- WebSocket events (CLI and viewers) --------------------------------------------------

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const tags = this.ctx.getTags(socket);
    const viewerTag = tags.find((tag) => tag.startsWith("v:"));
    if (viewerTag) {
      const stream = Number(viewerTag.slice(2));
      const data =
        typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
      this.#count(data.byteLength);
      try {
        this.#send({
          stream,
          type: "ws-message",
          payload: { binary: typeof message !== "string", data },
        });
      } catch {
        socket.close(1011, "share unavailable");
      }
      return;
    }
    if (!tags.includes("cli")) return;
    let frame: Frame;
    try {
      frame = decodeFrame(message);
    } catch (error) {
      this.#log.warn("share.protocol_error", { error });
      socket.close(1002, "protocol error");
      return;
    }
    this.#onFrame(frame);
  }

  #onFrame(frame: Frame) {
    if (frame.type === "ping") return;
    if (frame.type === "ws-message" || frame.type === "ws-close") {
      this.#toViewerSocket(frame);
      return;
    }
    const stream = this.#streams.get(frame.stream);
    if (!stream) return; // A stream we already finished or cancelled.
    if (stream.kind === "ws") {
      if (frame.type === "ws-open") stream.opened.resolve(frame.payload);
      return;
    }
    if (frame.type === "window") {
      stream.send.grant(frame.payload.bytes);
      return;
    }
    try {
      stream.order.accept(frame);
      if (frame.type === "response") {
        stream.head.resolve(frame.payload);
      } else if (frame.type === "data") {
        stream.receive.received(frame.payload.byteLength);
        this.#count(frame.payload.byteLength);
        stream.queue.push(frame.payload);
        stream.wake?.();
      } else if (frame.type === "end") {
        stream.ended = true;
        if (frame.payload.error) {
          stream.error = frame.payload.error;
          stream.head.reject(new Error(`the local server failed: ${frame.payload.error}`));
        }
        stream.wake?.();
      }
    } catch (error) {
      this.#log.warn("share.stream_error", { error });
      stream.error = (error as Error).message;
      stream.head.reject(error as Error);
      this.#cancel(frame.stream, stream, "protocol error");
    }
  }

  #toViewerSocket(frame: Frame) {
    const [viewer] = this.ctx.getWebSockets(`v:${frame.stream}`);
    if (!viewer) return;
    try {
      if (frame.type === "ws-message") {
        this.#count(frame.payload.data.byteLength);
        viewer.send(
          frame.payload.binary ? frame.payload.data : textDecoder.decode(frame.payload.data),
        );
      } else if (frame.type === "ws-close") {
        viewer.close(sendableCloseCode(frame.payload.code), frame.payload.reason.slice(0, 120));
      }
    } catch {
      // The viewer's socket is closing; its close event tells the CLI.
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const tags = this.ctx.getTags(socket);
    const viewerTag = tags.find((tag) => tag.startsWith("v:"));
    if (viewerTag) {
      const payload: WsClosePayload = { code: sendableCloseCode(code), reason };
      try {
        this.#send({ stream: Number(viewerTag.slice(2)), type: "ws-close", payload });
      } catch {
        // CLI gone.
      }
      return;
    }
    if (!tags.includes("cli")) return;
    // A replaced socket closing changes nothing: its successor is the share's CLI now.
    if (
      code === REPLACED_CLOSE_CODE ||
      this.ctx.getWebSockets("cli").some((s) => s !== socket && s.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    this.#failStreams("the share's CLI disconnected");
    const meta = this.#meta();
    if (!meta || meta.state !== "live") return;
    if (code === CLOSE_CODES.stopped) {
      await this.#end("stopped");
      return;
    }
    meta.state = "away";
    meta.awaySince = Date.now();
    this.#save(meta);
    this.#armAlarm(meta);
    await this.#org(meta.orgId).update(meta.id, { state: "away" });
  }

  override async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket, 1006, "error");
  }

  #failStreams(reason: string) {
    for (const [id, stream] of this.#streams) {
      if (stream.kind === "http") {
        stream.closed = true;
        stream.error = reason;
        stream.head.reject(new Error(reason));
        stream.send.release();
        stream.wake?.();
      } else {
        stream.opened.resolve({ accepted: false });
      }
      this.#streams.delete(id);
    }
    for (const viewer of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(viewer).some((tag) => tag.startsWith("v:"))) {
        try {
          viewer.close(1012, "share reconnecting");
        } catch {
          // Already closed.
        }
      }
    }
  }

  override async alarm() {
    const meta = this.#meta();
    if (!meta) return;
    const now = Date.now();
    if (now >= meta.startedAt + meta.limits.seconds * 1000) {
      await this.#end("expired");
    } else if (
      meta.state === "away" &&
      meta.awaySince &&
      now >= meta.awaySince + RECONNECT_GRACE_MS
    ) {
      await this.#end("disconnected");
    } else {
      if (meta.probe && now >= meta.probe.at) {
        // A timer would not survive hibernation; the alarm does. The next try, if any, is set
        // before this handler returns.
        const attempt = meta.probe.attempt;
        meta.probe = null;
        this.#save(meta);
        await this.#probe(attempt);
      }
      const current = this.#meta();
      if (current) this.#armAlarm(current);
    }
  }

  // --- Usage and ending ----------------------------------------------------------------------

  #count(bytes: number) {
    this.#pendingUsage += bytes;
    const now = Date.now();
    if (this.#pendingUsage >= USAGE_FLUSH_BYTES || now - this.#lastUsageFlush >= USAGE_FLUSH_MS) {
      this.ctx.waitUntil(this.#flushUsage());
    }
  }

  async #flushUsage() {
    const bytes = this.#pendingUsage;
    if (!bytes) return;
    this.#pendingUsage = 0;
    this.#lastUsageFlush = Date.now();
    const meta = this.#meta();
    if (!meta) return;
    meta.bytes += bytes;
    this.#save(meta);
    const usage = await this.#org(meta.orgId).addUsage(bytes, meta.limits.monthlyBytes);
    if (usage.over) await this.#end("limit");
  }

  /** Marks the pipe's deployments inactive; a failure is logged, never fatal to the end. */
  async #retirePreviews(meta: Meta) {
    const github = loadConfig(this.env).github;
    if (!github) return;
    for (const preview of meta.previews ?? []) {
      try {
        await retirePreview(github, preview);
      } catch (error) {
        this.#log.warn("share.preview_retire_failed", { shareId: meta.id, error });
      }
    }
  }

  async #end(reason: EndReason) {
    const meta = this.#meta();
    if (!meta) return;
    // Everything but the tombstone goes now: the title, the favicon, unredeemed codes. The D1
    // `shares` row is the pipe's history.
    this.ctx.storage.kv.put("meta", { state: "ended", endReason: reason } satisfies Tombstone);
    this.ctx.storage.kv.delete("nextStream");
    for (const cli of this.ctx.getWebSockets("cli")) {
      try {
        cli.close(CLOSE_CODES[reason], reason);
      } catch {
        // Already closed.
      }
    }
    this.#failStreams("this share has ended");
    for (const [key] of this.ctx.storage.kv.list({ prefix: "code:" })) {
      this.ctx.storage.kv.delete(key);
    }
    this.ctx.storage.kv.delete("favicon");
    await this.ctx.storage.deleteAlarm();
    // The usage still counts, even though the share is gone.
    const pending = this.#pendingUsage;
    this.#pendingUsage = 0;
    meta.bytes += pending;
    const org = this.#org(meta.orgId);
    if (pending) await org.addUsage(pending, meta.limits.monthlyBytes);
    // The view log's last counts go to D1; the object keeps none of it.
    await this.#flushViews(meta, true);
    for (const [key] of this.ctx.storage.kv.list({ prefix: "view:" })) {
      this.ctx.storage.kv.delete(key);
    }
    await org.remove(meta.id);
    await this.#retirePreviews(meta);
    await recordShareEnd(createDb(this.env.DB), { id: meta.id, reason, bytes: meta.bytes });
    this.#log.info("share.ended", {
      shareId: meta.id,
      orgId: meta.orgId,
      reason,
      bytes: meta.bytes,
    });
  }
}
