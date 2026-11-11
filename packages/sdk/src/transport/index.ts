import { builtinTransport } from "./builtin.ts";
import { nodeTransport } from "./node.ts";
import type { Transport } from "./types.ts";

export type { ConnectOptions, Handshake, Transport, WsConnection } from "./types.ts";
export { HandshakeRefused, WS_OPEN } from "./types.ts";

/** Which WebSocket implementation to use; `"auto"` picks by runtime (ADR 0030). */
export type TransportChoice = "auto" | "node" | "builtin";

export type Runtime = "node" | "bun" | "deno";

/** The JavaScript runtime this code runs on. */
export function runtime(): Runtime {
  const scope = globalThis as { Bun?: unknown; Deno?: unknown };
  if (scope.Bun !== undefined) return "bun";
  if (scope.Deno !== undefined) return "deno";
  return "node";
}

/**
 * The `ws` package on Node, which is the proven path. Bun (and a compiled Bun binary) and Deno get
 * the built-in client: Bun's `ws` shim lacks the handshake response and the refusal body the relay
 * speaks through.
 */
export function selectTransport(choice: TransportChoice = "auto"): Transport {
  if (choice === "node") return nodeTransport;
  if (choice === "builtin") return builtinTransport;
  return runtime() === "node" ? nodeTransport : builtinTransport;
}
