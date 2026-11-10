// The Node transport: the `ws` package, which Node's own WebSocket cannot replace here (no
// custom headers, no handshake response, no proxy agent). `ws` is imported when first used, so
// a runtime that never selects this transport never loads it.
import type { IncomingMessage } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  type ConnectOptions,
  type Handshake,
  HandshakeRefused,
  type Transport,
  type WsConnection,
} from "./types.ts";

function handshakeOf(response: IncomingMessage): Handshake {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { status: response.statusCode ?? 101, headers };
}

export const nodeTransport: Transport = {
  name: "node",
  async connect(url, options: ConnectOptions) {
    const { default: WebSocket } = await import("ws");
    const agent = options.proxy ? new HttpsProxyAgent(options.proxy) : undefined;
    // `closeTimeout` (ws 8.22) is not in @types/ws yet.
    const socketOptions: import("ws").ClientOptions & { closeTimeout?: number } = {
      headers: options.headers,
      agent,
      perMessageDeflate: false,
      handshakeTimeout: options.handshakeTimeout ?? 15_000,
      ...(options.closeTimeout === undefined ? {} : { closeTimeout: options.closeTimeout }),
      ...(options.maxPayload === undefined ? {} : { maxPayload: options.maxPayload }),
      ...(options.lookup ? { lookup: options.lookup } : {}),
      ...(options.autoSelectFamily === undefined
        ? {}
        : { autoSelectFamily: options.autoSelectFamily }),
    };
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, options.protocols ?? [], socketOptions);
      socket.binaryType = "nodebuffer";
      let response: Handshake = { status: 101, headers: {} };
      socket.once("upgrade", (res) => (response = handshakeOf(res)));
      socket.once("open", () => {
        options.onOpen?.(socket as unknown as WsConnection, response);
        resolve({ socket: socket as unknown as WsConnection, response });
      });
      socket.once("unexpected-response", (_request, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          reject(new HandshakeRefused(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
          socket.terminate();
        });
      });
      socket.once("error", reject);
    });
  },
};
