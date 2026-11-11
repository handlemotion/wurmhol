// A browser's grant cookie on an embedded tunnel's host (ADR 0032): which tunnel, which grant,
// until when, signed with HMAC-SHA256 under a key derived from BETTER_AUTH_SECRET apart from
// both Better Auth's and the member share cookie's, so neither kind verifies as another. It is
// the same `__Host-wurmhol` cookie name, so the relay strips it before the dev server as it does
// a member's. It proves a grant was issued; the Share object checks the grant is still live.
import { SHARE_COOKIE } from "@wurmhol/protocol";

/** A grant lives at most 24 hours; so does its cookie. */
const MAX_TTL_SECONDS = 24 * 3600;

const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string) {
  let found = keys.get(secret);
  if (!found) {
    found = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(`wurmhol-grant-cookie:${secret}`))
      .then((raw) =>
        crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
          "sign",
          "verify",
        ]),
      );
    keys.set(secret, found);
  }
  return found;
}

function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Ids are UUIDs: no dots, so the value splits back into its parts. */
const ID = /^[0-9a-f-]{36}$/;

/** `e.<tunnelId>.<grantId>.<expiresAtSeconds>.<signature>` */
export async function signGrantCookie(
  secret: string,
  value: { tunnelId: string; grantId: string; expiresAt: number },
) {
  const payload = `e.${value.tunnelId}.${value.grantId}.${value.expiresAt}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64url(signature)}`;
}

/** The tunnel and grant a cookie names, if it is well signed and unexpired; else null. */
export async function verifyGrantCookie(
  secret: string,
  cookie: string | null,
): Promise<{ tunnelId: string; grantId: string } | null> {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 5) return null;
  const [kind, tunnelId, grantId, expires, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (kind !== "e" || !ID.test(tunnelId) || !ID.test(grantId) || !/^\d+$/.test(expires)) {
    return null;
  }
  if (Number(expires) * 1000 <= Date.now()) return null;
  const bytes = fromBase64url(signature);
  if (!bytes) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    new TextEncoder().encode(`e.${tunnelId}.${grantId}.${expires}`),
  );
  return ok ? { tunnelId, grantId } : null;
}

/** The `Set-Cookie` value for a grant cookie that lasts until `expiresAt` (seconds). */
export function grantCookieHeader(value: string, expiresAt: number) {
  const maxAge = Math.max(0, Math.min(MAX_TTL_SECONDS, expiresAt - Math.floor(Date.now() / 1000)));
  return `${SHARE_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
