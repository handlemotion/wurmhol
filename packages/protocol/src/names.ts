// A pipe's name (ADR 0009): `wurmhol 3000 --name myapp` opens `myapp.<pipe domain>`, the same
// host every time, so it can be registered as an OAuth redirect URI. Both the CLI and the
// Worker check names with this, so a name the CLI accepts is one the Worker routes.

/**
 * One DNS label: 3 to 40 lowercase letters, digits and hyphens, starting with a letter and
 * ending with a letter or digit. No `--`, which browsers read as an internationalized name
 * (`xn--`). Never 10 letters and digits alone: that is the shape of a random pipe id.
 */
const NAME = /^[a-z](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/** A share id's characters: lowercase, because an id is a DNS label and hosts ignore case. */
export const SHARE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const SHARE_ID_LENGTH = 10;
/** A random pipe id: `SHARE_ID_LENGTH` lowercase letters and digits. */
export const SHARE_ID = new RegExp(`^[a-z0-9]{${SHARE_ID_LENGTH}}$`);

/** `value` as a pipe name, lowercased, or null when it cannot be one. */
export function pipeName(value: string): string | null {
  const name = value.trim().toLowerCase();
  if (!NAME.test(name) || name.includes("--") || SHARE_ID.test(name)) return null;
  return name;
}

/** The one line that says what a pipe name may be. */
export const PIPE_NAME_RULE =
  "3 to 40 lowercase letters, digits and hyphens, starting with a letter, like my-app";
