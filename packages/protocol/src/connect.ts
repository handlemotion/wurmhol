// The `/connect` contract outside the frames: the handshake headers and the close codes that end a
// share. The Worker sends them and the CLI reads them, so both take the names from here.

/** Headers on the CLI's `/connect` upgrade request. Only a new share sends them. */
export const CONNECT_HEADERS = {
  /** The emails that may open the new share, comma-separated. */
  viewers: "wurmhol-viewers",
  /** Where the new share came from, as URI-encoded JSON (ADR 0015). */
  source: "wurmhol-source",
} as const;

/** Headers on the Worker's `101` answer: the share the socket belongs to. */
export const SHARE_HEADERS = {
  id: "x-wurmhol-share-id",
  url: "x-wurmhol-share-url",
  /** ISO 8601. */
  endsAt: "x-wurmhol-share-ends-at",
} as const;

/** Why a share ended. Every reason is final: open a new pipe to share the port again. */
export type EndReason =
  | "stopped"
  | "terminated"
  | "expired"
  | "revoked"
  | "limit"
  | "disconnected"
  | "no_subscription";

/** The close code the Worker ends a CLI's socket with, per reason. The CLI never reconnects after one. */
export const CLOSE_CODES: Record<EndReason, number> = {
  stopped: 1000,
  terminated: 4001,
  expired: 4002,
  revoked: 4003,
  limit: 4004,
  disconnected: 4005,
  no_subscription: 4006,
};

const BY_CODE = new Map(Object.entries(CLOSE_CODES).map(([reason, code]) => [code, reason]));

/**
 * The reason a close code ends a share for, or `undefined` for a code that leaves it resumable.
 * `1000` is left out: a clean close carries its own reason text.
 */
export function endReasonFor(code: number): EndReason | undefined {
  return code === CLOSE_CODES.stopped ? undefined : (BY_CODE.get(code) as EndReason | undefined);
}

export function isEndReason(value: string): value is EndReason {
  return Object.hasOwn(CLOSE_CODES, value);
}
