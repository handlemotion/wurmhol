// Header rules both ends of the relay apply. Pure, so they are tested once here.
import type { HeaderList } from "./frame.ts";

/** The viewer's share cookie: set on the share host by the Worker, never seen by the dev server. */
export const SHARE_COOKIE = "__Host-wurmhol";

/**
 * Connection-level headers (RFC 9110 section 7.6.1) and ones the relay sets itself. They describe
 * one hop, so they never cross the tunnel.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/** Headers that may cross the tunnel, minus hop-by-hop ones and any `Connection` names. */
export function forwardable(headers: HeaderList): HeaderList {
  const named = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) named.add(token.trim().toLowerCase());
    }
  }
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !HOP_BY_HOP.has(lower) && !named.has(lower);
  });
}

/**
 * A `Cookie` header without the cookie called `name`, or null when nothing is left. Matches the
 * name exactly (RFC 6265 cookie-pairs), so `__Host-wurmhol-x` or `x__Host-wurmhol` survive.
 */
export function withoutCookie(cookieHeader: string, name: string): string | null {
  const kept = cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const eq = pair.indexOf("=");
      const key = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      return key !== name;
    });
  return kept.length ? kept.join("; ") : null;
}

/** The value of cookie `name` in a `Cookie` header, or null. The first one wins, as browsers send. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}
