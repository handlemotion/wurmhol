// Random secrets and their hashes, on Web Crypto (Workers and Node alike).
import { SHARE_ID_ALPHABET, SHARE_ID_LENGTH } from "@wurmhol/protocol";

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `bytes` random bytes as unpadded base64url. */
export function randomSecret(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * A new share id: `SHARE_ID_LENGTH` characters of `SHARE_ID_ALPHABET`. Rejection sampling keeps
 * every character equally likely, so ids are as hard to guess as their length says.
 */
export function randomShareId(): string {
  const size = SHARE_ID_ALPHABET.length;
  const below = 256 - (256 % size);
  let id = "";
  while (id.length < SHARE_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SHARE_ID_LENGTH * 2))) {
      if (byte < below && id.length < SHARE_ID_LENGTH) id += SHARE_ID_ALPHABET[byte % size];
    }
  }
  return id;
}
