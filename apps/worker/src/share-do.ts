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
import {
  createDb,
  findLiveEmbedGrant,
  findMember,
  randomSecret,
  recordShareEnd,
  sha256Hex,
} from "@wurmhol/db";
import {
  ACCESS_KEY_HEADER,
  accessKeyHash,
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
  isAccessKey,
  embedCredentialKind,
  GRANT_CLOSE,
  GRANT_HEADER,
  grantProtocolAnswer,
  splitGrantProtocols,
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
import { orgStub, type UsageBatch } from "./org-do.ts";
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
  /** To the object: the access key a non-browser client presented (ADR 0028). */
  key: "x-wurmhol-access-key",
  /** To the object: the grant id a browser's grant cookie names (ADR 0032). */
  grantId: "x-wurmhol-grant-id",
  /** To the object: a program's grant token, from its header or a WebSocket subprotocol. */
  grantToken: "x-wurmhol-grant-token",
  /** To the object: set when the grant came as a subprotocol, with the page's `Origin`. */
  grantOrigin: "x-wurmhol-grant-origin",
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
 * share's `ShareInit`, or null to bring one back); `viewer` is a signed-in viewer's request;
 * `key` is a request that presented the pipe's access key, for the object to check.
 */
export function toShare(
  raw: Request,
  internal:
    | { cli: ShareInit | null }
    | { viewer: string }
    | { key: string }
    | { grant: { id: string } | { token: string; origin?: string } },
): Request {
  const headers = new Headers(raw.headers);
  for (const name of Object.values(INTERNAL_HEADERS)) headers.delete(name);
  headers.delete(ACCESS_KEY_HEADER);
  headers.delete(GRANT_HEADER);
  if ("grant" in internal) {
    const { grant } = internal;
    if ("id" in grant) headers.set(INTERNAL_HEADERS.grantId, grant.id);
    else {
      headers.set(INTERNAL_HEADERS.grantToken, grant.token);
      if (grant.origin !== undefined) headers.set(INTERNAL_HEADERS.grantOrigin, grant.origin);
    }
    return new Request(raw, { headers });
  }
  if ("viewer" in internal) {
    headers.set(INTERNAL_HEADERS.viewer, internal.viewer);
    return new Request(raw, { headers });
  }
  if ("key" in internal) {
    headers.set(INTERNAL_HEADERS.key, internal.key);
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

/**
 * How long a checked grant stays good before D1 is asked again (ADR 0032): a revocation's push
 * makes it immediate; this bounds one that got lost. Open sockets are checked as often.
 */
const GRANT_RECHECK_MS = 60_000;

/** A grant this object checked: its id, its expiry, and when it was checked. */
interface CheckedGrant {
  id: string;
  expiresAt: number;
  checkedAt: number;
  allowedOrigins: string[];
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
  /** Grants checked lately, by id and by token: `id:<id>` or `token:<token's hash>`. */
  #grants = new Map<string, CheckedGrant>();
  /** Bytes and viewer requests not yet added to the Org object's monthly counts. */
  #pendingUsage = 0;
  #pendingRequests = 0;
  #lastUsageFlush = 0;
  /** Usage sends run one after another, so the Org object gets batches in order. */
  #usageSends: Promise<unknown> = Promise.resolve();
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
    void this.ctx.storage.setAlarm(Math.min(expires, away, probe, silent, this.#nextGrantCheck()));
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
    return {
      state: stored.state,
      orgId: stored.orgId,
      tokenId: stored.tokenId,
      port: stored.port,
      embedded: Boolean(stored.embed),
      tunnelId: stored.embed?.tunnelId ?? null,
      appId: stored.embed?.appId ?? null,
    };
  }

  /**
   * An embedded tunnel's session as its integration sees it (ADR 0032): whether its agent is
   * connected, since when, its last request and its bytes. Nothing from inside the tunnel.
   */
  health() {
    const stored = this.#stored();
    if (!stored || stored.state === "ended") return null;
    return {
      state: stored.state,
      liveSince: stored.liveSince ?? null,
      awaySince: stored.awaySince,
      lastRequestAt: stored.lastRequestAt,
      bytes: stored.bytes,
    };
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
    // An embedded tunnel's pages are its user's: the relay reads no title or favicon from them.
    if (isNew && !meta.embed) {
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
    const key = request.headers.get(INTERNAL_HEADERS.key);
    const viewer = request.headers.get(INTERNAL_HEADERS.viewer);
    let grant: CheckedGrant | null = null;
    if (meta.embed) {
      // An embedded tunnel opens only to a grant for one of its subjects (ADR 0032): never to an
      // org member's cookie, nor to an access key.
      grant = await this.#checkGrant(request, meta);
      if (!grant) {
        return new Response("grant required", {
          status: 401,
          headers: {
            "content-type": "text/plain",
            "cache-control": "no-store",
            [INTERNAL_HEADERS.refused]: "1",
          },
        });
      }
    } else if (
      request.headers.has(INTERNAL_HEADERS.grantId) ||
      request.headers.has(INTERNAL_HEADERS.grantToken)
    ) {
      return new Response("not a tunnel", { status: 401 });
    }
    if (key !== null) {
      // A client with no browser session: the pipe's access key stands in for the sign-in (ADR
      // 0028). It opens only this pipe, and the same limits, billing and wall apply.
      if (!(await this.#acceptsKey(meta, key))) {
        return new Response("bad access key", {
          status: 401,
          headers: { "content-type": "text/plain", "cache-control": "no-store" },
        });
      }
    } else if (
      !grant &&
      (!viewer || !this.mayView(viewer) || !(await this.#isMember(viewer, meta.orgId)))
    ) {
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
    if (viewer) this.#views.note(meta, viewer);
    this.#pendingRequests += 1;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#openViewerSocket(request, meta, grant);
    }
    return this.#relay(this.#requestHead(request), request.body, meta);
  }

  /**
   * The live grant a request to this embedded tunnel carries, or null. A cookie's grant id or a
   * token is looked up in D1 at most once a `GRANT_RECHECK_MS`; the grant must be for this
   * tunnel. A token that came as a WebSocket subprotocol also needs the page's origin to be one
   * the application allows, so another site cannot use a grant it obtained.
   */
  async #checkGrant(request: Request, meta: Meta): Promise<CheckedGrant | null> {
    const id = request.headers.get(INTERNAL_HEADERS.grantId);
    const token = request.headers.get(INTERNAL_HEADERS.grantToken);
    const origin = request.headers.get(INTERNAL_HEADERS.grantOrigin);
    let cacheKey: string;
    if (id) cacheKey = `id:${id}`;
    else if (token && embedCredentialKind(token) === "grant") {
      cacheKey = `token:${await sha256Hex(token)}`;
    } else return null;
    const now = Date.now();
    let grant = this.#grants.get(cacheKey);
    if (!grant || now - grant.checkedAt >= GRANT_RECHECK_MS) {
      const found = await findLiveEmbedGrant(
        createDb(this.env.DB),
        id ? { id } : { token: token! },
      );
      if (!found || found.tunnelId !== meta.embed?.tunnelId || found.orgId !== meta.orgId) {
        this.#grants.delete(cacheKey);
        return null;
      }
      grant = {
        id: found.id,
        expiresAt: found.expiresAt.getTime(),
        checkedAt: now,
        allowedOrigins: found.allowedOrigins,
      };
      this.#grants.set(cacheKey, grant);
    }
    if (grant.expiresAt <= now) {
      this.#grants.delete(cacheKey);
      return null;
    }
    if (origin !== null && !grant.allowedOrigins.includes(origin)) return null;
    return grant;
  }

  /**
   * Revoked grants stop now (ADR 0032): dropped from the cache, and every WebSocket opened under
   * one closed with `4403`. Called by the Worker after D1 has the revocation.
   */
  revokeGrants(ids: string[]) {
    const revoked = new Set(ids);
    for (const [key, grant] of this.#grants) if (revoked.has(grant.id)) this.#grants.delete(key);
    for (const id of ids) {
      this.#closeGrantSockets(id, GRANT_CLOSE.revoked);
      this.ctx.storage.kv.delete(`grant:${id}`);
    }
  }

  /** Closes the viewer sockets opened under a grant, and their streams to the CLI. */
  #closeGrantSockets(grantId: string, close: { code: number; reason: string }) {
    for (const socket of this.ctx.getWebSockets(`g:${grantId}`)) {
      const tag = this.ctx.getTags(socket).find((t) => t.startsWith("v:"));
      try {
        socket.close(close.code, close.reason);
      } catch {
        // Already closed.
      }
      if (tag) {
        const stream = Number(tag.slice(2));
        this.#backlogs.delete(stream);
        this.#closeCliStream(stream, 1000, close.reason);
      }
    }
  }

  /**
   * The grants open sockets were opened under (`grant:<id>`, its expiry): closes those whose
   * grant expired (`4401`) or no longer checks out in D1 (`4403`), and forgets grants with no
   * socket left. Runs from the alarm, at least every `GRANT_RECHECK_MS` while any are open.
   */
  async #checkGrantSockets(meta: Meta) {
    const now = Date.now();
    const db = createDb(this.env.DB);
    for (const [key, expiresAt] of this.ctx.storage.kv.list<number>({ prefix: "grant:" })) {
      const id = key.slice("grant:".length);
      if (!this.ctx.getWebSockets(`g:${id}`).length) {
        this.ctx.storage.kv.delete(key);
        continue;
      }
      if (expiresAt <= now) {
        this.#closeGrantSockets(id, GRANT_CLOSE.expired);
        this.ctx.storage.kv.delete(key);
        continue;
      }
      const live = await findLiveEmbedGrant(db, { id });
      if (!live || live.tunnelId !== meta.embed?.tunnelId) {
        this.#closeGrantSockets(id, GRANT_CLOSE.revoked);
        this.ctx.storage.kv.delete(key);
      }
    }
  }

  /** When the alarm must next look at grant sockets: the soonest expiry, or a recheck. */
  #nextGrantCheck() {
    let next = Infinity;
    for (const [, expiresAt] of this.ctx.storage.kv.list<number>({ prefix: "grant:" })) {
      next = Math.min(next, expiresAt, Date.now() + GRANT_RECHECK_MS);
    }
    return next;
  }

  /** Whether `key` is the one this pipe was opened with; only its hash is kept. */
  async #acceptsKey(meta: Meta, key: string) {
    if (!meta.accessHash || !isAccessKey(key)) return false;
    const presented = new TextEncoder().encode(await accessKeyHash(key));
    const stored = new TextEncoder().encode(meta.accessHash);
    return (
      presented.byteLength === stored.byteLength && crypto.subtle.timingSafeEqual(presented, stored)
    );
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

  #requestHead(request: Request): RequestHead {
    const url = new URL(request.url);
    return {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      // The host the viewer used, not the pipe's own URL: a pipe with a custom domain (ADR 0030)
      // answers on both, and an app builds its redirect URIs from what it is told.
      headers: viewerRequestHeaders(request.headers, request.url),
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

  async #openViewerSocket(request: Request, meta: Meta, grant: CheckedGrant | null) {
    const id = this.#nextStream();
    const stream: WsStream = { kind: "ws", opened: deferred() };
    this.#streams.set(id, stream);
    const head = this.#requestHead(request);
    // A browser's grant entries never reach the dev server (ADR 0032); the app's own do.
    const { grant: offered, own: protocols } = splitGrantProtocols(
      request.headers.get("sec-websocket-protocol"),
    );
    head.headers = head.headers.filter(([name]) => name.toLowerCase() !== "sec-websocket-protocol");
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
    this.ctx.acceptWebSocket(server, grant ? [`v:${id}`, `g:${grant.id}`] : [`v:${id}`]);
    if (grant) {
      // The alarm closes it when its grant expires, and rechecks it in the meantime.
      this.ctx.storage.kv.put(`grant:${grant.id}`, grant.expiresAt);
      this.#armAlarm(meta);
    }
    const headers = new Headers();
    const protocol = offered ? grantProtocolAnswer(opened.protocol) : opened.protocol;
    if (protocol) headers.set("sec-websocket-protocol", protocol);
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
      const embedded = this.#meta();
      if (embedded?.embed) await this.#checkGrantSockets(embedded);
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

  /** Takes the counts not yet sent to the Org object, leaving zero behind. */
  #takeUsage() {
    const usage = { bytes: this.#pendingUsage, requests: this.#pendingRequests };
    this.#pendingUsage = 0;
    this.#pendingRequests = 0;
    return usage;
  }

  /** Sends what piled up, after any send still running; ends the share at the org's limit. */
  async #flushUsage() {
    const send = this.#usageSends.then(() => {
      const meta = this.#meta();
      return meta ? this.#sendUsage(meta) : false;
    });
    this.#usageSends = send.catch(() => {});
    try {
      if (await send) await this.#end("limit");
    } catch (error) {
      // The batch stays stored and goes again with the next flush or the share's end.
      this.#log.warn("share.usage_send_failed", { error: String(error) });
    }
  }

  /**
   * Sends one batch to the Org object: the stored one if the last send did not get through (the
   * same number, so the Org object counts it once), else a new one from what piled up. The batch
   * is stored before it goes and deleted once the Org object has it. Returns whether the org is
   * now over a limit.
   */
  async #sendUsage(meta: Meta) {
    let batch = this.ctx.storage.kv.get<UsageBatch>("usage:batch");
    if (!batch) {
      if (!this.#pendingUsage && !this.#pendingRequests) return false;
      const seq = (this.ctx.storage.kv.get<number>("usage:seq") ?? 0) + 1;
      batch = { seq, ...this.#takeUsage() };
      this.ctx.storage.kv.put("usage:seq", seq);
      this.ctx.storage.kv.put("usage:batch", batch);
      meta.bytes += batch.bytes;
      this.#save(meta);
    }
    this.#lastUsageFlush = Date.now();
    const usage = await this.#org(meta.orgId).addUsage(
      meta.id,
      batch,
      {
        monthlyBytes: meta.limits.monthlyBytes,
        monthlyRequests: meta.limits.monthlyRequests ?? Number.POSITIVE_INFINITY,
        period: null,
        meter: null,
      },
      meta.embed && { appId: meta.embed.appId, tenantId: meta.embed.tenantId },
    );
    this.ctx.storage.kv.delete("usage:batch");
    return usage.over;
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
    // The usage still counts, even though the share is gone: after any send still running, a
    // batch that did not get through, then what piled up since. Later flushes see the tombstone
    // and send nothing.
    await this.#usageSends;
    for (let i = 0; i < 2; i++) {
      try {
        await this.#sendUsage(meta);
      } catch (error) {
        this.#log.warn("share.usage_lost", { shareId: meta.id, error: String(error) });
        break;
      }
    }
    const org = this.#org(meta.orgId);
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
