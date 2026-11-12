// JSON as it arrives from a peer, before a decoder has checked it. Every decoder in the protocol,
// the SDK and the CLI branches on these guards, so a value's representation is inspected in one
// place and each decoder only states its contract.

/** Any value `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object whose fields are not decoded yet. A missing field reads as `undefined`. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** `text` parsed as JSON. Throws `SyntaxError` like `JSON.parse`, which it is. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** A number JSON can carry: never `NaN` or an infinity. */
export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

/** A JSON object: not null and not an array. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}
