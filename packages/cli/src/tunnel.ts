// The share's connection: one WebSocket to `<WURMHOL_URL>/connect`, dialed like every call to the
// server (dial.ts). Every viewer
// request arrives on it as a stream and is forwarded to the dev server (127.0.0.1:<port> unless
// the owner names another host).
import http from "node:http";
import {
  chunk,
  decodeFrame,
  encodeFrame,
  type Frame,
  forwardable,
  type HeaderList,
  HEARTBEAT_MS,
  MAX_WS_MESSAGE_BYTES,
  PING_TEXT,
  PONG_TEXT,
  RECONNECT_GRACE_MS,
  ReceiveWindow,
  type RequestHead,
  SendWindow,
  type WsOpenPayload,
} from "@wurmhol/protocol";
import WebSocket from "ws";
import { dial } from "./dial.ts";
import { FixError } from "./errors.ts";
import type { CloseReason, PipeSource } from "./pipe.ts";

export interface ShareInfo {
  id: string;
  url: string;
  /** When the relay ends the share (ISO 8601). */
  endsAt: string;
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

/** One viewer request the dev server answered: metadata only, never bodies or headers. */
export interface RequestEvent {
  method: string;
  /** The path and query string, as the viewer asked for it. */
  path: string;
  status: number;
  durationMs: number;
}

export interface TunnelOptions {
  server: string;
  token: string;
  port: number;
  /** Where the dev server listens. */
  host: string;
  /** The lifetime a new share asks for, in seconds; the relay's default when absent. */
  ttl?: number;
  /** Emails of the org members who may open a new share (`--only`); empty: the whole org. */
  viewers: string[];
  /** A named pipe's name (`--name`): the same host every time. */
  name?: string;
  /** Where a new share comes from (ADR 0015); a reconnect keeps what the share started with. */
  source: PipeSource | null;
  version: string;
  log: Logger;
  onRequest: (event: RequestEvent) => void;
  /** The share ended for good (stopped, terminated, expired, revoked, or the CLI gave up). */
  onEnd: (reason: string) => void;
}

/** Close codes from the Share DO that end the share: never reconnect after these. */
const FINAL_CLOSE: Record<number, CloseReason> = {
  4001: "terminated",
  4002: "expired",
  4003: "revoked",
  4004: "limit",
  4005: "disconnected",
  4006: "no_subscription",
};

/** Above this many unsent bytes on the socket, body pumps wait: bounded memory here too. */
const SOCKET_HIGH_WATER = 4 * 1024 * 1024;

interface LocalHttp {
  kind: "http";
  method: string;
  path: string;
  startedAt: number;
  /** The status sent to the relay, once a response (the dev server's or a 502) has started. */
  status: number | null;
  reported: boolean;
  request: http.ClientRequest;
  response: http.IncomingMessage | null;
  send: SendWindow;
  receive: ReceiveWindow;
  bodyEnded: boolean;
  cancelled: boolean;
}

interface LocalWs {
  kind: "ws";
  socket: WebSocket;
}

function waitingPage(port: number) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="2"><title>Waiting for port ${port}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100svh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif}</style></head><body><p>Waiting for the server on port ${port}</p></body></html>`;
}

function toNodeHeaders(headers: HeaderList, port: number) {
  // Raw `[name, value, name, value]`: keeps order and repeated headers.
  const raw: string[] = [];
  for (const [name, value] of forwardable(headers)) raw.push(name, value);
  // Vite and most frameworks accept localhost without config (spec section 7).
  raw.push("host", `localhost:${port}`);
  return raw;
}

function pairs(rawHeaders: string[]): HeaderList {
  const list: HeaderList = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    list.push([rawHeaders[i]!, rawHeaders[i + 1]!]);
  return forwardable(list);
}

export class Tunnel {
  readonly #options: TunnelOptions;
  #socket: WebSocket | null = null;
  #share: ShareInfo | null = null;
  #streams = new Map<number, LocalHttp | LocalWs>();
  #stopping = false;
  #ended = false;
  #heartbeat: NodeJS.Timeout | null = null;
  #awaitingPong = false;
  #disconnectedAt: number | null = null;

  constructor(options: TunnelOptions) {
    this.#options = options;
  }

  get share() {
    return this.#share;
  }

  /** Connects and resolves with the share's id and URL, or rejects with a FixError. */
  async start(): Promise<ShareInfo> {
    await this.#dial();
    return this.#share!;
  }

  /** Ends the share on purpose (`wurmhol stop`, Ctrl-C): the relay ends it at once. */
  async stop() {
    this.#stopping = true;
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return this.#finish("stopped");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, "stop");
    });
    this.#finish("stopped");
  }

  #url() {
    const url = new URL("/connect", this.#options.server);
    if (this.#share) url.searchParams.set("share", this.#share.id);
    else {
      url.searchParams.set("port", String(this.#options.port));
      if (this.#options.ttl !== undefined) url.searchParams.set("ttl", String(this.#options.ttl));
      if (this.#options.name) url.searchParams.set("name", this.#options.name);
    }
    return url;
  }

  #dial(): Promise<WebSocket> {
    const { server, token, version, viewers, source } = this.#options;
    return dial(this.#url(), {
      server,
      token,
      version,
      // Who may open a new share and where it comes from; a reconnect keeps what it started with.
      headers: {
        ...(!this.#share && viewers.length ? { "wurmhol-viewers": viewers.join(",") } : {}),
        ...(!this.#share && source
          ? { "wurmhol-source": encodeURIComponent(JSON.stringify(source)) }
          : {}),
      },
      maxPayload: 2 * MAX_WS_MESSAGE_BYTES,
      onUpgrade: (response) => {
        const id = response.headers["x-wurmhol-share-id"];
        const shareUrl = response.headers["x-wurmhol-share-url"];
        const endsAt = response.headers["x-wurmhol-share-ends-at"];
        if (typeof id === "string" && typeof shareUrl === "string" && typeof endsAt === "string") {
          this.#share = { id, url: shareUrl, endsAt };
        }
      },
      onOpen: (socket) => this.#attach(socket),
    });
  }

  #attach(socket: WebSocket) {
    this.#socket = socket;
    this.#disconnectedAt = null;
    this.#awaitingPong = false;
    socket.on("message", (data, isBinary) => this.#onMessage(data as Buffer, isBinary));
    socket.on("close", (code, reason) => this.#onClose(socket, code, reason.toString()));
    socket.on("error", (error) => this.#options.log("socket.error", { message: error.message }));
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    // A heartbeat every 20 s keeps proxies from cutting an idle socket; a missed pong means
    // the socket is dead without a close, so drop it and reconnect.
    this.#heartbeat = setInterval(() => {
      if (this.#socket !== socket) return;
      if (this.#awaitingPong) {
        this.#options.log("heartbeat.missed");
        socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      socket.send(PING_TEXT);
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
    // The first heartbeat goes now, not in 20 s: workerd does not deliver a server-side close
    // (Terminate, expiry, a revoked token) on a socket the client has not yet sent on.
    this.#awaitingPong = true;
    socket.send(PING_TEXT);
    this.#options.log("connected", { shareId: this.#share?.id });
  }

  #send(frame: Frame) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(encodeFrame(frame));
    return true;
  }

  async #drain() {
    while (this.#socket && this.#socket.bufferedAmount > SOCKET_HIGH_WATER) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  #onMessage(data: Buffer, isBinary: boolean) {
    if (!isBinary) {
      if (data.toString() === PONG_TEXT) this.#awaitingPong = false;
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.#options.log("protocol.error", { message: (error as Error).message });
      return;
    }
    switch (frame.type) {
      case "request":
        this.#openHttp(frame.stream, frame.payload);
        return;
      case "ws-open":
        this.#openWs(frame.stream, frame.payload);
        return;
      default:
        this.#onStreamFrame(frame);
    }
  }

  #onStreamFrame(frame: Frame) {
    const stream = this.#streams.get(frame.stream);
    if (!stream) return;
    if (stream.kind === "ws") {
      if (frame.type === "ws-message") {
        if (stream.socket.readyState === WebSocket.OPEN) {
          stream.socket.send(frame.payload.data, { binary: frame.payload.binary });
        }
      } else if (frame.type === "ws-close") {
        const code =
          frame.payload.code === 1005 || frame.payload.code === 1006 ? 1000 : frame.payload.code;
        try {
          stream.socket.close(code, frame.payload.reason);
        } catch {
          stream.socket.terminate();
        }
        this.#streams.delete(frame.stream);
      }
      return;
    }
    if (frame.type === "window") {
      stream.send.grant(frame.payload.bytes);
    } else if (frame.type === "data") {
      if (stream.bodyEnded || stream.cancelled) return;
      stream.receive.received(frame.payload.byteLength);
      const bytes = frame.payload.byteLength;
      stream.request.write(frame.payload, () => {
        const grant = stream.receive.consumed(bytes);
        if (grant) this.#send({ stream: frame.stream, type: "window", payload: { bytes: grant } });
      });
    } else if (frame.type === "end") {
      if (frame.payload.error || stream.bodyEnded) {
        // The viewer went away, or the relay gave up: stop reading and writing.
        this.#cancelHttp(frame.stream, stream);
      } else {
        stream.bodyEnded = true;
        stream.request.end();
      }
    }
  }

  #openHttp(id: number, head: RequestHead) {
    const port = this.#options.port;
    const request = http.request({
      host: this.#options.host,
      port,
      method: head.method,
      path: head.path,
      headers: toNodeHeaders(head.headers, port),
      setHost: false,
    });
    const stream: LocalHttp = {
      kind: "http",
      method: head.method,
      path: head.path,
      startedAt: performance.now(),
      status: null,
      reported: false,
      request,
      response: null,
      send: new SendWindow(),
      receive: new ReceiveWindow(),
      bodyEnded: false,
      cancelled: false,
    };
    this.#streams.set(id, stream);
    request.on("response", (response) => {
      stream.response = response;
      stream.status = response.statusCode ?? 502;
      this.#send({
        stream: id,
        type: "response",
        payload: { status: stream.status, headers: pairs(response.rawHeaders) },
      });
      void this.#pumpResponse(id, stream, response);
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (stream.cancelled) return;
      if (stream.status === null) {
        stream.status = 502;
        const refused = error.code === "ECONNREFUSED";
        const body = Buffer.from(
          refused
            ? waitingPage(port)
            : `The local server on port ${port} failed: ${error.code ?? error.message}\n`,
        );
        this.#send({
          stream: id,
          type: "response",
          payload: {
            status: 502,
            headers: [
              ["content-type", refused ? "text/html; charset=utf-8" : "text/plain; charset=utf-8"],
              ["cache-control", "no-store"],
            ],
          },
        });
        for (const piece of chunk(body)) this.#send({ stream: id, type: "data", payload: piece });
      }
      this.#send({ stream: id, type: "end", payload: {} });
      this.#streams.delete(id);
      this.#report(stream);
    });
  }

  /** Tells the owner about a finished request, once, if the dev server's answer started. */
  #report(stream: LocalHttp) {
    if (stream.reported || stream.status === null) return;
    stream.reported = true;
    const { method, path, status, startedAt } = stream;
    this.#options.onRequest({
      method,
      path,
      status,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  async #pumpResponse(id: number, stream: LocalHttp, response: http.IncomingMessage) {
    try {
      for await (const buffer of response as AsyncIterable<Buffer>) {
        for (const piece of chunk(
          new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        )) {
          await stream.send.ready(piece.byteLength);
          if (stream.cancelled) return;
          stream.send.take(piece.byteLength);
          await this.#drain();
          // A copy: `ws` may hold the frame after this returns, and Node reuses its buffers.
          if (!this.#send({ stream: id, type: "data", payload: piece.slice() })) return;
        }
      }
      if (!stream.cancelled) this.#send({ stream: id, type: "end", payload: {} });
    } catch (error) {
      if (!stream.cancelled) {
        this.#send({ stream: id, type: "end", payload: { error: (error as Error).message } });
      }
    } finally {
      this.#streams.delete(id);
      this.#report(stream);
    }
  }

  #cancelHttp(id: number, stream: LocalHttp) {
    stream.cancelled = true;
    stream.send.release();
    stream.request.destroy();
    stream.response?.destroy();
    this.#streams.delete(id);
    this.#report(stream);
  }

  #openWs(id: number, open: WsOpenPayload) {
    const port = this.#options.port;
    // A Map, not an object literal: header names come from the browser, and one named
    // `__proto__` must not write to the object's prototype.
    const headers = new Map<string, string>();
    for (const [name, value] of forwardable(open.headers ?? [])) {
      if (!/^sec-websocket-/i.test(name)) headers.set(name, value);
    }
    headers.set("host", `localhost:${port}`);
    const socket = new WebSocket(
      `ws://${this.#options.host.includes(":") ? `[${this.#options.host}]` : this.#options.host}:${port}${open.path ?? "/"}`,
      open.protocols ?? [],
      {
        headers: Object.fromEntries(headers),
        perMessageDeflate: false,
        maxPayload: MAX_WS_MESSAGE_BYTES,
      },
    );
    socket.binaryType = "nodebuffer";
    let opened = false;
    this.#streams.set(id, { kind: "ws", socket });
    socket.once("open", () => {
      opened = true;
      this.#send({
        stream: id,
        type: "ws-open",
        payload: { accepted: true, ...(socket.protocol ? { protocol: socket.protocol } : {}) },
      });
    });
    socket.on("message", (data: Buffer, isBinary) => {
      this.#send({ stream: id, type: "ws-message", payload: { binary: isBinary, data } });
    });
    socket.on("close", (code, reason) => {
      if (!this.#streams.has(id)) return;
      this.#streams.delete(id);
      if (opened)
        this.#send({ stream: id, type: "ws-close", payload: { code, reason: reason.toString() } });
    });
    socket.on("error", () => {
      if (!opened) {
        this.#streams.delete(id);
        this.#send({ stream: id, type: "ws-open", payload: { accepted: false } });
      }
    });
  }

  #dropStreams() {
    for (const [id, stream] of this.#streams) {
      if (stream.kind === "http") this.#cancelHttp(id, stream);
      else stream.socket.terminate();
    }
    this.#streams.clear();
  }

  #onClose(socket: WebSocket, code: number, reason: string) {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#dropStreams();
    this.#options.log("disconnected", { code, reason });
    if (this.#stopping) return;
    const final = FINAL_CLOSE[code];
    if (final) return this.#finish(final);
    if (code === 1000) return this.#finish(reason || "stopped");
    void this.#reconnect();
  }

  /** Same share id, within the 60 s grace, with backoff; then it gives up. */
  async #reconnect() {
    this.#disconnectedAt ??= Date.now();
    let delay = 250;
    while (!this.#stopping && Date.now() - this.#disconnectedAt < RECONNECT_GRACE_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5000);
      try {
        await this.#dial();
        this.#options.log("reconnected", { shareId: this.#share?.id });
        return;
      } catch (error) {
        const fix = error instanceof FixError ? error : null;
        this.#options.log("reconnect.failed", { message: (error as Error).message });
        // The relay says the share is over (ended, revoked, no plan): stop trying.
        if (fix?.final) return this.#finish(fix.reason ?? "ended");
      }
    }
    if (!this.#stopping) this.#finish("disconnected");
  }

  #finish(reason: string) {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#dropStreams();
    this.#options.onEnd(reason);
  }
}
