// Custom domains from your own code (ADR 0033): attach a hostname you own to a pipe name, so the
// pipe's URL is the brand's. `domains()` is the client, `Wurmhol#domains` the same calls with the
// client's token, and `wurmhol domain` the CLI over it. All need a token of scope `org`, and go
// through HTTPS_PROXY like the pipe.
//
//   const client = domains({ token: process.env.WURMHOL_TOKEN! });
//   const { dns } = await client.add({ hostname: "preview.acme.dev", pipe: "acme-app" });
//   // publish `dns` at the hostname's DNS host, then:
//   const domain = await client.waitActive("preview.acme.dev");
//   domain.url; // https://preview.acme.dev, the pipe's URL from now on
import type { Domain as ProtocolDomain } from "@wurmhol/protocol";
import pkg from "../package.json" with { type: "json" };
import { FixError } from "./errors.ts";
import { send } from "./http.ts";
import { DEFAULT_SERVER, originOf } from "./pipe.ts";

/**
 * Where a domain is. `pending`: waiting for the ownership `TXT` record. `verifying`: owned, waiting
 * for the `CNAME` and the certificate. Only `active` is served. `failed` says why in `error`.
 */
export type DomainState = "pending" | "verifying" | "active" | "failed";

/** A custom domain as the server returns it. Dates are ISO 8601. */
export interface Domain {
  /** Lowercase, no trailing dot. */
  hostname: string;
  /** The pipe name it serves. */
  pipe: string;
  state: DomainState;
  /** `https://<hostname>` once active. */
  url: string | null;
  /** What to publish at the hostname's DNS host, and whether each record was seen. */
  dns: {
    type: "TXT" | "CNAME";
    name: string;
    value: string;
    purpose: "ownership" | "traffic";
    done: boolean;
  }[];
  /** Why a `failed` domain failed, with the fix. */
  error: {
    code: "expired" | "certificate_refused" | "hostname_blocked";
    message: string;
    fix: string;
  } | null;
  createdAt: string;
  verifiedAt: string | null;
  expiresAt: string | null;
}

// The public type is written out (the protocol package is bundled in, not published); these two
// lines fail the build if it and the Worker's drift apart.
type Assert<T extends true> = T;
type _DomainMatchesProtocol = Assert<
  [Domain] extends [ProtocolDomain] ? ([ProtocolDomain] extends [Domain] ? true : false) : false
>;

/**
 * A domain call that did not succeed. `message` is the one-line fix. `domainCode` is the server's
 * reason (`hostname_taken`, `domain_limit`, `custom_domains_off`, `invalid_hostname`, or a failed
 * domain's `expired`, `certificate_refused`, `hostname_blocked`), or null when there is none.
 */
export class DomainError extends FixError {
  override name = "DomainError";
  readonly domainCode: string | null;

  constructor(
    message: string,
    options: { domainCode: string | null; status?: number; code?: "refused" | "error" },
  ) {
    super(message, { final: true, code: options.code ?? "refused", status: options.status });
    this.domainCode = options.domainCode;
  }
}

export interface DomainsOptions {
  /**
   * A token of scope `org` (`wh_…`): the console's menu → Tokens, "Can list and close every pipe".
   * A function is called before each request, so a client made before signing in works after.
   */
  token: string | (() => Promise<string>);
  /** A self-hosted install's origin. Default `https://api.wurmhol.com`. */
  server?: string;
  /** Names the app in the `User-Agent`: `{ name: "dorks", version: "1.2.0" }`. */
  client?: { name: string; version: string };
}

/** Every call takes a signal; aborting rejects with the signal's reason. */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface WaitOptions extends CallOptions {
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Time between looks. Default 10 seconds. */
  intervalMs?: number;
  /** Called after every look, so a caller can show what is still missing. */
  onUpdate?: (domain: Domain) => void;
}

