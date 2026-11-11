// The WebSocket the SDK needs, as an interface: the relay's connection and the connection to a
// local dev server both go through it. Two implementations exist (ADR 0030): `ws` on Node, and a
// built-in client over `node:net`/`node:tls` for runtimes where `ws` is only a partial shim (Bun,
// including a `bun build --compile` binary). The shape is the small part of `ws` the tunnel uses.

/** `readyState` of an open connection (the browser and `ws` value). */
export const WS_OPEN = 1;

export type MessageListener = (data: Buffer, isBinary: boolean) => void;
export type CloseListener = (code: number, reason: Buffer) => void;
export type ErrorListener = (error: Error) => void;

export interface WsConnection {
  /** 1 while open, 2 closing, 3 closed. */
  readonly readyState: number;
  /** Bytes queued and not yet written to the network. */
  readonly bufferedAmount: number;
  /** The subprotocol the far end chose, or "". */
  readonly protocol: string;
  send(data: string | Uint8Array, options?: { binary?: boolean }): void;
  ping(): void;
  /** Starts the close handshake; the connection ends when the far end answers or after a timeout. */
  close(code?: number, reason?: string): void;
  /** Ends the connection now, without a close handshake. */
  terminate(): void;
  on(event: "message", listener: MessageListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "error", listener: ErrorListener): this;
  once(event: "message", listener: MessageListener): this;
  once(event: "close", listener: CloseListener): this;
  once(event: "error", listener: ErrorListener): this;
}

/** The handshake response: what the relay says about a new connection, in its headers. */
export interface Handshake {
  status: number;
  /** Lower-cased names. A repeated header is joined with ", ". */
  headers: Record<string, string>;
}

/** A refused handshake (any answer but 101): the status and what the far end said. */
export class HandshakeRefused extends Error {
  override name = "HandshakeRefused";
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`handshake refused: HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export interface ConnectOptions {
  headers?: Record<string, string>;
  protocols?: string[];
  maxPayload?: number;
  handshakeTimeout?: number;
  /** How long to wait for the far end to end the connection after both sides sent a close frame. */
  closeTimeout?: number;
  /** The proxy URL to reach the target through (CONNECT), when the environment names one. */
  proxy?: string;
  /** How to resolve the target: a dev server on loopback is given both addresses (loopback.ts). */
  lookup?: import("node:net").LookupFunction;
  autoSelectFamily?: boolean;
  /**
   * Runs from the open event itself, before the promise resolves and before any message is
   * delivered: the relay may send a message in the same packet as the handshake response.
   */
  onOpen?: (socket: WsConnection, response: Handshake) => void;
}

export interface Transport {
  readonly name: "node" | "builtin";
  /**
   * Opens a WebSocket to a `ws:`/`wss:` URL. Resolves once it is open. Rejects with
   * `HandshakeRefused` for an HTTP answer other than 101, or with the connection's own error
   * (`code` set when it has one: ENOTFOUND, ECONNREFUSED, a TLS failure, ETIMEDOUT).
   */
  connect(
    url: URL,
    options: ConnectOptions,
  ): Promise<{ socket: WsConnection; response: Handshake }>;
}
