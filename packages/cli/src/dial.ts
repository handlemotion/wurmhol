// Reaching the server from a sandbox: every call goes through HTTPS_PROXY when one is set (and
// trusts NODE_EXTRA_CA_CERTS, which Node reads itself), and every failure becomes a FixError that
// says the fix. Used by the pipe's and the host's WebSockets, and by login's and doctor's HTTP
// calls.
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import WebSocket from "ws";
import { explainConnectError, explainRefusal } from "./errors.ts";

export function userAgent(version: string) {
  return `wurmhol/${version} node/${process.versions.node}`;
}

/** The proxy HTTPS_PROXY names for an http(s) URL (empty when none), and an agent through it. */
export function proxyFor(url: URL) {
  const proxy = getProxyForUrl(url.toString());
  return { proxy, agent: proxy ? new HttpsProxyAgent(proxy) : undefined };
}

export interface DialOptions {
  /** The server's origin, as failures name it. */
  server: string;
  token: string;
  version: string;
  /** Sent after `authorization`, before `user-agent`. */
  headers?: Record<string, string>;
  maxPayload?: number;
  /** The handshake's response, before `open`. */
  onUpgrade?: (response: IncomingMessage) => void;
  /**
   * Runs from the open event itself, before the promise resolves: the server may send a message
   * in the same packet as the upgrade, and `ws` emits it before an awaiting caller could attach.
   */
  onOpen?: (socket: WebSocket) => void;
}

/**
 * How long a socket waits, once both sides have sent their close frames, for the server to end
 * the connection before ending it itself. `ws` waits 30 s by default, and until then emits no
 * `close`: a revoked pipe or computer would keep running that long.
 */
const CLOSE_TIMEOUT_MS = 2_000;

/** Opens a WebSocket to an http(s) URL on the server, or rejects with a FixError. */
export function dial(target: URL, options: DialOptions): Promise<WebSocket> {
  const { proxy, agent } = proxyFor(target);
  const url = new URL(target);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  // `closeTimeout` (ws 8.22) is not in @types/ws yet.
  const socketOptions: WebSocket.ClientOptions & { closeTimeout: number } = {
    headers: {
      authorization: `Bearer ${options.token}`,
      ...options.headers,
      "user-agent": userAgent(options.version),
    },
    agent,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
    closeTimeout: CLOSE_TIMEOUT_MS,
    ...(options.maxPayload === undefined ? {} : { maxPayload: options.maxPayload }),
  };
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, socketOptions);
    socket.binaryType = "nodebuffer";
    if (options.onUpgrade) socket.once("upgrade", options.onUpgrade);
    socket.once("open", () => {
      options.onOpen?.(socket);
      resolve(socket);
    });
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (c: Buffer) => chunks.push(c));
      response.on("end", () => {
        reject(
          explainRefusal(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"), {
            server: options.server,
            viaProxy: Boolean(proxy),
          }),
        );
        socket.terminate();
      });
    });
    socket.once("error", (error) =>
      reject(explainConnectError(error, { server: options.server, proxy })),
    );
  });
}

/** An HTTP answer: from the far end, or from a proxy that refused the tunnel (`proxyStatus`). */
export interface Answer {
  status: number;
  body: string;
  viaProxy: boolean;
  /** The proxy's answer to CONNECT, when the call went through one. */
  proxyStatus: number | undefined;
}

export interface SendOptions {
  /** The origin failures name. */
  server: string;
  version: string;
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
}

/**
 * One HTTP call through the environment's proxy. Rejects with a FixError, whose `cause` is the
 * connection's own error, when no HTTP answer came.
 */
export function send(url: URL, options: SendOptions): Promise<Answer> {
  const { proxy, agent } = proxyFor(url);
  const request = url.protocol === "http:" ? httpRequest : httpsRequest;
  const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
  const headers: Record<string, string | number> = {
    ...options.headers,
    "user-agent": userAgent(options.version),
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    let proxyStatus: number | undefined;
    const req = request(
      url,
      { method: options.method ?? "GET", headers, agent, timeout: 15_000 },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            viaProxy: Boolean(proxy),
            proxyStatus,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("proxyConnect", (connect: { statusCode: number }) => (proxyStatus = connect.statusCode));
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    );
    req.on("error", (error) => {
      const fix = explainConnectError(error, { server: options.server, proxy });
      fix.cause = error;
      reject(fix);
    });
    req.end(payload);
  });
}
