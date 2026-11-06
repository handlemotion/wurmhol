// One Share Durable Object per share (spec section 5). It holds the CLI's WebSocket (hibernation
// API), multiplexes every viewer request and browser WebSocket over it as streams
// (`@wurmhol/protocol`), and owns the share's lifecycle and limits: its lifetime, the org's
// monthly bytes, and membership of each viewer (and, when the CLI named some, that the viewer is
// one of them). Its parts keep the rest: the title and favicon (`share-page.ts`), the view log
// (`share-views.ts`) and the pull request preview (`share-previews.ts`).
//
// Request and response bodies pass through and are never logged or stored. Only the `<title>`
// of HTML responses and the favicon are kept, while the share is open: at its end the object
// keeps a tombstone (`state`, `endReason`) and nothing else. The viewer's IP is not forwarded.
import { DurableObject } from "cloudflare:workers";
import { createDb, findMember, randomSecret, recordShareEnd, sha256Hex } from "@wurmhol/db";
import {
  chunk,
  CLOSE_CODES,
  decodeFrame,
  encodeFrame,
  type EndReason,
  FIRST_STREAM_ID,
  forwardable,
  HEARTBEAT_MS,
  type Frame,
  HttpStreamOrder,
  nextStreamId,
  PING_TEXT,
  pipeSetCookie,
  PONG_TEXT,
  ProtocolError,
  ReceiveWindow,
  RECONNECT_GRACE_MS,
  REPLACED_CLOSE_CODE,
  type RequestHead,
  type ResponseHead,
  SendBacklog,
  SendWindow,
  sendableCloseCode,
  SHARE_HEADERS,
  viewerRequestHeaders,
  WAITING_HEADER,
  type WsOpenPayload,
} from "@wurmhol/protocol";
import { refuse } from "./bearer.ts";
import { createLogger } from "./log.ts";
import { orgStub } from "./org-do.ts";
import { errorPage } from "./pages.ts";
import { type Meta, type ShareInit, type ShareState, type Tombstone } from "./share-meta.ts";
import { PROBE_FIRST_MS, SharePage, TITLE_SCAN_BYTES } from "./share-page.ts";
import { SharePreviews } from "./share-previews.ts";
import { ViewLog } from "./share-views.ts";

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
  /** From the object: the share's org, on a response with a `Location` (the OAuth relay's). */
  org: "x-wurmhol-org",
} as const;
const INTERNAL_HEADER_NAMES = new Set<string>(Object.values(INTERNAL_HEADERS));

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

/**
 * A viewer's response from the object without the object's own headers, and the share's org
 * when the response redirects somewhere (null otherwise).
 */
export function fromShare(response: Response): { response: Response; orgId: string | null } {
  const orgId = response.headers.get(INTERNAL_HEADERS.org);
  if (orgId === null) return { response, orgId };
  const out = new Response(response.body, response);
  out.headers.delete(INTERNAL_HEADERS.org);
  return { response: out, orgId };
}

/** How long a viewer's membership check stays good before D1 is asked again. */
const MEMBERSHIP_TTL_MS = 10_000;
/** Longest wait for the local server's status line. Cloudflare's own edge gives up at 100 s. */
const RESPONSE_HEAD_TIMEOUT_MS = 100_000;
/** How long a viewer request waits for an away CLI to come back before it is answered. */
const AWAY_WAIT_MS = 10_000;
/** Usage goes to the Org object at most this often, or once this many bytes piled up. */
const USAGE_FLUSH_MS = 5_000;
const USAGE_FLUSH_BYTES = 8 * 1024 * 1024;
/** The wall's "last request" line updates at most this often, and is stored as often. */
const LAST_REQUEST_PUSH_MS = 5_000;
/** Stream ids are reserved in storage this many at a time, so most streams write nothing. */
const STREAM_ID_BLOCK = 1024;
/**
 * A live CLI pings every `HEARTBEAT_MS`, answered by the runtime. After two missed heartbeats
 * (and slack for a slow link) its socket counts as dead: half-open, or its process frozen.
 */
const CLI_SILENT_MS = 2 * HEARTBEAT_MS + 10_000;
/** How long a browser WebSocket waits for the dev server to accept it. */
const WS_OPEN_TIMEOUT_MS = 15_000;
/**
 * A browser WebSocket stream is closed (1013) once the bytes likely still queued toward either
 * end pass this: what was sent, less what a peer reading `WS_DRAIN_PER_SECOND` took since.
 */
