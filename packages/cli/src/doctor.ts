// `wurmhol doctor`: checks what a pipe needs, one line per check, each `ok` or the fix. The token
// is checked on `GET /v1/pipes`, which every valid token is answered on without opening anything;
// the hosts through the same proxy the pipe dials; a port the way `wurmhol host` probes one.
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { parseRefusal } from "@wurmhol/protocol";
import { consoleUrl, findToken, pipeDomain, server } from "./config.ts";
import { type Answer, proxyFor, send } from "./dial.ts";
import { explainRefusal, FixError, isTlsError } from "./errors.ts";
import { get } from "./ports.ts";
import { listStates } from "./state.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * One line that says what to do; null when the check passed. A passing check with a fix is a
   * warning: something worth doing that a pipe does not need.
   */
  fix: string | null;
}

const pass = (name: string, detail: string): Check => ({ name, ok: true, detail, fix: null });
const warned = (name: string, detail: string, fix: string): Check => ({
  name,
  ok: true,
  detail,
  fix,
});
const failed = (name: string, detail: string, fix: string): Check => ({
  name,
  ok: false,
  detail,
  fix,
});

/** A proxy URL as safe to print: no credentials. */
function shown(proxy: string) {
  const url = new URL(proxy);
  return `${url.protocol}//${url.host}`;
}

/** An answer, or the FixError that says why none came. */
async function call(url: URL, options: Parameters<typeof send>[1]) {
  try {
    return await send(url, options);
  } catch (error) {
    if (error instanceof FixError) return error;
    throw error;
  }
}

/** The status a proxy refused the tunnel with, or null when it let the call through. */
const proxyRefusal = ({ proxyStatus }: Answer) =>
  proxyStatus !== undefined && proxyStatus !== 200 ? proxyStatus : null;

/** HTTPS_PROXY and NODE_EXTRA_CA_CERTS, and whether TLS to the server verified. */
function proxyCheck(origin: string, reached: Answer | FixError): Check {
  const { proxy } = proxyFor(new URL(origin));
  const host = new URL(origin).hostname;
  const parts = [proxy ? `through ${shown(proxy)}` : `no proxy for ${host}`];
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  if (ca) {
    let pem = "";
    try {
      pem = readFileSync(ca, "utf8");
    } catch {
      // Unreadable: reported below.
    }
    if (!pem.includes("BEGIN CERTIFICATE")) {
      return failed(
        "proxy",
        `NODE_EXTRA_CA_CERTS=${ca} holds no certificate`,
        "Set NODE_EXTRA_CA_CERTS to the sandbox's CA bundle (a PEM file), or unset it.",
      );
    }
    parts.push(`CA from ${ca}`);
  }
  if (reached instanceof FixError && reached.cause instanceof Error && isTlsError(reached.cause)) {
    return failed("proxy", `TLS to ${host} did not verify`, reached.message);
  }
  return pass("proxy", parts.join(", "));
}

/** Whether the server's own host answers, as the allowlist must let it. */
function apiCheck(origin: string, reached: Answer | FixError): Check {
  const host = new URL(origin).hostname;
  if (reached instanceof FixError) {
    return failed("api-host", `${host} unreachable`, reached.message);
  }
  const refused = proxyRefusal(reached);
  if (refused !== null) {
    return failed(
      "api-host",
      `the proxy refused ${host} (HTTP ${refused})`,
      explainRefusal(refused, "", { server: origin, viaProxy: true }).message,
    );
  }
  return pass("api-host", `${host} answers`);
}

/**
 * A pipe host to try: an open pipe's on this computer, or one under the default server's pipe
 * domain. Null for a self-hosted install with no open pipe here: nothing names its domain.
 */
function pipeOrigin(): { url: URL; domain: string } | null {
  const open = listStates()[0];
  if (open) {
    const url = new URL("/", open.url);
    return { url, domain: url.hostname.slice(url.hostname.indexOf(".") + 1) };
  }
  const domain = pipeDomain();
  return domain ? { url: new URL(`https://wurmhol-doctor.${domain}/`), domain } : null;
}

/**
 * Whether pipe URLs open from here. A warning, never a failure: the CLI dials only the API host
 * and people open pipes from their own devices (ADR 0006), so a sandbox that allows only the API
 * host shares fine; only opening its own pipe URLs, as an agent checking one does, needs this.
 */
