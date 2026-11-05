import { authEnvSchema } from "@wurmhol/auth";
import { z } from "zod";

// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them. Documented in
// `.dev.vars.example`.
declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string;
      GOOGLE_CLIENT_SECRET?: string;
      GITHUB_CLIENT_SECRET?: string;
      STRIPE_SECRET_KEY?: string;
      STRIPE_WEBHOOK_SECRET?: string;
    }
  }
}

/** `<count>/<seconds>`, e.g. `5/900` for five per 15 minutes; `off` disables the rule. */
function rateLimit(fallback: string) {
  return z
    .string()
    .optional()
    .transform((value) => value || fallback)
    .pipe(
      z
        .string()
        .regex(/^(off|[1-9]\d*\/[1-9]\d*)$/, 'use "<count>/<seconds>" (e.g. "5/900") or "off"'),
    )
    .transform((value) => {
      if (value === "off") return null;
      const [count, windowSeconds] = value.split("/").map(Number) as [number, number];
      return { count, windowSeconds };
    });
}

export type RateLimit = { count: number; windowSeconds: number } | null;

/** A positive whole number from a var, `fallback` when empty. */
function positive(fallback: number) {
  return z
    .string()
    .optional()
    .transform((value) => value || String(fallback))
    .pipe(z.string().regex(/^[1-9]\d*$/, "use a positive whole number"))
    .transform(Number);
}

const configSchema = z
  .object({
    /**
     * The domain under which shares live: a share is `<id>.<SHARE_DOMAIN>`, on the same scheme
     * and port as BETTER_AUTH_URL. `pipe.wurmhol.com` in production, `pipe.localhost` locally.
     */
    SHARE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "use a lowercase domain like pipe.example.com"),
    /** Fair-use limits per org (spec section 4), enforced by the Durable Objects. */
    LIMIT_ACTIVE_SHARES: positive(5),
    /** Bytes relayed per org per calendar month (UTC), both directions. 100 GB by default. */
    LIMIT_MONTHLY_BYTES: positive(100 * 1000 ** 3),
    /** Longest a share stays open, in seconds. 12 hours by default. */
    LIMIT_SHARE_SECONDS: positive(12 * 3600),
    /**
     * `production` by default. `test` (the e2e suites) and `development` turn on magic-link
     * sign-in with the link logged (and kept for the suites) instead of mailed: no mail sender
     * exists yet (spec open question 4). Never in production: those links sign you in.
     */
    ENVIRONMENT: z.enum(["production", "development", "test"]).default("production"),
    /**
     * Sender of magic-link mail through Cloudflare Email Service (ADR 0005), on an onboarded
     * domain. Empty: no magic links in production.
     */
    MAIL_FROM: z
      .string()
      .optional()
      .transform((value) => value || undefined)
      .pipe(z.email().optional()),
    /** Per IP: every sign-in step. */
    RATE_LIMIT_AUTH: rateLimit("60/60"),
    /** Per email address: magic links, each of which sends mail. */
    RATE_LIMIT_MAGIC_LINK: rateLimit("5/900"),
    /** Per token: share connections (new and reconnecting). */
    RATE_LIMIT_CONNECT: rateLimit("60/60"),
    /** Per member: creating tokens and invite links, terminating shares. */
    RATE_LIMIT_MANAGE: rateLimit("60/60"),
  })
  .and(z.object({ auth: authEnvSchema }))
  .superRefine((config, ctx) => {
    const app = new URL(config.auth.baseURL).hostname;
    if (app === config.SHARE_DOMAIN || app.endsWith(`.${config.SHARE_DOMAIN}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["SHARE_DOMAIN"],
        message: "must not contain the app's host: shares and the app are separate sites",
      });
    }
  });

export type Config = z.output<typeof configSchema>;

const cache = new WeakMap<object, Config>();

/** Validates the Worker's vars and secrets once per isolate; throws naming every bad variable. */
export function loadConfig(env: Env): Config {
  let config = cache.get(env);
  if (!config) {
    const parsed = configSchema.safeParse({ ...env, auth: env });
    if (!parsed.success) {
      // Names only: values may be secrets.
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`invalid Worker config:\n  ${problems.join("\n  ")}`);
    }
    config = parsed.data;
    cache.set(env, config);
  }
  return config;
}

/** The public origin of share `id`: `https://<id>.pipe.wurmhol.com`. */
export function shareOrigin(config: Config, id: string) {
  const app = new URL(config.auth.baseURL);
  return `${app.protocol}//${id}.${config.SHARE_DOMAIN}${app.port ? `:${app.port}` : ""}`;
}

/** The share id a request's host names, or null when it is not a share host. */
export function shareIdFromHost(config: Config, host: string | null): string | null {
  if (!host) return null;
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${config.SHARE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;
  const id = hostname.slice(0, -suffix.length);
  return SHARE_ID.test(id) ? id : "";
}

/** A share id: 10 lowercase letters and digits. */
export const SHARE_ID = /^[a-z0-9]{10}$/;
