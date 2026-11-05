// Every failure the CLI reports says the fix in one line (spec section 7).
import { parseRefusal } from "@wurmhol/protocol";
import type { CloseReason } from "./pipe.ts";

export class FixError extends Error {
  override name = "FixError";
  /** Retrying cannot help: a reconnect would fail the same way. */
  readonly final: boolean;
  /** Why the relay says the share is over, on a refusal that ends it. */
  readonly reason: CloseReason | undefined;

  constructor(message: string, options: { final?: boolean; reason?: CloseReason } = {}) {
    super(message);
    this.reason = options.reason;
    this.final = options.final ?? options.reason !== undefined;
  }
}

/** What a sandbox must allowlist: only the host the CLI dials. Pipes are opened elsewhere. */
function hosts(server: string) {
  return new URL(server).hostname;
}

/** A refused handshake: the relay's own `Refusal`, or a proxy saying no. */
export function explainRefusal(
  status: number,
  body: string,
  context: { server: string; viaProxy: boolean },
): FixError {
  const refusal = parseRefusal(body);
  if (refusal) return new FixError(refusal.fix, { reason: refusal.reason });
  if (context.viaProxy && [403, 407].includes(status)) {
    return new FixError(
      `The network proxy refused the connection (HTTP ${status}). Allowlist ${hosts(context.server)} in the sandbox's network settings.`,
    );
  }
  return new FixError(
    `${context.server} answered HTTP ${status}. Check WURMHOL_URL, or try again.`,
  );
}

/** A connection that failed before any HTTP answer. */
export function explainConnectError(
  error: Error & { code?: string },
  context: { server: string; proxy: string },
): FixError {
  const message = error.message ?? "";
  if (context.proxy && /\b(403|407)\b/.test(message)) {
    return new FixError(
      `The network proxy refused the connection. Allowlist ${hosts(context.server)} in the sandbox's network settings.`,
    );
  }
  if (/certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(`${error.code} ${message}`)) {
    return new FixError(
      "TLS verification failed. If the sandbox re-signs HTTPS, set NODE_EXTRA_CA_CERTS to its CA bundle.",
    );
  }
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return new FixError(
      context.proxy
        ? `Could not resolve the proxy. Check HTTPS_PROXY (${context.proxy}).`
        : `Could not resolve ${new URL(context.server).hostname}. In a sandbox without DNS, set HTTPS_PROXY.`,
    );
  }
  if (error.code === "ECONNREFUSED") {
    return new FixError(
      context.proxy
        ? `The proxy at ${context.proxy} refused the connection. Check HTTPS_PROXY.`
        : `Nothing answered at ${context.server}. Check WURMHOL_URL.`,
    );
  }
  return new FixError(`Could not reach ${context.server}: ${error.code ?? message}. Try again.`);
}
