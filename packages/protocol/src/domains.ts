// Custom domains (ADR 0030): a hostname an org owns, attached to one of its pipe names. The CLI,
// the SDK and the Worker check hostnames with this, so a hostname one accepts is one the others
// route.

/** One DNS label as the web serves it: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `value` as a custom hostname: lowercase, without a trailing dot, or null when it cannot be one. */
export function customHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253) return null;
  const labels = host.split(".");
  // At least two labels: `localhost` and bare TLDs are not a hostname an org can own.
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // An all-numeric last label is an IP address (or a typo for one), never a registrable name.
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  // Underscore and wildcard forms are not served; wildcards are a different feature (ADR 0030).
  return host;
}

/** The one line that says what a custom hostname may be. */
export const CUSTOM_HOSTNAME_RULE =
  "a full domain name like preview.example.com, without a scheme, path or wildcard";

/** The states a domain moves through (ADR 0030). Only `active` is routed. */
export const DOMAIN_STATES = ["pending", "verifying", "active", "failed"] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];

/** One DNS record an org publishes for a domain. */
export interface DomainRecord {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  purpose: "ownership" | "traffic";
  /** Whether the Worker has seen it. */
  done: boolean;
}

/** Why a domain is `failed` (ADR 0030). */
export const DOMAIN_ERROR_CODES = ["expired", "certificate_refused", "hostname_blocked"] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** Why a domain is `failed`, in words a person can act on. */
export interface DomainError {
  code: DomainErrorCode;
  message: string;
  fix: string;
}

/** A custom domain as `/v1/domains` returns it (ADR 0030). Dates are ISO 8601. */
export interface Domain {
  hostname: string;
  pipe: string;
  state: DomainState;
  /** `https://<hostname>` once active. */
  url: string | null;
  dns: DomainRecord[];
  error: DomainError | null;
  createdAt: string;
  verifiedAt: string | null;
  expiresAt: string | null;
}

/** Where the ownership TXT record goes: `_wurmhol.<hostname>`. */
export function ownershipRecordName(hostname: string) {
  return `_wurmhol.${hostname}`;
}

/** The ownership TXT record's value for a domain's challenge. */
export function ownershipRecordValue(challenge: string) {
  return `wurmhol-verify=${challenge}`;
}

/** What Cloudflare reports about a custom hostname and its certificate (ADR 0030). */
export interface HostnameSnapshot {
  /** The hostname's own status: `moved` is a `CNAME` that no longer points at the target. */
  status: "pending" | "active" | "moved" | "deleted" | "blocked";
  /** The certificate's status. */
  ssl: "pending" | "active" | "failed";
}

/** What a domain's state follows from (ADR 0030). */
export interface DomainFacts {
  /** The TXT record was seen now or at any earlier check: ownership, once proven, stays proven. */
  ownership: boolean;
  /** Cloudflare's report, or null when it holds no such hostname. */
  hostname: HostnameSnapshot | null;
  /** The domain's expiry has passed. It only counts while the domain is not routed. */
  expired: boolean;
}

/**
 * Where a domain stands. Only `active` is routed, and only with both proofs: our TXT record and
 * Cloudflare's active hostname and certificate. A `CNAME` left behind without the TXT record never
 * gets past `pending`, which is what stops a takeover of a name its owner abandoned (ADR 0030).
 * `recreate` asks for the Cloudflare hostname to be made again: it was never made or is gone.
 */
export function nextDomainState(facts: DomainFacts): {
  state: DomainState;
  error: DomainErrorCode | null;
  recreate: boolean;
} {
  const { ownership, hostname, expired } = facts;
  const wait = (state: DomainState, recreate = false) => ({
    state: expired ? ("failed" as const) : state,
    error: expired ? ("expired" as const) : null,
    recreate,
  });
  if (!ownership) return wait("pending", hostname === null);
  if (hostname === null || hostname.status === "deleted") return wait("verifying", true);
  if (hostname.status === "blocked") {
    return { state: "failed", error: "hostname_blocked", recreate: false };
  }
  if (hostname.ssl === "failed") {
    return { state: "failed", error: "certificate_refused", recreate: false };
  }
  if (hostname.status === "active" && hostname.ssl === "active") {
    return { state: "active", error: null, recreate: false };
  }
  return wait("verifying");
}
