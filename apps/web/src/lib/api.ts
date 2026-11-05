// The Worker's API (apps/worker/src/routes/api.ts), as the web app reads it.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export interface Me {
  user: { id: string; email: string; name: string };
  orgs: { id: string; name: string; role: string }[];
  activeOrgId: string | null;
  role: "owner" | "member" | null;
  standing: { ok: boolean; reason: "billing_off" | "subscribed" | "no_subscription" } | null;
}

/** One card on the wall (apps/worker/src/org-do.ts `ShareCard`). */
export interface Share {
  id: string;
  url: string;
  port: number;
  startedBy: string | null;
  startedAt: number;
  title: string | null;
  favicon: boolean;
  lastRequestAt: number | null;
  state: "live" | "away";
}

export type WallEvent =
  | { type: "snapshot"; shares: Share[] }
  | { type: "share.started"; share: Share }
  | { type: "share.updated"; share: Share }
  | { type: "share.ended"; id: string };

export type TokenScope = "pipes" | "org";
/** Days until a new token expires; null never. */
export type TokenExpiry = 30 | 90 | null;

export interface Token {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdBy: string | null;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
}

export interface SignInMethods {
  google: boolean;
  github: boolean;
  magicLink: boolean;
}
