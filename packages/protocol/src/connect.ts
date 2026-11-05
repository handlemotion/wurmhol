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

/** The close code for a CLI socket that the same CLI's reconnect replaced. The share goes on. */
export const REPLACED_CLOSE_CODE = 4000;

const BY_CODE = new Map(Object.entries(CLOSE_CODES).map(([reason, code]) => [code, reason]));

/**
 * The reason a close code ends a share for, or `undefined` for a code that leaves it resumable.
 * Either end closing with `1000` stops the share.
 */
export function endReasonFor(code: number): EndReason | undefined {
  return BY_CODE.get(code) as EndReason | undefined;
}

export function isEndReason(value: unknown): value is EndReason {
  return typeof value === "string" && Object.hasOwn(CLOSE_CODES, value);
}

/**
 * A refused handshake (`/connect`, `/host`, or any bearer-token call), answered with plain HTTP
 * before any upgrade. `fix` is one line that says what to do, as the CLI prints it. `reason` is
 * set on a refusal no retry can get past: a share refused on reconnect ends for that reason.
 */
export interface Refusal {
  error: string;
  fix: string;
  reason?: EndReason;
}

/** What a refusal with each status ends a share for, unless it names its own reason. */
const ENDING_STATUSES: Partial<Record<number, EndReason>> = {
  401: "revoked",
  402: "no_subscription",
  404: "disconnected",
  410: "disconnected",
};

/** A refusal's body. `extra` adds fields some refusals carry, like `retryAfter`. */
export function refusal(
  status: number,
  error: string,
  fix: string,
  extra: { reason?: EndReason } & Record<string, unknown> = {},
): Refusal & Record<string, unknown> {
  const reason = extra.reason ?? ENDING_STATUSES[status];
  return { error, fix, ...extra, ...(reason ? { reason } : {}) };
}

/** A refusal's body as the CLI reads it, or null when it is not one (a proxy's or portal's page). */
export function parseRefusal(body: string): Refusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { error, fix, reason } = parsed as Record<string, unknown>;
  if (typeof fix !== "string" || !fix) return null;
  return {
    error: typeof error === "string" ? error : "",
    fix,
    ...(isEndReason(reason) ? { reason } : {}),
  };
}
