// Reaching the server from a sandbox: every call goes through HTTPS_PROXY when one is set (and
// trusts NODE_EXTRA_CA_CERTS, which the runtime reads itself), and every failure becomes a
// FixError that says the fix. Used by `dial.ts`, by the device flow, by the management client and
// by the CLI's doctor.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
// @ts-expect-error proxy-from-env 2.x ships no types
import { getProxyForUrl as proxyForUrl } from "proxy-from-env";
import { explainConnectError } from "./errors.ts";
import { runtime } from "./transport/index.ts";

/** The proxy URL for `url` from HTTPS_PROXY / HTTP_PROXY / NO_PROXY, or "" for none. */
const getProxyForUrl: (url: string) => string = proxyForUrl;

export function userAgent(version: string, product = "wurmhol") {
  const run = runtime();
  const versions = process.versions as Record<string, string | undefined>;
  return `${product}/${version} ${run}/${run === "bun" ? (versions["bun"] ?? "") : process.versions.node}`;
}

/** The proxy HTTPS_PROXY names for an http(s) URL (empty when none), and an agent through it. */
export function proxyFor(url: URL) {
  const proxy = getProxyForUrl(url.toString());
  return { proxy, agent: proxy ? new HttpsProxyAgent(proxy) : undefined };
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
  /** Aborts the call; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Overrides the User-Agent product name (an app embedding the SDK names itself). */
  product?: string;
}

/**
 * One HTTP call through the environment's proxy. Rejects with a FixError, whose `cause` is the
 * connection's own error, when no HTTP answer came.
 */
export function send(url: URL, options: SendOptions): Promise<Answer> {
  return runtime() === "node" ? sendNode(url, options) : sendFetch(url, options);
}

function sendNode(url: URL, options: SendOptions): Promise<Answer> {
  const { proxy, agent } = proxyFor(url);
  const request = url.protocol === "http:" ? httpRequest : httpsRequest;
  const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
  const headers: Record<string, string | number> = {
    ...options.headers,
    "user-agent": userAgent(options.version, options.product),
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    let proxyStatus: number | undefined;
    const req = request(
      url,
      { method: options.method ?? "GET", headers, agent, timeout: 15_000, signal: options.signal },
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
    req.on("error", (error: Error & { name?: string }) => {
      if (options.signal?.aborted) return reject(options.signal.reason);
      const fix = explainConnectError(error, { server: options.server, proxy });
      fix.cause = error;
      reject(fix);
    });
    req.end(payload);
  });
}

/**
 * The same call with `fetch`, for runtimes whose `node:http` has no proxy agent support. Bun's
 * `fetch` takes a `proxy` option; there is no proxy status for it to report.
 */
async function sendFetch(url: URL, options: SendOptions): Promise<Answer> {
  const { proxy } = proxyFor(url);
  const headers: Record<string, string> = {
    ...options.headers,
    "user-agent": userAgent(options.version, options.product),
  };
  const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
  if (payload !== undefined) headers["content-type"] = "application/json";
  const timeout = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: payload,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      ...(proxy ? { proxy } : {}),
    } as RequestInit);
    return {
      status: response.status,
      body: await response.text(),
      viaProxy: Boolean(proxy),
      proxyStatus: undefined,
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const cause = (error as { cause?: { code?: string } }).cause;
    const known = Object.assign(new Error((error as Error).message), {
      code:
        cause?.code ??
        (error as { code?: string }).code ??
        (timeout.aborted ? "ETIMEDOUT" : undefined),
    });
    const fix = explainConnectError(known, { server: options.server, proxy });
    fix.cause = error;
    throw fix;
  }
}
