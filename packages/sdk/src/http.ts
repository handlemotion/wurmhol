// Reaching the server from a sandbox: every call goes through HTTPS_PROXY when one is set (and
// trusts NODE_EXTRA_CA_CERTS, which the runtime reads itself), and every failure becomes a
// FixError that says the fix. Used by `dial.ts`, by the device flow, by the management client and
// by the CLI's doctor.
import { type OutgoingHttpHeaders, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
// @ts-expect-error proxy-from-env 2.x ships no types
import { getProxyForUrl as proxyForUrl } from "proxy-from-env";
import { isString } from "@wurmhol/protocol";
import { explainConnectError, FixError } from "./errors.ts";
import { runtime } from "./transport/index.ts";

/** The proxy URL for `url` from HTTPS_PROXY / HTTP_PROXY / NO_PROXY, or "" for none. */
const getProxyForUrl: (url: string) => string = proxyForUrl;

export function userAgent(version: string, product = "wurmhol") {
  const run = runtime();
  const { versions } = process;

  return `${product}/${version} ${run}/${run === "bun" ? (versions["bun"] ?? "") : versions.node}`;
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

/**
 * An answer's JSON body as `T`, the body the relay documents for the route that was called, or
 * null when the body is not JSON (a proxy's or portal's page). The relay is the server the caller
 * authenticated to, and each route's body is the SDK's contract with it: it is trusted as that
 * type, not decoded field by field.
 */
export function answerJson<T extends object>(answer: Answer): T | null {
  try {
    // SAFETY: callers name `T` after the route they called, which answers with that body.
    return JSON.parse(answer.body) as T;
  } catch {
    return null;
  }
}

/** `answerJson` for a success whose body the caller needs: throws the fix when it is not JSON. */
export function routeJson<T extends object>(answer: Answer, server: string): T {
  const body = answerJson<T>(answer);

  if (body === null) {
    throw new FixError(
      `${server} answered HTTP ${answer.status} with a page that is not Wurmhol's. Check WURMHOL_URL, or try again.`,
      { code: "network", status: answer.status },
    );
  }

  return body;
}

/** A value in a JSON request body. `undefined` fields are left out, as `JSON.stringify` does. */
export type JsonField = string | number | boolean | null | undefined | JsonField[] | RequestJson;

/** A request body the relay reads as JSON. */
export interface RequestJson {
  [field: string]: JsonField;
}

export interface SendOptions {
  /** The origin failures name. */
  server: string;
  version: string;
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: RequestJson;
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

  const headers: OutgoingHttpHeaders = {
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

  const headers = new Headers(options.headers);
  headers.set("user-agent", userAgent(options.version, options.product));

  const payload = options.json === undefined ? undefined : JSON.stringify(options.json);

  if (payload !== undefined) headers.set("content-type", "application/json");
  const timeout = AbortSignal.timeout(15_000);

  // Bun's `fetch` takes `proxy`; RequestInit does not name it.
  const init: RequestInit & { proxy?: string } = {
    method: options.method ?? "GET",
    headers,
    body: payload,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  };

  if (proxy) init.proxy = proxy;

  try {
    const response = await fetch(url, init);

    return {
      status: response.status,
      body: await response.text(),
      viaProxy: Boolean(proxy),
      proxyStatus: undefined,
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;

    const known = Object.assign(new Error(message), {
      code: errorCode(cause) ?? errorCode(error) ?? (timeout.aborted ? "ETIMEDOUT" : undefined),
    });

    const fix = explainConnectError(known, { server: options.server, proxy });
    fix.cause = error;
    throw fix;
  }
}

/** The `code` a runtime's error carries, like `ECONNREFUSED` or `ENOENT`. */
export function errorCode(cause: unknown): string | undefined {
  return cause instanceof Object && "code" in cause && isString(cause.code)
    ? cause.code
    : undefined;
}
