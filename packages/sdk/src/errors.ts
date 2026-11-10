// Every failure the CLI reports says the fix in one line (spec section 7).
import { parseRefusal } from "@wurmhol/protocol";
import type { CloseReason } from "./pipe.ts";

/**
 * What kind of failure a `FixError` is, for code that decides what to do (the message is for
 * people). `refused`: the relay said no (see `reason`); `invalid_option`: the caller's options;
 * `no_token`: none was given; `network`, `dns`, `unreachable`, `tls`, `proxy`: no answer came;
 * `auth`: a device flow ended without a token; `error`: anything else.
 */
export type ErrorCode =
  | "refused"
  | "invalid_option"
  | "no_token"
  | "network"
  | "dns"
  | "unreachable"
  | "tls"
  | "proxy"
  | "auth"
  | "unsupported"
  | "error";

export class FixError extends Error {
  override name = "FixError";
  /** Retrying cannot help: a reconnect would fail the same way. */
  readonly final: boolean;
  /** Why the relay says the share is over, on a refusal that ends it. */
  readonly reason: CloseReason | undefined;
  readonly code: ErrorCode;
  /** The relay's HTTP status, on a refusal. */
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { final?: boolean; reason?: CloseReason; code?: ErrorCode; status?: number } = {},
  ) {
    super(message);
    this.reason = options.reason;
    this.final = options.final ?? options.reason !== undefined;
    this.code = options.code ?? (options.reason !== undefined ? "refused" : "error");
    this.status = options.status;
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
  if (refusal)
    return new FixError(refusal.fix, { reason: refusal.reason, code: "refused", status });
  if (context.viaProxy && [403, 407].includes(status)) {
    return new FixError(
      `The network proxy refused the connection (HTTP ${status}). Allowlist ${hosts(context.server)} in the sandbox's network settings.`,
      { code: "proxy", status },
    );
  }
  return new FixError(
    `${context.server} answered HTTP ${status}. Check WURMHOL_URL, or try again.`,
    { code: "network", status },
  );
}

const TLS_FIX =
  "TLS verification failed. If the sandbox re-signs HTTPS, set NODE_EXTRA_CA_CERTS to its CA bundle.";

/** Whether a connection failed because the server's certificate was not trusted. */
export function isTlsError(error: Error & { code?: string }) {
  return /certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(
    `${error.code} ${error.message ?? ""}`,
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
      { code: "proxy" },
    );
  }
  if (isTlsError(error)) return new FixError(TLS_FIX, { code: "tls" });
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return new FixError(
      context.proxy
        ? `Could not resolve the proxy. Check HTTPS_PROXY (${context.proxy}).`
        : `Could not resolve ${new URL(context.server).hostname}. In a sandbox without DNS, set HTTPS_PROXY.`,
      { code: "dns" },
    );
  }
  if (error.code === "ECONNREFUSED") {
    return new FixError(
      context.proxy
        ? `The proxy at ${context.proxy} refused the connection. Check HTTPS_PROXY.`
        : `Nothing answered at ${context.server}. Check WURMHOL_URL.`,
      { code: "unreachable" },
    );
  }
  return new FixError(`Could not reach ${context.server}: ${error.code ?? message}. Try again.`, {
    code: "network",
  });
}
