// Who may do what in an org: the values the database stores, the Worker checks and the web app
// offers. Spec section 3; tokens are ADR 0008.

/** Org roles: owners manage members, tokens and billing; members share. */
export const ROLES = ["owner", "member"] as const;
export type Role = (typeof ROLES)[number];

/** What a token may do: `pipes` opens pipes; `org` also lists and closes the org's. */
export const TOKEN_SCOPES = ["pipes", "org"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * How a token came to be: made in the console's Tokens dialog, or minted for a computer approved
 * with `wurmhol login`, which the console lists as a signed-in computer.
 */
export const TOKEN_SOURCES = ["console", "login"] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];

/** The lifetimes a new token may have, in days; null is never expiring. */
export const TOKEN_EXPIRY_DAYS = [30, 90] as const;
export type TokenExpiry = (typeof TOKEN_EXPIRY_DAYS)[number] | null;
