// One Share Durable Object per share (spec section 5). It holds the CLI's WebSocket (hibernation
// API), multiplexes every viewer request and browser WebSocket over it as streams
// (`@wurmhol/protocol`), records the page title and the last request for the wall, and enforces
// the share's limits: its lifetime, the org's monthly bytes, and membership of each viewer (and,
// when the CLI named some, that the viewer is one of them). It keeps the view log: per viewer,
// first and last seen and a request count, never paths, IPs or user agents (ADR 0008).
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
  decodeFrame,
  encodeFrame,
  type Frame,
  forwardable,
  type HeaderList,
  HttpStreamOrder,
  PING_TEXT,
  PONG_TEXT,
  ProtocolError,
  RECONNECT_GRACE_MS,
  ReceiveWindow,
  type RequestHead,
  type ResponseHead,
  SendWindow,
  SHARE_COOKIE,
  withoutCookie,
  type WsClosePayload,
  type WsOpenPayload,
} from "@wurmhol/protocol";
import { createLogger } from "./log.ts";
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

export type EndReason =
  | "stopped"
  | "terminated"
  | "expired"
  | "revoked"
  | "limit"
  | "disconnected"
  | "no_subscription";

/** Close codes the CLI reads to tell why its share ended (and not to reconnect). */
export const CLOSE_CODES: Record<EndReason, number> = {
  stopped: 1000,
  terminated: 4001,
  expired: 4002,
  revoked: 4003,
  limit: 4004,
  disconnected: 4005,
  no_subscription: 4006,
};
/** An older socket of the same CLI, replaced by its reconnect. */
const REPLACED = 4000;

/** Headers the Worker uses to talk to this object; never forwarded, never trusted from viewers. */
export const INTERNAL_HEADERS = {
  init: "x-wurmhol-init",
  viewer: "x-wurmhol-viewer",
} as const;

/** Headers that carry the viewer's IP address. */
const CLIENT_IP = new Set(["x-forwarded-for", "x-real-ip", "true-client-ip"]);

/** How long a viewer's membership check stays good before D1 is asked again. */
const MEMBERSHIP_TTL_MS = 10_000;
/** Longest wait for the local server's status line. Cloudflare's own edge gives up at 100 s. */
const RESPONSE_HEAD_TIMEOUT_MS = 100_000;
/** How long a viewer request waits for an away CLI to come back before it is answered. */
const AWAY_WAIT_MS = 10_000;
/** Bytes of an HTML response read for its `<title>`. */
const TITLE_SCAN_BYTES = 64 * 1024;
const FAVICON_MAX_BYTES = 100 * 1024;
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

const TITLE_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

/** The `<title>` of an HTML document's start, decoded, or null. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  // One pass, so `&amp;lt;` decodes to `&lt;`, not `<`.
  const title = match[1]!
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (whole: string, entity: string) => TITLE_ENTITIES[entity] ?? whole,
    )
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 200) : null;
}

/** The favicon an HTML document's start links to, as a path on the share, or null. */
export function extractFaviconPath(html: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    // Same-origin paths only: the relay fetches it through the CLI.
    if (href && href.startsWith("/") && !href.startsWith("//")) return href.slice(0, 500);
  }
  return null;
}

