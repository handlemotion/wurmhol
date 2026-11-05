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
  user: { id: string; email: string; name: string; image: string | null };
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
  views: { name: string; lastSeenAt: number }[];
  state: "live" | "away";
  /** Where it came from (ADR 0015); null when its CLI said nothing. */
  source: PipeSource | null;
  /** The pull request it is posted to as a GitHub deployment (ADR 0016). */
  preview: { pullRequest: number; url: string } | null;
}

/** `@wurmhol/protocol`'s `PipeSource`: what the CLI said about where the pipe came from. */
export interface PipeSource {
  repoHost: string | null;
  repo: string | null;
  branch: string | null;
  commit: string | null;
  link: string | null;
  note: string | null;
  agent: string | null;
  agentUrl: string | null;
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
  /** `login`: a computer approved with `wurmhol login`, shown under Computers. */
  source: "console" | "login";
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

/** The Worker's config for the app (apps/worker/src/app.ts `appConfig`). */
export interface AppConfig {
  docsUrl: string;
}

/** A `wurmhol login` waiting for approval (apps/worker/src/routes/device.ts). */
export interface DeviceLogin {
  code: string;
  name: string | null;
  status: "pending" | "approved" | "denied";
  org: { id: string; name: string | null };
}
