/**
 * Up to two capitals for an avatar without a picture: "Ada Lovelace" → "AL". Without a name, the
 * email's own part: "ada.byron@example.com" → "AB", never the domain's letter.
 */
export function initials(name: string, email = "") {
  const source = name.trim() || email.split("@")[0]!;

  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
