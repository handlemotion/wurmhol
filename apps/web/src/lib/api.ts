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
  standing: { ok: boolean; reason: "billing_off" | "subscribed" | "no_subscription" } | null;
}

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
  status: "pending" | "approved" | "denied";
  org: { id: string; name: string | null };
}
