// The frame codec. One WebSocket between the CLI and its Share Durable Object carries many
// streams; every binary message is one frame:
//
//   byte 0      frame type (FRAME_TYPES)
//   bytes 1..4  stream id, unsigned 32-bit big-endian (0 is the connection itself)
//   bytes 5..   payload: raw bytes for `data` and `ws-message`, UTF-8 JSON for the rest
//
// `ping` is the one exception: it travels as the exact text message PING_TEXT, answered with
// PONG_TEXT, so the Durable Object can answer it while hibernated (WebSocket auto-response
// matches text messages only) and the CLI's heartbeat never wakes it.

/** Wire values of each frame type. Append only: values are the protocol. */
export const FRAME_TYPES = {
  request: 1,
  response: 2,
  data: 3,
  end: 4,
  "ws-open": 5,
  "ws-message": 6,
  "ws-close": 7,
  ping: 8,
  // Flow control (ADR 0002): the receiver grants the sender more bytes on a stream.
  window: 9,
} as const;

export type FrameType = keyof typeof FRAME_TYPES;

const TYPE_BY_WIRE = new Map<number, FrameType>(
  Object.entries(FRAME_TYPES).map(([name, wire]) => [wire, name as FrameType]),
);

/** Heartbeat, sent by the CLI as a text message every HEARTBEAT_MS. */
export const PING_TEXT = "wurmhol:ping";
/** The Durable Object's automatic answer to PING_TEXT. */
export const PONG_TEXT = "wurmhol:pong";

/** The CLI's heartbeat interval. */
export const HEARTBEAT_MS = 20_000;
/** How long a share keeps its id while its CLI is away, waiting for it to reconnect. */
export const RECONNECT_GRACE_MS = 60_000;
/** Largest body chunk in one `data` or `ws-message` frame. */
export const MAX_CHUNK_BYTES = 64 * 1024;
/** Largest `ws-message` the relay carries whole (browser WebSocket messages are not chunked). */
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;
const HEADER_BYTES = 5;
const MAX_STREAM_ID = 0xffff_ffff;

/** Header list as sent on the wire: order and repeats kept (`set-cookie`). */
export type HeaderList = [name: string, value: string][];

export interface RequestHead {
  method: string;
  /** Path and query, as the viewer sent it (`/assets/app.js?v=3`). */
  path: string;
  headers: HeaderList;
}

export interface ResponseHead {
  status: number;
  headers: HeaderList;
}

/** End of a body. Without `error` the body is complete; with it the stream was cut short. */
export interface EndPayload {
  error?: string;
}

export interface WsOpenPayload {
  /** Relay to CLI: the browser's handshake. */
  path?: string;
  headers?: HeaderList;
  protocols?: string[];
  /** CLI to relay: the local server accepted, with the subprotocol it picked. */
  accepted?: boolean;
  protocol?: string;
}

export interface WsClosePayload {
  code: number;
  reason: string;
}

export interface WindowPayload {
  /** Bytes the sender may send on this stream on top of what it was granted before. */
  bytes: number;
}

export type Frame =
  | { stream: number; type: "request"; payload: RequestHead }
  | { stream: number; type: "response"; payload: ResponseHead }
  | { stream: number; type: "data"; payload: Uint8Array }
  | { stream: number; type: "end"; payload: EndPayload }
  | { stream: number; type: "ws-open"; payload: WsOpenPayload }
  | { stream: number; type: "ws-message"; payload: { binary: boolean; data: Uint8Array } }
  | { stream: number; type: "ws-close"; payload: WsClosePayload }
  | { stream: number; type: "ping"; payload: null }
  | { stream: number; type: "window"; payload: WindowPayload };

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function header(type: FrameType, stream: number, payloadBytes: number) {
  if (!Number.isInteger(stream) || stream < 0 || stream > MAX_STREAM_ID) {
    throw new ProtocolError(`stream id out of range: ${stream}`);
  }
  const bytes = new Uint8Array(HEADER_BYTES + payloadBytes);
  bytes[0] = FRAME_TYPES[type];
  new DataView(bytes.buffer).setUint32(1, stream);
  return bytes;
}

/** Encodes one frame as a binary WebSocket message. `ping` is text: use PING_TEXT. */
export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case "ping":
      throw new ProtocolError("ping travels as PING_TEXT, not a binary frame");
    case "data": {
      if (frame.payload.byteLength > MAX_CHUNK_BYTES) {
        throw new ProtocolError(`data frame over ${MAX_CHUNK_BYTES} bytes; chunk the body`);
      }
      const bytes = header("data", frame.stream, frame.payload.byteLength);
      bytes.set(frame.payload, HEADER_BYTES);
      return bytes;
    }
    case "ws-message": {
      const { binary, data } = frame.payload;
      if (data.byteLength > MAX_WS_MESSAGE_BYTES) {
        throw new ProtocolError(`websocket message over ${MAX_WS_MESSAGE_BYTES} bytes`);
      }
      const bytes = header("ws-message", frame.stream, 1 + data.byteLength);
      bytes[HEADER_BYTES] = binary ? 1 : 0;
      bytes.set(data, HEADER_BYTES + 1);
      return bytes;
    }
    default: {
      const json = encoder.encode(JSON.stringify(frame.payload));
      const bytes = header(frame.type, frame.stream, json.byteLength);
      bytes.set(json, HEADER_BYTES);
      return bytes;
    }
  }
}

