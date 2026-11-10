// The built-in transport: an RFC 6455 client over `node:net` and `node:tls`, for runtimes where the
// `ws` package is only a partial shim. Bun replaces `ws` with its own implementation that has no
// `upgrade` event (the relay's share URL arrives in the handshake response) and no
// `unexpected-response` (a refusal's fix arrives in its body), and a failed connection there ends
// the process with an unhandled error event. This client reads both, proxies through HTTP CONNECT
// like the Node path, and works the same on Node, Bun and a `bun build --compile` binary.
//
// It is a client only: frames out are masked, frames in must not be. It does not negotiate
// extensions (the relay never asks for compression) and does not validate text as UTF-8; the
// tunnel treats every message as bytes.
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import {
  type ConnectOptions,
  type Handshake,
  HandshakeRefused,
  type Transport,
  type WsConnection,
} from "./types.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_REFUSAL_BYTES = 16 * 1024;
const DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII, space, tab and obs-text: no CR, LF or NUL can reach the request.
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

function requestHead(url: URL, key: string, options: ConnectOptions) {
  const lines = [
    `GET ${url.pathname || "/"}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (options.protocols?.length) {
    for (const protocol of options.protocols) {
      if (!TOKEN.test(protocol)) throw new Error(`Not a subprotocol: ${protocol}`);
    }
    lines.push(`Sec-WebSocket-Protocol: ${options.protocols.join(", ")}`);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    // Headers come from callers and, for a local dev server, from a browser: refuse anything that
    // could end the head early or add one of its own.
    if (!TOKEN.test(name) || !FIELD_VALUE.test(value)) throw new Error(`Not a header: ${name}`);
    const lower = name.toLowerCase();
    if (
      ["host", "upgrade", "connection", "content-length", "transfer-encoding"].includes(lower) ||
      lower.startsWith("sec-websocket-key") ||
      lower === "sec-websocket-version"
    ) {
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

interface Head {
  status: number;
  headers: Record<string, string>;
  /** Bytes read after the blank line. */
  rest: Buffer;
}

/** Reads a response head (status line and headers) from `stream`; leaves the stream paused. */
function readHead(stream: net.Socket, deadline: number): Promise<Head> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(
      () => done(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
      Math.max(deadline - Date.now(), 1),
    );
    const done = (error?: Error, head?: Head) => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("close", onClose);
      stream.pause();
      if (error) reject(error);
      else resolve(head!);
    };
    const onError = (error: Error) => done(error);
    const onClose = () =>
      done(Object.assign(new Error("connection ended"), { code: "ECONNRESET" }));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > MAX_HEAD_BYTES) done(new Error("response head too large"));
        return;
      }
      const text = buffered.subarray(0, end).toString("latin1");
      const [statusLine = "", ...lines] = text.split("\r\n");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
      if (!status) return done(new Error("not an HTTP response"));
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon < 1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
      }
      done(undefined, { status, headers, rest: buffered.subarray(end + 4) });
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("close", onClose);
    stream.resume();
  });
}

/** The body of a refusal: Content-Length or chunked, or until the far end closes; capped. */
async function readRefusalBody(stream: net.Socket, head: Head, deadline: number): Promise<string> {
  const length = head.headers["content-length"];
  const chunked = /chunked/i.test(head.headers["transfer-encoding"] ?? "");
  const wanted = length === undefined ? Infinity : Math.min(Number(length), MAX_REFUSAL_BYTES);
  let raw = head.rest;
  const complete = () => {
    if (chunked) return /(^|\r\n)0\r\n\r\n$/.test(raw.toString("latin1"));
    return raw.length >= wanted;
  };
  if (!complete()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(Math.min(deadline - Date.now(), 3000), 1));
      const finish = () => {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve();
      };
      const onData = (chunk: Buffer) => {
        raw = Buffer.concat([raw, chunk]);
        if (complete() || raw.length > MAX_REFUSAL_BYTES * 2) finish();
      };
      stream.on("data", onData);
      stream.once("close", finish);
      stream.once("error", finish);
      stream.resume();
    });
  }
  if (!chunked) return raw.subarray(0, MAX_REFUSAL_BYTES).toString("utf8");
  // Chunked: `<hex size>\r\n<bytes>\r\n` repeated, ended by a zero size.
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString("latin1"), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts).subarray(0, MAX_REFUSAL_BYTES).toString("utf8");
}

function waitFor(stream: net.Socket, event: "connect" | "secureConnect", deadline: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
      Math.max(deadline - Date.now(), 1),
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      stream.off(event, ok);
      stream.destroy();
      reject(error);
    };
    const ok = () => {
      clearTimeout(timer);
      stream.off("error", fail);
      resolve();
    };
    stream.once(event, ok);
    stream.once("error", fail);
  });
}

const addressOnly = (host: string) => (net.isIP(host) ? undefined : host);

/** A connected stream to the target, through the proxy's CONNECT when one is named. */
async function openStream(
  secure: boolean,
  host: string,
  port: number,
  options: ConnectOptions,
  deadline: number,
): Promise<net.Socket> {
  const lookup = options.lookup;
  const family = options.autoSelectFamily;
  if (!options.proxy) {
    const stream = secure
      ? tls.connect({
          host,
          port,
          servername: addressOnly(host),
          lookup,
          autoSelectFamily: family,
        } as tls.ConnectionOptions)
      : net.connect({ host, port, lookup, autoSelectFamily: family });
    await waitFor(stream, secure ? "secureConnect" : "connect", deadline);
    return stream;
  }
  const proxy = new URL(options.proxy);
  const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  const toProxy =
    proxy.protocol === "https:"
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: addressOnly(proxyHost) })
      : net.connect({ host: proxyHost, port: proxyPort });
  await waitFor(toProxy, proxy.protocol === "https:" ? "secureConnect" : "connect", deadline);
  const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const auth =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}\r\n`
      : "";
  toProxy.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  const head = await readHead(toProxy, deadline).catch((error: Error) => {
    toProxy.destroy();
    throw error;
  });
  if (head.status !== 200) {
    const body = await readRefusalBody(toProxy, head, deadline);
    toProxy.destroy();
    throw new HandshakeRefused(head.status, body);
  }
  if (!secure) return toProxy;
  const upgraded = tls.connect({ socket: toProxy, servername: addressOnly(host) });
  await waitFor(upgraded, "secureConnect", deadline);
  return upgraded;
}

export const builtinTransport: Transport = {
  name: "builtin",
  async connect(url, options) {
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (secure ? 443 : 80);
    const deadline = Date.now() + (options.handshakeTimeout ?? 15_000);
    const key = randomBytes(16).toString("base64");
    const head = requestHead(url, key, options);

    const stream = await openStream(secure, host, port, options, deadline);
    stream.setNoDelay(true);
    let response: Head;
    try {
      stream.write(head);
      response = await readHead(stream, deadline);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    if (response.status !== 101) {
      const body = await readRefusalBody(stream, response, deadline);
      stream.destroy();
      throw new HandshakeRefused(response.status, body);
    }
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    if (
      response.headers["sec-websocket-accept"] !== accept ||
      response.headers["upgrade"]?.toLowerCase() !== "websocket"
    ) {
      stream.destroy();
      throw new Error("not a WebSocket answer");
    }
    const handshake: Handshake = { status: 101, headers: response.headers };
    const socket = new BuiltinSocket(stream, {
      protocol: response.headers["sec-websocket-protocol"] ?? "",
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      closeTimeout: options.closeTimeout ?? DEFAULT_CLOSE_TIMEOUT_MS,
    });
    options.onOpen?.(socket, handshake);
    socket.start(response.rest);
    return { socket, response: handshake };
  },
};

class BuiltinSocket extends EventEmitter implements WsConnection {
  readonly protocol: string;
  readonly #stream: net.Socket;
  readonly #maxPayload: number;
  readonly #closeTimeout: number;
  #state = OPEN;
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentOpcode: number | null = null;
  #fragmentBytes = 0;
  #closeSent = false;
  #closeTimer: NodeJS.Timeout | null = null;
  #code = 1006;
  #reason: Buffer = Buffer.alloc(0);
  #closed = false;

  constructor(
    stream: net.Socket,
    options: { protocol: string; maxPayload: number; closeTimeout: number },
  ) {
    super();
    this.#stream = stream;
    this.protocol = options.protocol;
    this.#maxPayload = options.maxPayload;
    this.#closeTimeout = options.closeTimeout;
  }

  get readyState() {
    return this.#state;
  }

  get bufferedAmount() {
    return this.#stream.writableLength;
  }

  /** Called once the caller has attached its listeners; delivers bytes that came with the head. */
  start(initial: Buffer) {
    this.#stream.on("data", (chunk: Buffer) => this.#ingest(chunk));
    this.#stream.on("error", (error) => {
      // Unlike a bare EventEmitter, a runtime must not die because nobody listened.
      if (this.listenerCount("error") > 0) this.emit("error", error);
    });
    this.#stream.on("close", () => this.#onStreamClose());
    this.#stream.on("end", () => this.#stream.end());
    this.#stream.resume();
    if (initial.length > 0) this.#ingest(initial);
  }

  send(data: string | Uint8Array, options: { binary?: boolean } = {}) {
    if (this.#state !== OPEN) return;
    const payload = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const binary = options.binary ?? typeof data !== "string";
    this.#write(binary ? Opcode.Binary : Opcode.Text, payload);
  }

  ping() {
    if (this.#state === OPEN) this.#write(Opcode.Ping, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    if (this.#state !== OPEN) return;
    const text = Buffer.from(reason);
    const payload = Buffer.alloc(2 + Math.min(text.length, 123));
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2, 0, payload.length - 2);
    this.#sendClose(payload);
  }

  terminate() {
    if (this.#state === CLOSED) return;
    this.#stream.destroy();
  }

  #sendClose(payload: Buffer) {
    if (this.#closeSent) return;
    this.#closeSent = true;
    this.#state = CLOSING;
    this.#write(Opcode.Close, payload);
    this.#closeTimer = setTimeout(() => this.#stream.destroy(), this.#closeTimeout);
    this.#closeTimer.unref();
  }

  #write(opcode: number, payload: Buffer) {
    const length = payload.length;
    const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
    const frame = Buffer.allocUnsafe(2 + lengthBytes + 4 + length);
    frame[0] = 0x80 | opcode;
    if (lengthBytes === 0) frame[1] = 0x80 | length;
    else if (lengthBytes === 2) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(length, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
    }
    const maskAt = 2 + lengthBytes;
    const mask = randomBytes(4);
    mask.copy(frame, maskAt);
    const body = maskAt + 4;
    for (let i = 0; i < length; i++) frame[body + i] = payload[i]! ^ mask[i & 3]!;
    if (!this.#stream.destroyed) this.#stream.write(frame);
  }

  #ingest(chunk: Buffer) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#state !== CLOSED && this.#parseFrame()) {
      // One frame per turn until the buffer holds less than a whole frame.
    }
  }

  /** Handles one frame at the start of the buffer. False when more bytes are needed. */
  #parseFrame(): boolean {
    const buffer = this.#buffer;
    if (buffer.length < 2) return false;
    const fin = (buffer[0]! & 0x80) !== 0;
    const opcode = buffer[0]! & 0x0f;
    if ((buffer[0]! & 0x70) !== 0) return this.#fail(1002, "reserved bits set");
    if ((buffer[1]! & 0x80) !== 0) return this.#fail(1002, "server frame is masked");
    let length = buffer[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.#fail(1009, "message too big");
      length = Number(big);
      offset = 10;
    }
    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) return this.#fail(1002, "bad control frame");
    if (length > this.#maxPayload || this.#fragmentBytes + length > this.#maxPayload) {
      return this.#fail(1009, "message too big");
    }
    if (buffer.length < offset + length) return false;
    const payload = buffer.subarray(offset, offset + length);
    this.#buffer = buffer.subarray(offset + length);
    this.#onFrame(fin, opcode, payload);
    return true;
  }

  #onFrame(fin: boolean, opcode: number, payload: Buffer) {
    switch (opcode) {
      case Opcode.Text:
      case Opcode.Binary:
        if (this.#fragmentOpcode !== null) return void this.#fail(1002, "unexpected data frame");
        if (fin) this.emit("message", Buffer.from(payload), opcode === Opcode.Binary);
        else {
          this.#fragmentOpcode = opcode;
          this.#fragments = [Buffer.from(payload)];
          this.#fragmentBytes = payload.length;
        }
        return;
      case Opcode.Continuation:
        if (this.#fragmentOpcode === null) return void this.#fail(1002, "unexpected continuation");
        this.#fragments.push(Buffer.from(payload));
        this.#fragmentBytes += payload.length;
        if (fin) {
          const message = Buffer.concat(this.#fragments);
          const binary = this.#fragmentOpcode === Opcode.Binary;
          this.#fragments = [];
          this.#fragmentOpcode = null;
          this.#fragmentBytes = 0;
          this.emit("message", message, binary);
        }
        return;
      case Opcode.Ping:
        if (this.#state === OPEN) this.#write(Opcode.Pong, Buffer.from(payload));
        return;
      case Opcode.Pong:
        return;
      case Opcode.Close: {
        this.#code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.#reason = Buffer.from(payload.subarray(2));
        if (!this.#closeSent) {
          // Echo the close the far end asked for, then let it end the connection.
          this.#sendClose(
            payload.length >= 2 ? Buffer.from(payload.subarray(0, 2)) : Buffer.alloc(0),
          );
        }
        this.#stream.end();
        return;
      }
      default:
        this.#fail(1002, "unknown opcode");
    }
  }

  /** A protocol violation: say why, then end. Always false, so the parse loop stops. */
  #fail(code: number, message: string): false {
    this.#code = code;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    if (this.listenerCount("error") > 0) this.emit("error", new Error(message));
    this.#sendClose(payload);
    this.#stream.end();
    return false;
  }

  #onStreamClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = CLOSED;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.emit("close", this.#code, this.#reason);
  }
}