export interface DomainsClient {
  list(options?: CallOptions): Promise<Domain[]>;
  /** Adds a hostname for a pipe name the org owns or claims. The same call again returns the same domain. */
  add(input: { hostname: string; pipe: string }, options?: CallOptions): Promise<Domain>;
  get(hostname: string, options?: CallOptions): Promise<Domain>;
  /** Checks it now. Never waits for DNS: it returns the state as found. */
  verify(hostname: string, options?: CallOptions): Promise<Domain>;
  /** Removes it. A hostname already gone is fine. */
  remove(hostname: string, options?: CallOptions): Promise<void>;
  /**
   * Verifies until the domain is `active`. Rejects with the fix when it fails or the time runs
   * out, and with the abort's reason when `signal` aborts, before or during a look.
   */
  waitActive(hostname: string, options?: WaitOptions): Promise<Domain>;
}

interface Body {
  error?: string;
  fix?: string;
  code?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** The domains client for one token. */
export function domains(options: DomainsOptions): DomainsClient {
  const server = originOf(options.server ?? DEFAULT_SERVER);
  const client = options.client ?? { name: "wurmhol-sdk", version: pkg.version };
  const token = options.token;

  async function call<T>(
    method: string,
    path: string,
    json: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    signal?.throwIfAborted();
    const bearer = typeof token === "function" ? await token() : token;
    const answer = await send(new URL(`/v1/domains${path}`, server), {
      server,
      version: client.version,
      product: client.name,
      method,
      json,
      headers: { authorization: `Bearer ${bearer}` },
      signal,
    });
    let body: Body & Record<string, unknown> = {};
    try {
      body = JSON.parse(answer.body) as typeof body;
    } catch {
      // A proxy's or portal's page: handled below.
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new DomainError(
        body.fix ??
          `${server} answered HTTP ${answer.status}. Check WURMHOL_URL and the token, or try again.`,
        { domainCode: body.code ?? null, status: answer.status },
      );
    }
    return body as T;
  }

  const path = (hostname: string, rest = "") => `/${encodeURIComponent(hostname)}${rest}`;

  const domainsClient: DomainsClient = {
    async list(opts = {}) {
      return (await call<{ domains: Domain[] }>("GET", "", undefined, opts.signal)).domains;
    },
    async add(input, opts = {}) {
      return (await call<{ domain: Domain }>("POST", "", input, opts.signal)).domain;
    },
    async get(hostname, opts = {}) {
      return (await call<{ domain: Domain }>("GET", path(hostname), undefined, opts.signal)).domain;
    },
    async verify(hostname, opts = {}) {
      const answer = await call<{ domain: Domain }>(
        "POST",
        path(hostname, "/verify"),
        undefined,
        opts.signal,
      );
      return answer.domain;
    },
    async remove(hostname, opts = {}) {
      await call("DELETE", path(hostname), undefined, opts.signal);
    },
    async waitActive(hostname, wait = {}) {
      const deadline = Date.now() + (wait.timeoutMs ?? 10 * 60_000);
      const interval = wait.intervalMs ?? 10_000;
      for (;;) {
        const domain = await domainsClient.verify(hostname, { signal: wait.signal });
        // A look that finished as the signal aborted still counts as aborted.
        wait.signal?.throwIfAborted();
        wait.onUpdate?.(domain);
        if (domain.state === "active") return domain;
        if (domain.state === "failed") {
          throw new DomainError(
            domain.error?.fix ?? `${hostname} failed. Remove it and add it again.`,
            { domainCode: domain.error?.code ?? null, status: 200 },
          );
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          const missing = domain.dns.filter((record) => !record.done);
          throw new DomainError(
            `${hostname} is still ${domain.state}. ${
              missing.length
                ? `Publish ${missing.map((r) => `${r.type} ${r.name}`).join(" and ")}, then run wurmhol domain verify ${hostname} --wait.`
                : `Run wurmhol domain verify ${hostname} --wait later.`
            }`,
            { domainCode: null, code: "error" },
          );
        }
        // The last wait is cut short so the final look happens at the deadline, not after it.
        await sleep(Math.min(interval, left), wait.signal);
      }
    },
  };
  return domainsClient;
}
