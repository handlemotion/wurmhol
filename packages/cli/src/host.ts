// `wurmhol host` (ADR 0018): this computer, connected to the wall. One WebSocket to
// `<WURMHOL_URL>/host`, dialed like a pipe's (HTTPS_PROXY, NODE_EXTRA_CA_CERTS). It reports the
// web ports open here as they come and go; when its owner picks one in Create pipe, the relay
// asks it to open a pipe to that port, and it answers with the pipe's URL or why it could not.
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import WebSocket from "ws";
import { explainConnectError, explainRefusal, FixError } from "./errors.ts";
import { type LocalPort, PortScanner } from "./ports.ts";

export interface HostOptions {
  server: string;
  token: string;
  /** The computer's name, as its owner sees it in Create pipe. */
  name: string;
  version: string;
  /** Opens a pipe to a port; resolves with its URL, or rejects with a FixError. */
  open: (port: number) => Promise<string>;
  /** One line for the person at the terminal. */
  say: (line: string) => void;
}

/** How often the ports are looked at again. */
const SCAN_MS = 3000;

type FromRelay = { type: "open"; id: string; port: number };

function dial(options: HostOptions): Promise<WebSocket> {
  const url = new URL("/host", options.server);
  url.searchParams.set("name", options.name);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const proxy = getProxyForUrl(url.toString().replace(/^ws/, "http"));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${options.token}`,
        "user-agent": `wurmhol/${options.version} node/${process.versions.node}`,
      },
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    socket.once("open", () => resolve(socket));
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

/**
 * Stays connected until the process ends, reconnecting with backoff. Rejects only when the relay
 * says retrying cannot help (a revoked token, say), with the fix.
 */
export async function host(options: HostOptions): Promise<never> {
  const scanner = new PortScanner();
  let delay = 1000;
  let first = true;
  for (;;) {
    let socket: WebSocket;
    try {
      socket = await dial(options);
    } catch (error) {
      if (error instanceof FixError && error.final) throw error;
      options.say(`${error instanceof Error ? error.message : String(error)} Retrying.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
      continue;
    }
    delay = 1000;
    if (first) {
      options.say(`Connected as ${options.name}. Open a pipe from Create pipe on the wall.`);
      first = false;
    } else {
      options.say("Reconnected.");
    }
    await session(socket, scanner, options);
  }
}

/** One connection: reports ports and answers opens until the socket closes. */
function session(socket: WebSocket, scanner: PortScanner, options: HostOptions) {
  return new Promise<void>((resolve) => {
    let sent = "";
    const report = async () => {
      const ports: LocalPort[] = await scanner.scan();
      const message = JSON.stringify({ type: "ports", ports });
      if (message === sent || socket.readyState !== WebSocket.OPEN) return;
      socket.send(message);
      sent = message;
    };
    void report();
    const timer = setInterval(() => void report(), SCAN_MS);
    // Keeps proxies from dropping a socket that is quiet while no ports change.
    const ping = setInterval(() => socket.ping(), 30_000);
    socket.on("message", (data, binary) => {
      if (binary) return;
      let message: FromRelay;
      try {
        message = JSON.parse(String(data)) as FromRelay;
      } catch {
        return;
      }
      if (message.type !== "open" || !Number.isInteger(message.port)) return;
      options.say(`Opening a pipe to port ${message.port}…`);
      options.open(message.port).then(
        (url) => {
          options.say(`${message.port} → ${url}`);
          socket.send(JSON.stringify({ type: "opened", id: message.id, url }));
        },
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          options.say(`Could not open port ${message.port}: ${text}`);
          socket.send(
            JSON.stringify({ type: "failed", id: message.id, message: text.slice(0, 500) }),
          );
        },
      );
    });
    socket.once("close", (code, reason) => {
      clearInterval(timer);
      clearInterval(ping);
      if (code === 4001) options.say(`Disconnected: ${String(reason) || "token revoked"}.`);
      resolve();
    });
    socket.on("error", () => socket.terminate());
  });
}