const WS_BACKLOG_BYTES = 16 * 1024 * 1024;
const WS_DRAIN_PER_SECOND = 2 * 1024 * 1024;
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
  /** The last viewer request, kept here and pushed and stored every `LAST_REQUEST_PUSH_MS`. */
  #lastRequestAt: number | null = null;
  #lastRequestPush = 0;
  #lastRequestTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next stream id, and the first one not yet reserved in storage; null until first used. */
  #streamIds: { next: number; reserved: number } | null = null;
  /** Per open browser WebSocket stream, the estimated bytes queued toward each end. */
  /** When the CLI last sent a frame other than its heartbeat. */
  #cliFrameAt = 0;
  #backlogs = new Map<number, Record<"viewer" | "cli", SendBacklog>>();
  #log = createLogger({ component: "share" });
  #page: SharePage;
  #views: ViewLog;
  #previews: SharePreviews;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const state: ShareState = {
      ctx,
      env,
      log: this.#log,
      meta: () => this.#meta(),
      save: (meta) => this.#save(meta),
      org: (orgId) => this.#org(orgId),
    };
    this.#page = new SharePage(state, {
      relay: (head, meta) => this.#relay(head, null, meta, { scanTitle: false }),
      connected: () => this.#cli() !== null,
      armAlarm: (meta) => this.#armAlarm(meta),
    });
    this.#views = new ViewLog(state);
    this.#previews = new SharePreviews(state);
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

  /**
   * A stream id never used on this share before. Ids come from memory; storage holds the end of
   * the reserved block, so after hibernation the count goes on past every id handed out, and past
   * every viewer socket still open (its `v:<id>` tag).
   */
  #nextStream() {
    if (!this.#streamIds) {
      let next = this.ctx.storage.kv.get<number>("nextStream") ?? FIRST_STREAM_ID;
      for (const socket of this.ctx.getWebSockets()) {
        for (const tag of this.ctx.getTags(socket)) {
          if (tag.startsWith("v:")) next = Math.max(next, Number(tag.slice(2)) + 1);
        }
      }
      this.#streamIds = { next, reserved: next };
    }
    const ids = this.#streamIds;
    const id = ids.next;
    ids.next = nextStreamId(id);
    if (id >= ids.reserved) {
      ids.reserved = id + STREAM_ID_BLOCK;
      // Never written over the tombstone: an ended share opens no more streams.
      if (this.#meta()) this.ctx.storage.kv.put("nextStream", ids.reserved);
    }
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
    const silent =
      meta.state === "live" ? (this.#cliSeenAt(meta) ?? Date.now()) + CLI_SILENT_MS : Infinity;
    void this.ctx.storage.setAlarm(Math.min(expires, away, probe, silent));
  }

  /** When the live CLI was last heard from (a heartbeat, a frame, its connect), or null. */
  #cliSeenAt(meta: Meta) {
    const cli = this.#cli();
    if (!cli) return null;
    const ping = this.ctx.getWebSocketAutoResponseTimestamp(cli)?.getTime() ?? 0;
    return Math.max(meta.liveSince ?? meta.startedAt, ping, this.#cliFrameAt);
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
    return this.#previews.post();
  }

  /** The dev server's favicon, as last fetched through the CLI, or null. */
  favicon() {
    return this.#page.favicon();
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
    meta.liveSince = Date.now();
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
    this.#touch();
    this.#views.note(meta, viewer);
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

  /**
   * Notes a viewer request for the wall's "last request" line. The first in a while goes out at
   * once; later ones at most every `LAST_REQUEST_PUSH_MS`, on a timer that also keeps the object
   * from hibernating with the newest one unsaved.
   */
  #touch() {
    const now = Date.now();
    this.#lastRequestAt = now;
    const wait = this.#lastRequestPush + LAST_REQUEST_PUSH_MS - now;
    if (wait <= 0) {
      this.#pushLastRequest();
    } else {
      this.#lastRequestTimer ??= setTimeout(() => {
        this.#lastRequestTimer = null;
        this.#pushLastRequest();
      }, wait);
    }
  }

  #pushLastRequest() {
    const meta = this.#meta();
    const at = this.#lastRequestAt;
    if (!meta || at === null || at === meta.lastRequestAt) return;
    this.#lastRequestPush = Date.now();
    meta.lastRequestAt = at;
    this.#save(meta);
    this.ctx.waitUntil(this.#org(meta.orgId).update(meta.id, { lastRequestAt: at }));
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
      // The object's own headers to the Worker are never the dev server's to send.
      if (INTERNAL_HEADER_NAMES.has(name.toLowerCase())) continue;
      const value = name.toLowerCase() === "set-cookie" ? pipeSetCookie(raw) : raw;
      if (value === null) continue;
      try {
        headers.append(name, value);
      } catch {
        // A header the runtime refuses (invalid characters): dropped, not fatal.
      }
    }
    if (headers.has("location")) headers.set(INTERNAL_HEADERS.org, meta.orgId);
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
              this.#page.note(scan, scan.length >= TITLE_SCAN_BYTES);
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
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out")), WS_OPEN_TIMEOUT_MS),
        ),
      ]);
    } catch {
      this.#streams.delete(id);
      // The CLI may still be dialling, or have a socket open: it must not keep one nobody reads.
      this.#closeCliStream(id, 1001, "the relay stopped waiting for the websocket");
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
      if (!this.#backlog(stream, "cli").add(data.byteLength, Date.now())) {
        this.#overflow(stream, socket, "cli");
        return;
      }
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
    this.#cliFrameAt = Date.now();
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
        if (!this.#backlog(frame.stream, "viewer").add(frame.payload.data.byteLength, Date.now())) {
          this.#overflow(frame.stream, viewer, "viewer");
          return;
        }
        viewer.send(
          frame.payload.binary ? frame.payload.data : textDecoder.decode(frame.payload.data),
        );
      } else if (frame.type === "ws-close") {
        this.#backlogs.delete(frame.stream);
        viewer.close(sendableCloseCode(frame.payload.code), frame.payload.reason.slice(0, 120));
      }
    } catch {
      // The viewer's socket is closing; its close event tells the CLI.
    }
  }

  #backlog(stream: number, toward: "viewer" | "cli") {
    let backlogs = this.#backlogs.get(stream);
    if (!backlogs) {
      const options = { limit: WS_BACKLOG_BYTES, drainPerSecond: WS_DRAIN_PER_SECOND };
      const now = Date.now();
      backlogs = {
        viewer: new SendBacklog({ ...options, now }),
        cli: new SendBacklog({ ...options, now }),
      };
      this.#backlogs.set(stream, backlogs);
    }
    return backlogs[toward];
  }

  /** Closes a browser WebSocket stream at both ends: more is queued toward one than it reads. */
  #overflow(stream: number, viewer: WebSocket, toward: "viewer" | "cli") {
    const bytes = Math.round(this.#backlog(stream, toward).pending);
    this.#backlogs.delete(stream);
    this.#log.warn("share.ws_backlog", { shareId: this.#meta()?.id, stream, toward, bytes });
    const reason = "too much data queued";
    try {
      viewer.close(1013, reason);
    } catch {
      // Already closing.
    }
    this.#closeCliStream(stream, 1013, reason);
  }

  /** Tells the CLI to close its end of a browser WebSocket stream. */
  #closeCliStream(stream: number, code: number, reason: string) {
    try {
      this.#send({ stream, type: "ws-close", payload: { code, reason } });
    } catch {
      // CLI gone: it drops its streams when its socket goes.
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const tags = this.ctx.getTags(socket);
    const viewerTag = tags.find((tag) => tag.startsWith("v:"));
    if (viewerTag) {
      const stream = Number(viewerTag.slice(2));
      this.#backlogs.delete(stream);
      this.#closeCliStream(stream, sendableCloseCode(code), reason);
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
    await this.#cliLost(code);
  }

  /**
   * The CLI's socket is gone (closed, or silent past `CLI_SILENT_MS`): a clean close (1000) ends
   * the pipe, anything else makes it away until the CLI comes back or the grace runs out.
   */
  async #cliLost(code: number) {
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
    this.#backlogs.clear();
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
      if (meta.state === "live") {
        const seen = this.#cliSeenAt(meta);
        if (seen === null || now >= seen + CLI_SILENT_MS) {
          this.#log.info("share.cli_silent", { shareId: meta.id, silentMs: now - (seen ?? now) });
          for (const cli of this.ctx.getWebSockets("cli")) {
            try {
              cli.close(1001, "no heartbeat");
            } catch {
              // Already closed.
            }
          }
          await this.#cliLost(1001);
        }
      }
      const live = this.#meta();
      if (live?.probe && now >= live.probe.at) {
        // A timer would not survive hibernation; the alarm does. The probe sets its next try, if
        // any. It is not awaited: a request to a frozen CLI would hold this handler, and with it
        // every later alarm, including the one that finds the CLI silent.
        const attempt = live.probe.attempt;
        live.probe = null;
        this.#save(live);
        this.ctx.waitUntil(this.#page.probe(attempt));
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

  async #end(reason: EndReason) {
    const meta = this.#meta();
    if (!meta) return;
    // Everything but the tombstone goes now: the title, the favicon, unredeemed codes. The D1
    // `shares` row is the pipe's history.
    this.ctx.storage.kv.put("meta", { state: "ended", endReason: reason } satisfies Tombstone);
    this.ctx.storage.kv.delete("nextStream");
    if (this.#lastRequestTimer) clearTimeout(this.#lastRequestTimer);
    this.#lastRequestTimer = null;
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
    this.#page.clear();
    await this.ctx.storage.deleteAlarm();
    // The usage still counts, even though the share is gone.
    const pending = this.#pendingUsage;
    this.#pendingUsage = 0;
    meta.bytes += pending;
    const org = this.#org(meta.orgId);
    if (pending) await org.addUsage(pending, meta.limits.monthlyBytes);
    // The view log's last counts go to D1; the object keeps none of it.
    await this.#views.close(meta);
    await org.remove(meta.id);
    await this.#previews.retire(meta);
    await recordShareEnd(createDb(this.env.DB), { id: meta.id, reason, bytes: meta.bytes });
    this.#log.info("share.ended", {
      shareId: meta.id,
      orgId: meta.orgId,
      reason,
      bytes: meta.bytes,
    });
  }
}