export class Share extends DurableObject<Env> {
  #streams = new Map<number, HttpStream | WsStream>();
  #members = new Map<string, number>();
  #pendingUsage = 0;
  #lastUsageFlush = 0;
  #lastRequestPush = 0;
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
    return this.env.ORG.get(this.env.ORG.idFromName(orgId));
  }

  #cli(): WebSocket | null {
    return (
      this.ctx.getWebSockets("cli").find((socket) => socket.readyState === WebSocket.OPEN) ?? null
    );
  }

  #nextStream() {
    const next = this.ctx.storage.kv.get<number>("nextStream") ?? 1;
    this.ctx.storage.kv.put("nextStream", next + 1);
    return next;
  }

  #send(frame: Frame) {
    const cli = this.#cli();
    if (!cli) throw new ProtocolError("the CLI is not connected");
    cli.send(encodeFrame(frame));
  }

  #armAlarm(meta: Meta) {
    const expires = meta.startedAt + meta.limits.seconds * 1000;
    const away = meta.awaySince === null ? Infinity : meta.awaySince + RECONNECT_GRACE_MS;
    void this.ctx.storage.setAlarm(Math.min(expires, away));
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

  /** The dev server's favicon, as last fetched through the CLI, or null. */
  favicon(): { type: string; body: ArrayBuffer } | null {
    return this.ctx.storage.kv.get<{ type: string; body: ArrayBuffer }>("favicon") ?? null;
  }

  // --- Fetch: the CLI's socket and viewer traffic ----------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") return this.#connect(request);
    return this.#view(request);
  }

  /** Accepts the CLI's WebSocket: a new share, or the same CLI coming back within the grace. */
  #connect(request: Request) {
    const stored = this.#stored();
    if (stored?.state === "ended") {
      return Response.json({ error: "share ended", reason: stored.endReason }, { status: 410 });
    }
    let meta = stored;
    const init = request.headers.get(INTERNAL_HEADERS.init);
    if (!meta) {
      if (!init) return Response.json({ error: "share not found" }, { status: 404 });
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
        old.close(REPLACED, "replaced by a reconnect");
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
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "x-wurmhol-share-id": meta.id,
        "x-wurmhol-share-url": meta.url,
        "x-wurmhol-share-ends-at": new Date(
          meta.startedAt + meta.limits.seconds * 1000,
        ).toISOString(),
      },
    });
  }

  /** One viewer request (HTTP or a browser WebSocket), already signed in by the Worker. */
  async #view(request: Request): Promise<Response> {
    const meta = this.#meta();
    if (!meta) return errorPage(410, "This pipe has ended.");
    const viewer = request.headers.get(INTERNAL_HEADERS.viewer);
    if (!viewer || !this.mayView(viewer) || !(await this.#isMember(viewer, meta.orgId))) {
      return new Response("not a member", { status: 403, headers: { "x-wurmhol-refused": "1" } });
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
    const headers: HeaderList = [];
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      // Cloudflare's and our own headers stay on this side; so does the share cookie. So does
      // the viewer's IP, which Cloudflare puts in X-Forwarded-For: no dev server needs it.
      if (lower.startsWith("cf-") || lower.startsWith("x-wurmhol-") || CLIENT_IP.has(lower)) {
        continue;
      }
      if (lower === "cookie") {
        const kept = withoutCookie(value, SHARE_COOKIE);
        if (kept) headers.push([name, kept]);
        continue;
      }
      // Identity bodies: the title scan reads HTML, and Cloudflare compresses toward the viewer.
      if (lower === "accept-encoding") continue;
      headers.push([name, value]);
    }
    const shareUrl = new URL(meta.url);
    headers.push(["x-forwarded-host", shareUrl.host]);
    headers.push(["x-forwarded-proto", shareUrl.protocol.replace(":", "")]);
    return { method: request.method, path: `${url.pathname}${url.search}`, headers };
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
    for (const [name, value] of forwardable(responseHead.headers)) {
      try {
        headers.append(name, value);
      } catch {
        // A header the runtime refuses (invalid characters): dropped, not fatal.
      }
    }
    const isHtml = /^text\/html\b/i.test(headers.get("content-type") ?? "");
    let scan = options.scanTitle && isHtml ? "" : null;
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
          // The handshake's own headers are the CLI's to make.
          headers: head.headers.filter(([name]) => !/^sec-websocket-/i.test(name)),
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
        viewer.close(safeCloseCode(frame.payload.code), frame.payload.reason.slice(0, 120));
      }
    } catch {
      // The viewer's socket is closing; its close event tells the CLI.
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const tags = this.ctx.getTags(socket);
    const viewerTag = tags.find((tag) => tag.startsWith("v:"));
    if (viewerTag) {
      const payload: WsClosePayload = { code: safeCloseCode(code), reason };
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
      code === REPLACED ||
      this.ctx.getWebSockets("cli").some((s) => s !== socket && s.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    this.#failStreams("the share's CLI disconnected");
    const meta = this.#meta();
    if (!meta || meta.state !== "live") return;
    if (code === 1000) {
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
      this.#armAlarm(meta);
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
    await recordShareEnd(createDb(this.env.DB), { id: meta.id, reason, bytes: meta.bytes });
    this.#log.info("share.ended", {
      shareId: meta.id,
      orgId: meta.orgId,
      reason,
      bytes: meta.bytes,
    });
  }
}

/** A close code a server may send: 1005, 1006 and 1015 are reserved for the runtime. */
function safeCloseCode(code: number) {
  if (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))) {
    return code;
  }
  return code >= 3000 && code <= 4999 ? code : 1000;
}
