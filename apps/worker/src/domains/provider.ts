// Cloudflare for SaaS custom hostnames (ADR 0033), behind an interface: nothing else in the Worker
// knows Cloudflare's shapes. Needs a token scoped to `SSL and Certificates: Edit` on the SaaS zone.
import type { HostnameSnapshot } from "@wurmhol/protocol";

/** A custom hostname as the provider holds it. */
export interface ProviderHostname extends HostnameSnapshot {
  id: string;
  /** Plain words about what is wrong, as the provider gave them. */
  errors: string[];
}

/** The provider refused or could not be reached. The message never holds the token. */
export class ProviderError extends Error {
  /** The provider's own code for the refusal, when it gave one. */
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** Cloudflare's code for a hostname that already exists in the zone. */
const DUPLICATE = 1406;

export interface HostnameProvider {
  /** Makes the custom hostname, validated by `CNAME` and certified by automatic HTTP validation. */
  create(hostname: string): Promise<ProviderHostname>;
  /** Null when the provider holds no such hostname. */
  get(id: string): Promise<ProviderHostname | null>;
  /** Asks it to look again now, instead of on its own schedule. Null when it holds no such hostname. */
  recheck(id: string, hostname: string): Promise<ProviderHostname | null>;
  /** Removes it and its certificate. A hostname already gone is fine. */
  delete(id: string): Promise<void>;
}

interface CloudflareEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
}

interface CloudflareHostname {
  id: string;
  status?: string;
  verification_errors?: string[];
  ssl?: { status?: string; validation_errors?: { message?: string }[] };
}

function hostnameStatus(status: string | undefined): HostnameSnapshot["status"] {
  switch (status) {
    case "active":
    case "active_redeploying":
      return "active";
    case "moved":
      return "moved";
    case "deleted":
    case "pending_deletion":
      return "deleted";
    case "blocked":
    case "pending_blocked":
    case "test_blocked":
      return "blocked";
    default:
      return "pending";
  }
}

function sslStatus(status: string | undefined): HostnameSnapshot["ssl"] {
  if (status === "active") return "active";
  if (status === "expired" || status?.endsWith("_timed_out")) return "failed";
  return "pending";
}

/** Cloudflare's custom hostname, as ours. */
export function fromCloudflare(raw: CloudflareHostname): ProviderHostname {
  return {
    id: raw.id,
    status: hostnameStatus(raw.status),
    ssl: sslStatus(raw.ssl?.status),
    errors: [
      ...(raw.verification_errors ?? []),
      ...(raw.ssl?.validation_errors ?? []).map((e) => e.message ?? ""),
    ].filter(Boolean),
  };
}

/** The body Cloudflare creates a hostname from: HTTP validation, so one `CNAME` is all it needs. */
function createBody(hostname: string) {
  return {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  };
}

export function cloudflareProvider(options: {
  apiUrl: string;
  zoneId: string;
  token: string;
}): HostnameProvider {
  const base = `${options.apiUrl}/zones/${options.zoneId}/custom_hostnames`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; result: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError("Cloudflare did not answer");
    }
    if (response.status === 404) return { status: 404, result: null };
    const envelope = (await response.json().catch(() => null)) as CloudflareEnvelope | null;
    if (!response.ok || !envelope?.success) {
      const first = envelope?.errors?.[0];
      throw new ProviderError(
        `Cloudflare refused: ${first?.message ?? `HTTP ${response.status}`}`,
        first?.code,
      );
    }
    return { status: response.status, result: envelope.result };
  }

  return {
    async create(hostname) {
      try {
        const { result } = await call("POST", "", createBody(hostname));
        return fromCloudflare(result as CloudflareHostname);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code !== DUPLICATE) throw error;
        // The zone is ours alone, so a hostname it already holds is one we lost track of: adopt it.
        const { result } = await call("GET", `?hostname=${encodeURIComponent(hostname)}`);
        const [found] = (result as CloudflareHostname[] | null) ?? [];
        if (!found) throw error;
        return fromCloudflare(found);
      }
    },
    async get(id) {
      const { status, result } = await call("GET", `/${id}`);
      return status === 404 ? null : fromCloudflare(result as CloudflareHostname);
    },
    async recheck(id, hostname) {
      // A PATCH with the creation settings makes Cloudflare validate again without changing them.
      const { status, result } = await call("PATCH", `/${id}`, createBody(hostname));
      return status === 404 ? null : fromCloudflare(result as CloudflareHostname);
    },
    async delete(id) {
      await call("DELETE", `/${id}`);
    },
  };
}
