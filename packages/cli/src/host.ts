// `wurmhol host` (ADR 0018): this computer, connected to the wall. One WebSocket to
// `<WURMHOL_URL>/host`, dialed like a pipe's (HTTPS_PROXY, NODE_EXTRA_CA_CERTS). It reports the
// web ports open here as they come and go; when its owner picks one in Create pipe, the relay
// asks it to open a pipe to that port, and it answers with the pipe's URL or why it could not.
import { type HostMessage, MACHINE_LIMITS, parseRelayMessage } from "@wurmhol/protocol";
import WebSocket from "ws";
import { dial } from "./dial.ts";
import { FixError } from "./errors.ts";
import { PortScanner } from "./ports.ts";

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

function connect(options: HostOptions): Promise<WebSocket> {
  const url = new URL("/host", options.server);
  url.searchParams.set("name", options.name);
  return dial(url, { server: options.server, token: options.token, version: options.version });
}

/**
 * Stays connected until the process ends, reconnecting with backoff. Rejects only when the relay
 * says retrying cannot help (a revoked token, say), with the fix.
 */
export async function host(options: HostOptions): Promise<never> {
  const scanner = new PortScanner(options.server);
  let delay = 1000;
  let first = true;
  for (;;) {
    let socket: WebSocket;
    try {
      socket = await connect(options);
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
    const send = (message: HostMessage) => socket.send(JSON.stringify(message));
    const report = async () => {
      const message = JSON.stringify({
        type: "ports",
        ports: await scanner.scan(),
      } satisfies HostMessage);
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
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const message = parseRelayMessage(raw);
      if (!message) return;
      options.say(`Opening a pipe to port ${message.port}…`);
      options.open(message.port).then(
        (url) => {
          options.say(`${message.port} → ${url}`);
          send({ type: "opened", id: message.id, url });
        },
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          options.say(`Could not open port ${message.port}: ${text}`);
          send({ type: "failed", id: message.id, message: text.slice(0, MACHINE_LIMITS.message) });
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