function asBytes(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return new Uint8Array(message);
}

function parseJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    throw new ProtocolError("frame payload is not valid UTF-8 JSON");
  }
}

function isHeaderList(value: unknown): value is HeaderList {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    )
  );
}

function object(value: unknown, type: FrameType): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${type} payload must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Decodes one WebSocket message. Text messages are only ever PING_TEXT (or PONG_TEXT, which
 * decodes as `ping` too). Throws ProtocolError on anything malformed: the peer is broken or
 * hostile, and the connection should close.
 */
export function decodeFrame(message: string | ArrayBuffer | ArrayBufferView): Frame {
  if (typeof message === "string") {
    if (message === PING_TEXT || message === PONG_TEXT) {
      return { stream: 0, type: "ping", payload: null };
    }
    throw new ProtocolError("unexpected text message");
  }
  const bytes = asBytes(message);
  if (bytes.byteLength < HEADER_BYTES) throw new ProtocolError("frame shorter than its header");
  const type = TYPE_BY_WIRE.get(bytes[0]!);
  if (!type) throw new ProtocolError(`unknown frame type ${bytes[0]}`);
  const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const payload = bytes.subarray(HEADER_BYTES);

  switch (type) {
    case "ping":
      return { stream, type, payload: null };
    case "data":
      if (payload.byteLength > MAX_CHUNK_BYTES) throw new ProtocolError("data frame too large");
      return { stream, type, payload };
    case "ws-message": {
      if (payload.byteLength < 1) throw new ProtocolError("ws-message without its kind byte");
      if (payload.byteLength - 1 > MAX_WS_MESSAGE_BYTES) {
        throw new ProtocolError("websocket message too large");
      }
      const kind = payload[0];
      if (kind !== 0 && kind !== 1) throw new ProtocolError("ws-message kind must be 0 or 1");
      return { stream, type, payload: { binary: kind === 1, data: payload.subarray(1) } };
    }
    case "request": {
      const p = object(parseJson(payload), type);
      if (typeof p.method !== "string" || !/^[A-Z]+$/.test(p.method)) {
        throw new ProtocolError("request needs a method");
      }
      if (typeof p.path !== "string" || !p.path.startsWith("/")) {
        throw new ProtocolError("request path must start with /");
      }
      if (!isHeaderList(p.headers)) throw new ProtocolError("request headers must be pairs");
      return { stream, type, payload: { method: p.method, path: p.path, headers: p.headers } };
    }
    case "response": {
      const p = object(parseJson(payload), type);
      if (typeof p.status !== "number" || !Number.isInteger(p.status)) {
        throw new ProtocolError("response needs an integer status");
      }
      if (p.status < 100 || p.status > 599) throw new ProtocolError("response status out of range");
      if (!isHeaderList(p.headers)) throw new ProtocolError("response headers must be pairs");
      return { stream, type, payload: { status: p.status, headers: p.headers } };
    }
    case "end": {
      const p = object(parseJson(payload), type);
      if (p.error !== undefined && typeof p.error !== "string") {
        throw new ProtocolError("end error must be a string");
      }
      return { stream, type, payload: p.error === undefined ? {} : { error: p.error } };
    }
    case "ws-open": {
      const p = object(parseJson(payload), type);
      if (p.headers !== undefined && !isHeaderList(p.headers)) {
        throw new ProtocolError("ws-open headers must be pairs");
      }
      return { stream, type, payload: p as WsOpenPayload };
    }
    case "ws-close": {
      const p = object(parseJson(payload), type);
      if (typeof p.code !== "number" || typeof p.reason !== "string") {
        throw new ProtocolError("ws-close needs a code and a reason");
      }
      return { stream, type, payload: { code: p.code, reason: p.reason } };
    }
    case "window": {
      const p = object(parseJson(payload), type);
      if (typeof p.bytes !== "number" || !Number.isInteger(p.bytes) || p.bytes <= 0) {
        throw new ProtocolError("window needs a positive whole number of bytes");
      }
      return { stream, type, payload: { bytes: p.bytes } };
    }
  }
}

/**
 * Splits a body into `data` frames of at most `max` bytes each, without copying (each chunk is a
 * view onto `body`). An empty body yields no frames: its `end` frame says it all.
 */
export function* chunk(body: Uint8Array, max = MAX_CHUNK_BYTES): Generator<Uint8Array> {
  if (max <= 0 || max > MAX_CHUNK_BYTES) throw new ProtocolError("chunk size out of range");
  for (let offset = 0; offset < body.byteLength; offset += max) {
    yield body.subarray(offset, Math.min(offset + max, body.byteLength));
  }
}
