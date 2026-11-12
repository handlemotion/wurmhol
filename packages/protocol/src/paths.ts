// Where a redirect may send someone after sign-in: a path on the same site, never another one.

const BASE = "https://same-origin.invalid";

/**
 * `value` as a path, query and fragment on the current origin, or "/" when it would leave it.
 * Resolved the way a browser resolves it, so input that only looks like a path cannot escape:
 * browsers drop tabs and newlines and read `\` as `/`, which turns `/\t/evil.example` into
 * `//evil.example`, another site.
 */
export function sameOriginPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  let url: URL;

  try {
    url = new URL(value, BASE);
  } catch {
    return "/";
  }

  if (url.origin !== BASE) return "/";

  // Dot segments can resolve to a path that starts with `//` (`/.//evil.example`), which a
  // browser reads as another site when it follows it.
  if (url.pathname.startsWith("//")) return "/";

  return `${url.pathname}${url.search}${url.hash}`.slice(0, 2000);
}
