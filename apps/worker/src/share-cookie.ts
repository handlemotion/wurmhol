// The viewer's `__Host-wurmhol` cookie on a share host (spec section 6): which user it is, for
// which share, until when, signed with HMAC-SHA256 under a key derived from BETTER_AUTH_SECRET.
// It proves sign-in and membership when it was issued; the Share DO re-checks membership.
import { SHARE_COOKIE } from "@wurmhol/protocol";

/** 12 hours, the longest a share lives. */
export const SHARE_COOKIE_TTL_SECONDS = 12 * 3600;

const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string) {
  let found = keys.get(secret);

  if (!found) {
    // A separate key from Better Auth's own, so a value signed here is never valid there.
    found = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(`wurmhol-share-cookie:${secret}`))
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

/** `<shareId>.<userId>.<expiresAtSeconds>.<signature>` */
export async function signShareCookie(
  secret: string,
  value: { shareId: string; userId: string; expiresAt: number },
) {
  const payload = `${value.shareId}.${value.userId}.${value.expiresAt}`;

  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(payload),
  );

  return `${payload}.${base64url(signature)}`;
}

/** The user a cookie names, if it is well signed, for this share, and unexpired. */
export async function verifyShareCookie(
  secret: string,
  cookie: string | null,
  shareId: string,
): Promise<string | null> {
  if (!cookie) return null;
  const parts = cookie.split(".");

  if (parts.length !== 4) return null;
  // SAFETY: the length check above leaves exactly four parts.
  const [cookieShare, userId, expires, signature] = parts as [string, string, string, string];

  if (cookieShare !== shareId || !/^\d+$/.test(expires)) return null;

  if (Number(expires) * 1000 <= Date.now()) return null;
  const bytes = fromBase64url(signature);

  if (!bytes) return null;

  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    new TextEncoder().encode(`${cookieShare}.${userId}.${expires}`),
  );

  return ok ? userId : null;
}

/** The `Set-Cookie` value for a fresh share cookie. */
export function shareCookieHeader(value: string) {
  // `__Host-` needs Secure, Path=/ and no Domain; browsers accept Secure on http://*.localhost.
  return `${SHARE_COOKIE}=${value}; Path=/; Max-Age=${SHARE_COOKIE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** The `Set-Cookie` value that clears the share cookie. */
export function clearShareCookieHeader() {
  return `${SHARE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
