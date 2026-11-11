// The Worker's API (apps/worker/src/routes/api.ts), as the web app reads it.
import type { Role, TokenScope, TokenSource } from "@wurmhol/protocol";

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

/** The Worker answered 401: no one is signed in. */
export function isSignedOut(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

/** Sends the browser to sign in, and back to this page after. */
export function toLogin() {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}

export interface Me {
  user: { id: string; email: string; name: string; image: string | null };
  orgs: { id: string; name: string; role: string; personal: boolean }[];
  activeOrgId: string | null;
  role: Role | null;
  standing: Standing | null;
  /** The org's owner may manage embedded apps here (ADR 0032): Business, on an install that has them. */
  apps: boolean;
}

/** What an integration key may do (ADR 0032). */
export type AppPermission = "tunnels:read" | "tunnels:manage" | "subjects:manage" | "grants:issue";

/** An embedded application, with this window's requests and its open pipes. */
export interface App {
  id: string;
  name: string;
  launchUrl: string | null;
  allowedOrigins: string[];
  monthlyRequests: number | null;
  activeTunnels: number | null;
  tenantMonthlyRequests: number | null;
  tenantActiveTunnels: number | null;
  createdAt: string;
  usage: { requests: number; openTunnels: number };
}

/** The settings an owner changes on an application. */
export type AppSettings = Pick<
  App,
  | "name"
  | "launchUrl"
  | "allowedOrigins"
  | "monthlyRequests"
  | "activeTunnels"
  | "tenantMonthlyRequests"
  | "tenantActiveTunnels"
>;

export interface AppKey {
  id: string;
  name: string;
  permissions: AppPermission[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdBy: string | null;
}

/** An embedded pipe's lifecycle and health: never anything from inside it. */
export interface AppTunnel {
  id: string;
  url: string;
  tenant: string;
  owner: string;
  state: "never" | "live" | "away" | "stopped" | "ended";
  createdAt: string;
  stoppedAt: string | null;
  session: {
    id: string;
    startedAt: string;
    lastRequestAt: string | null;
    bytes: number;
  } | null;
  lastEnd: { reason: string | null; at: string } | null;
}

/** Whether the org may open pipes (ADR 0027): billing off, or a plan in good standing. */
export type Standing =
  | { ok: true; reason: "billing_off" }
  | { ok: true; reason: "subscribed"; plan: string }
  | { ok: false; reason: "no_subscription" };

export interface Token {
  id: string;
  name: string;
  scope: TokenScope;
  /** `login`: a computer approved with `wurmhol login`, shown under Computers. */
  source: TokenSource;
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
  /** The port a share's login opens once approved (ADR 0026); null for `wurmhol login`. */
  port: number | null;
  status: "pending" | "approved" | "denied";
  org: { id: string; name: string | null };
  role: Role;
  /** Not ok: `/connect` refuses the org, so a share's login would never open its pipe. */
  standing: Standing;
}
