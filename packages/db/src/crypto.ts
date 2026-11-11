// Random secrets and their hashes, on Web Crypto (Workers and Node alike).
import {
  EMBED_CREDENTIAL_PREFIXES,
  EMBED_TUNNEL_NAME_LENGTH,
  type EmbedCredentialKind,
  SHARE_ID_ALPHABET,
  SHARE_ID_LENGTH,
} from "@wurmhol/protocol";

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

/** `length` characters of `SHARE_ID_ALPHABET`, each equally likely (rejection sampling). */
function randomLabel(length: number): string {
  const size = SHARE_ID_ALPHABET.length;
  const below = 256 - (256 % size);
  let label = "";
  while (label.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < below && label.length < length) label += SHARE_ID_ALPHABET[byte % size];
    }
  }
  return label;
}

/** A new share id: `SHARE_ID_LENGTH` characters of `SHARE_ID_ALPHABET`. */
export function randomShareId(): string {
  return randomLabel(SHARE_ID_LENGTH);
}

/** A new embedded tunnel's host label (ADR 0032): `e` and 15 random characters. */
export function randomEmbedTunnelName(): string {
  return `e${randomLabel(EMBED_TUNNEL_NAME_LENGTH - 1)}`;
}

/** A new embedded credential of `kind` and its hash; only the hash is ever stored. */
export async function newEmbedCredential(kind: EmbedCredentialKind) {
  const value = `${EMBED_CREDENTIAL_PREFIXES[kind]}${randomSecret(32)}`;
  return { value, hash: await sha256Hex(value) };
}
