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

/**
 * On the CLI's own "Waiting for the server on port N" page, sent while nothing listens on the
 * port. The page is not the app's, so the relay reads no title from it and probes again later.
 */
export const WAITING_HEADER = "x-wurmhol-waiting";

/** Headers that carry the viewer's IP address. No dev server needs it. */
const CLIENT_IP = new Set(["x-forwarded-for", "x-real-ip", "true-client-ip"]);

/**
 * A viewer's request headers as the dev server gets them. Cloudflare's (`cf-*`) and Wurmhol's
 * own (`x-wurmhol-*`) headers, the viewer's IP and the share cookie stay with the relay.
 * `Accept-Encoding` does too: bodies cross the tunnel uncompressed, so the relay can read a page's
 * title, and Cloudflare compresses toward the viewer. The share's public host and scheme are added.
 */
export function viewerRequestHeaders(
  headers: Iterable<[string, string]>,
  shareUrl: string,
): HeaderList {
  const list: HeaderList = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("cf-") ||
      lower.startsWith("x-wurmhol-") ||
      CLIENT_IP.has(lower) ||
      lower === "accept-encoding"
    ) {
      continue;
    }
    if (lower === "cookie") {
      const kept = withoutCookie(value, SHARE_COOKIE);
      if (kept) list.push([name, kept]);
      continue;
    }
    list.push([name, value]);
  }
  return [...list, ...forwardedHeaders(shareUrl)];
}

/** The share's public host and scheme, as a proxy in front of the dev server would pass them. */
export function forwardedHeaders(shareUrl: string): HeaderList {
  const url = new URL(shareUrl);
  return [
    ["x-forwarded-host", url.host],
    ["x-forwarded-proto", url.protocol.replace(":", "")],
  ];
}

/**
 * Request headers as the CLI sends them to the dev server: forwardable ones, and
 * `Host: localhost:<port>`, which Vite and most frameworks accept without config (spec section 7).
 */
export function localRequestHeaders(headers: HeaderList, port: number): HeaderList {
  return [...forwardable(headers), ["host", `localhost:${port}`]];
}

/**
 * A browser WebSocket's handshake headers as the CLI sends them to the dev server: as for a
 * request, without the browser's `Sec-WebSocket-*`, which the CLI's own handshake sets.
 */
export function localSocketHeaders(headers: HeaderList, port: number): HeaderList {
  return localRequestHeaders(
    headers.filter(([name]) => !/^sec-websocket-/i.test(name)),
    port,
  );
}

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

/**
 * A dev server's `Set-Cookie`, as the relay hands it to the viewer: host-only, and never the
 * share cookie. Its `Domain` attribute is dropped, so a pipe sets cookies for its own host only,
 * not for the pipe domain and so for every other pipe on it. A cookie named like the share
 * cookie is dropped whole (null): the dev server must not set or clear the viewer's sign-in.
 */
export function pipeSetCookie(setCookie: string): string | null {
  const [pair = "", ...attributes] = setCookie.split(";");
  const eq = pair.indexOf("=");
  const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
  if (name.toLowerCase() === SHARE_COOKIE.toLowerCase()) return null;
  const kept = attributes.filter((attribute) => {
    const key = attribute.split("=", 1)[0]!.trim().toLowerCase();
    return key !== "domain";
  });
  return [pair, ...kept].join(";");
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
