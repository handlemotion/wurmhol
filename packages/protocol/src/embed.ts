// Embedded mode (ADR 0032): the credentials, permissions, headers and close codes a SaaS's
// backend, its users' agents and clients, and the relay agree on. Pure: generating and hashing
// credentials is `@wurmhol/db`'s.

import { isFiniteNumber, isString, type JsonValue } from "./json.ts";

/**
 * Each embedded credential's prefix, so scanners, logs and routes tell them apart. None starts
 * with a classic token's `wh_`, so no embedded credential is ever looked up as a share token.
 */
export const EMBED_CREDENTIAL_PREFIXES = {
  /** The SaaS backend's integration key. Server only. */
  key: "whk_",
  /** One agent's credential for one tunnel's `/connect`. */
  connector: "whc_",
  /** One subject's traffic grant for one tunnel. */
  grant: "whg_",
} as const;

export type EmbedCredentialKind = keyof typeof EMBED_CREDENTIAL_PREFIXES;

// SAFETY: EMBED_CREDENTIAL_PREFIXES is a const literal, so its own keys are exactly the kinds.
const EMBED_CREDENTIAL_KINDS = Object.keys(EMBED_CREDENTIAL_PREFIXES) as EmbedCredentialKind[];

/** A credential's random part: 32 bytes as unpadded base64url. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Which embedded credential `value` is shaped as, or null when it is none of them. */
export function embedCredentialKind(value: JsonValue | undefined): EmbedCredentialKind | null {
  if (!isString(value)) return null;

  for (const kind of EMBED_CREDENTIAL_KINDS) {
    const prefix = EMBED_CREDENTIAL_PREFIXES[kind];

    if (value.startsWith(prefix) && SECRET.test(value.slice(prefix.length))) return kind;
  }

  return null;
}

/** What an integration key may do. Lifecycle and traffic are separate permissions. */
export const EMBED_PERMISSIONS = [
  "tunnels:read",
  "tunnels:manage",
  "subjects:manage",
  "grants:issue",
] as const;

export type EmbedPermission = (typeof EMBED_PERMISSIONS)[number];

/** `values` as a key's permissions, deduplicated in canonical order; null if any is unknown or none. */
export function embedPermissions(values: readonly JsonValue[]): EmbedPermission[] | null {
  if (!values.length) return null;
  const known = new Set<string>(EMBED_PERMISSIONS);

  if (!values.every((value) => isString(value) && known.has(value))) return null;

  return EMBED_PERMISSIONS.filter((permission) => values.includes(permission));
}

/** A subject is an end user or a service of a tenant. */
export const SUBJECT_KINDS = ["user", "service"] as const;

export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** A `client` grant is a token for a program; a `browser` grant is a launch URL. */
export const GRANT_KINDS = ["client", "browser"] as const;

export type GrantKind = (typeof GRANT_KINDS)[number];

/** The header a program sends its grant in. Every `x-wurmhol-*` header stays with the relay. */
export const GRANT_HEADER = "x-wurmhol-grant";

/** Lifetimes, in seconds. */
export const GRANT_TTL = { default: 3600, max: 24 * 3600 } as const;
export const CONNECTOR_TTL = { default: 30 * 86_400, max: 365 * 86_400 } as const;
export const LAUNCH_CODE_TTL_SECONDS = 60;

/**
 * A requested lifetime in seconds, or the default when none was asked for; null when it is not a
 * whole number from 60 seconds up to `limits.max`.
 */
export function embedTtlSeconds(
  requested: JsonValue | undefined,
  limits: { default: number; max: number },
): number | null {
  if (requested === undefined || requested === null) return limits.default;

  if (!isFiniteNumber(requested) || !Number.isSafeInteger(requested)) return null;

  return requested >= 60 && requested <= limits.max ? requested : null;
}

/** How the relay closes a viewer's WebSocket whose grant stopped. */
export const GRANT_CLOSE = {
  /** Issue a new grant and reconnect. */
  expired: { code: 4401, reason: "grant expired" },
  /** Final: the grant was revoked. */
  revoked: { code: 4403, reason: "grant revoked" },
} as const;

/**
 * The subprotocol a browser's WebSocket offers beside `wurmhol.grant.<token>`, and the one the
 * relay answers with when the dev server picks none: browsers fail a handshake that offered
 * protocols and got none back.
 */
export const GRANT_PROTOCOL = "wurmhol.grant";

/** The subprotocol list a browser opens a tunnel's WebSocket with: the grant, then its own. */
export function grantProtocols(token: string, own: readonly string[] = []): string[] {
  return [GRANT_PROTOCOL, `${GRANT_PROTOCOL}.${token}`, ...own];
}

/** A `Sec-WebSocket-Protocol` header's grant and the protocols left for the dev server. */
export interface GrantProtocols {
  grant: string | null;
  own: string[];
}

/**
 * A `Sec-WebSocket-Protocol` request header split into the grant it carries and the protocols
 * that are the app's. Every `wurmhol.grant` entry is removed from `own`, so the dev server never
 * sees one, nor any entry starting `wurmhol.grant` in any case: the prefix is the relay's.
 * `grant` is set only when both the marker and exactly one well-formed grant came.
 */
export function splitGrantProtocols(header: string | null | undefined): GrantProtocols {
  const entries = (header ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const own: string[] = [];
  const grants: string[] = [];
  let marker = false;

  for (const entry of entries) {
    if (entry === GRANT_PROTOCOL) marker = true;
    else if (entry.startsWith(`${GRANT_PROTOCOL}.`))
      grants.push(entry.slice(GRANT_PROTOCOL.length + 1));
    else if (!entry.toLowerCase().startsWith(GRANT_PROTOCOL)) own.push(entry);
  }

  const [only] = grants;

  const grant =
    marker && grants.length === 1 && only && embedCredentialKind(only) === "grant" ? only : null;

  return { grant, own };
}

/** The subprotocol the relay answers a grant-carrying handshake with. */
export function grantProtocolAnswer(chosen: string | null | undefined): string {
  return chosen || GRANT_PROTOCOL;
}

/**
 * An embedded tunnel's host label: `e` and 15 lowercase letters and digits. It is a valid pipe
 * name, so routing and reopening at the same host work as for a named pipe, and never the shape
 * of a random pipe id.
 */
export const EMBED_TUNNEL_NAME = /^e[a-z0-9]{15}$/;
export const EMBED_TUNNEL_NAME_LENGTH = 16;

export function isEmbedTunnelName(value: string): boolean {
  return EMBED_TUNNEL_NAME.test(value);
}
