// Reaching the relay over a WebSocket: through HTTPS_PROXY when one is set, on whichever
// transport suits the runtime (transport/index.ts), with every failure turned into a FixError
// that says the fix. Used by the pipe's and the host's sockets.
import { explainConnectError, explainRefusal, FixError } from "./errors.ts";
import { proxyFor, userAgent } from "./http.ts";
import {
  type Handshake,
  HandshakeRefused,
  selectTransport,
  type Transport,
  type WsConnection,
} from "./transport/index.ts";

export interface DialOptions {
  /** The server's origin, as failures name it. */
  server: string;
  token: string;
  version: string;
  /** Sent after `authorization`, before `user-agent`. */
  headers?: Record<string, string>;
  maxPayload?: number;
  /** The handshake's response, before `open`. */
  onUpgrade?: (response: Handshake) => void;
  /**
   * Runs from the open event itself, before the promise resolves: the server may send a message
   * in the same packet as the handshake, and the socket emits it before an awaiting caller could
   * attach.
   */
  onOpen?: (socket: WsConnection) => void;
  /** Default: chosen by runtime. */
  transport?: Transport;
  /** Overrides the User-Agent product name. */
  product?: string;
}

/**
 * How long a socket waits, once both sides have sent their close frames, for the server to end
 * the connection before ending it itself. `ws` waits 30 s by default, and until then emits no
 * `close`: a revoked pipe or computer would keep running that long.
 */
const CLOSE_TIMEOUT_MS = 2_000;

/** Opens a WebSocket to an http(s) URL on the server, or rejects with a FixError. */
export async function dial(target: URL, options: DialOptions): Promise<WsConnection> {
  const { proxy } = proxyFor(target);
  const url = new URL(target);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const transport = options.transport ?? selectTransport();

  try {
    const { socket } = await transport.connect(url, {
      headers: {
        authorization: `Bearer ${options.token}`,
        ...options.headers,
        "user-agent": userAgent(options.version, options.product),
      },
      proxy: proxy || undefined,
      handshakeTimeout: 15_000,
      closeTimeout: CLOSE_TIMEOUT_MS,
      // Both transports treat an undefined limit as their default.
      maxPayload: options.maxPayload,
      onOpen: (socket, response) => {
        options.onUpgrade?.(response);
        options.onOpen?.(socket);
      },
    });

    return socket;
  } catch (error) {
    if (error instanceof FixError) throw error;

    if (error instanceof HandshakeRefused) {
      throw explainRefusal(error.status, error.body, {
        server: options.server,
        viaProxy: Boolean(proxy),
      });
    }

    throw explainConnectError(error instanceof Error ? error : new Error(String(error)), {
      server: options.server,
      proxy,
    });
  }
}
