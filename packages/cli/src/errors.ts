// Every failure the CLI reports says the fix in one line (spec section 7).

export class FixError extends Error {
  override name = "FixError";
  /** The relay says the share cannot continue: a reconnect would fail the same way. */
  readonly final: boolean;
  readonly reason: string | undefined;

  constructor(message: string, options: { final?: boolean; reason?: string } = {}) {
    super(message);
    this.final = options.final ?? false;
    this.reason = options.reason;
  }
}

function hosts(server: string) {
  const host = new URL(server).hostname;
  return `${host} and *.pipe.${host}`;
}

/** A refused handshake: the relay's own `{ error, fix }`, or a proxy saying no. */
export function explainRefusal(
  status: number,
  body: string,
  context: { server: string; viaProxy: boolean },
): FixError {
  type Refusal = { error?: string; fix?: string; reason?: string };
  let parsed: Refusal | null = null;
  try {
    parsed = JSON.parse(body) as Refusal;
  } catch {
    // Not ours: a proxy or a captive portal.
  }
  if (parsed?.fix) {
    // Token, plan and ended shares do not get better by retrying; a busy limit might.
    const final = [401, 402, 404, 410].includes(status);
    return new FixError(parsed.fix, { final, reason: parsed.reason ?? parsed.error });
  }
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
