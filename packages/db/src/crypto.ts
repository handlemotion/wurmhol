// Random secrets and their hashes, on Web Crypto (Workers and Node alike).

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

// Lowercase letters and digits: a share id is a DNS label, and hostnames are case-insensitive.
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A share id: 10 characters from 36 (about 51 bits). Rejection sampling keeps every character
 * equally likely, so ids are as hard to guess as their length says.
 */
export function randomShareId(length = 10): string {
  let id = "";
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 252 && id.length < length) id += ID_ALPHABET[byte % 36];
    }
  }
  return id;
}