async function pipeCheck(version: string): Promise<Check> {
  const target = pipeOrigin();
  if (!target) {
    return pass("pipe-domain", "unchecked: open a pipe first, so its URL names the pipe domain");
  }
  const wildcard = `*.${target.domain}`;
  const reached = await call(target.url, { server: target.url.origin, version });
  if (reached instanceof FixError) {
    return warned("pipe-domain", `${wildcard} unreachable`, reached.message);
  }
  const refused = proxyRefusal(reached);
  if (refused !== null) {
    return warned(
      "pipe-domain",
      `the proxy refused ${target.url.hostname} (HTTP ${refused})`,
      `Allowlist ${wildcard} in the sandbox's network settings, to open pipe URLs from the sandbox.`,
    );
  }
  return pass("pipe-domain", `${wildcard} answers`);
}

async function tokenCheck(
  origin: string,
  version: string,
  reached: Answer | FixError,
): Promise<Check> {
  const token = findToken();
  if (!token) {
    return failed(
      "token",
      "no token",
      `Run wurmhol login, or set WURMHOL_TOKEN to a token from ${consoleUrl()} (menu → Tokens).`,
    );
  }
  const { fix } = apiCheck(origin, reached);
  if (fix) return failed("token", `not checked: ${new URL(origin).hostname} is unreachable`, fix);
  const answer = await call(new URL("/v1/pipes", origin), {
    server: origin,
    version,
    headers: { authorization: `Bearer ${token}` },
  });
  if (answer instanceof FixError) return failed("token", "not checked", answer.message);
  if (answer.status === 200) return pass("token", "valid; it can list the org's pipes");
  // The route wants an org token; refusing a pipes-only one for scope means it is valid.
  if (answer.status === 403 && parseRefusal(answer.body)?.error === "token scope") {
    return pass("token", "valid; it can open pipes");
  }
  const refusal = explainRefusal(answer.status, answer.body, {
    server: origin,
    viaProxy: answer.viaProxy,
  });
  return failed("token", `refused (HTTP ${answer.status})`, refusal.message);
}

/** Whether ::1 is configured on any interface: without IPv6, nothing can listen there. */
function hasIpv6Loopback() {
  return Object.values(networkInterfaces()).some((addresses) =>
    addresses?.some((address) => address.address === "::1"),
  );
}

async function answers(port: number, host: string) {
  const res = await get(port, "/", host);
  res?.destroy();
  return res !== null;
}

async function portCheck(port: number): Promise<Check> {
  const ipv6 = hasIpv6Loopback();
  const [v4, v6] = await Promise.all([
    answers(port, "127.0.0.1"),
    ipv6 ? answers(port, "::1") : false,
  ]);
  const noIpv6 = ipv6 ? "" : " (this machine has no IPv6 loopback)";
  if (v4 && v6) return pass("port", `${port} answers HTTP on 127.0.0.1 and ::1`);
  if (v4) return pass("port", `${port} answers HTTP on 127.0.0.1, not on ::1${noIpv6}`);
  if (v6) return pass("port", `${port} answers HTTP on ::1, not on 127.0.0.1`);
  return failed(
    "port",
    `nothing answers HTTP on ${port}, on 127.0.0.1 or ::1${noIpv6}`,
    `Nothing answers HTTP on port ${port}${noIpv6}. Start the dev server, or check the port it prints.`,
  );
}

/** Every check, in order. */
export async function doctor(options: { port?: number; version: string }): Promise<Check[]> {
  const origin = server();
  const { version } = options;
  const reached = await call(new URL("/health", origin), { server: origin, version });
  const [token, pipes, port] = await Promise.all([
    tokenCheck(origin, version, reached),
    pipeCheck(version),
    options.port === undefined ? null : portCheck(options.port),
  ]);
  const checks = [token, proxyCheck(origin, reached), apiCheck(origin, reached), pipes];
  if (port) checks.push(port);
  return checks;
}

/** One line a check: `ok` and what passed, or `warn` or `fix` and what to do. */
export function formatCheck(check: Check) {
  if (!check.fix) return `ok   ${check.name}: ${check.detail}`;
  return `${check.ok ? "warn" : "fix "} ${check.name}: ${check.fix}`;
}
