import { authEnvSchema } from "@wurmhol/auth";
import { pipeName, SHARE_ID } from "@wurmhol/protocol";
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
      GITHUB_APP_PRIVATE_KEY?: string;
      GITHUB_APP_CLIENT_SECRET?: string;
      GITHUB_APP_WEBHOOK_SECRET?: string;
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

/** An optional string var: undefined when empty. */
const optional = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

/**
 * The GitHub App that posts pipes to pull requests as deployments (ADR 0016). All of it or none
 * of it: with no `GITHUB_APP_ID`, nothing talks to GitHub.
 */
const githubSchema = z
  .object({
    GITHUB_APP_ID: optional.pipe(z.string().regex(/^\d+$/, "use the App's numeric id").optional()),
    /** The App's URL name: github.com/apps/<slug>. */
    GITHUB_APP_SLUG: optional.pipe(
      z
        .string()
        .regex(/^[a-z0-9-]+$/, "use the App's slug, as in github.com/apps/<slug>")
        .optional(),
    ),
    GITHUB_APP_CLIENT_ID: optional,
    GITHUB_APP_CLIENT_SECRET: optional,
    /** PEM, as GitHub downloads it; `\n` escapes are read as newlines. */
    GITHUB_APP_PRIVATE_KEY: optional.transform((value) => value?.replace(/\\n/g, "\n")),
    GITHUB_APP_WEBHOOK_SECRET: optional,
    /** GitHub Enterprise Server: its API and web origins. Default github.com. */
    GITHUB_API_URL: optional.pipe(z.url().optional()),
    GITHUB_WEB_URL: optional.pipe(z.url().optional()),
  })
  .superRefine((vars, ctx) => {
    if (!vars.GITHUB_APP_ID) return;
    for (const name of [
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_WEBHOOK_SECRET",
    ] as const) {
      if (!vars[name])
        ctx.addIssue({ code: "custom", path: [name], message: "required with GITHUB_APP_ID" });
    }
  })
  .transform((vars) =>
    vars.GITHUB_APP_ID
      ? {
          appId: vars.GITHUB_APP_ID,
          slug: vars.GITHUB_APP_SLUG!,
          clientId: vars.GITHUB_APP_CLIENT_ID!,
          clientSecret: vars.GITHUB_APP_CLIENT_SECRET!,
          privateKey: vars.GITHUB_APP_PRIVATE_KEY!,
          webhookSecret: vars.GITHUB_APP_WEBHOOK_SECRET!,
          apiUrl: (vars.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
          webUrl: (vars.GITHUB_WEB_URL ?? "https://github.com").replace(/\/$/, ""),
        }
      : undefined,
  );

export type GithubConfig = NonNullable<z.output<typeof githubSchema>>;

export type RateLimit = { count: number; windowSeconds: number } | null;

/** An optional hostname var, lowercased: undefined when empty. */
function optionalHost(example: string) {
  return z
    .string()
    .optional()
    .transform((value) => value?.toLowerCase() || undefined)
    .pipe(
      z
        .string()
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `use a hostname like ${example}`)
        .optional(),
    );
}

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
     * and port as BETTER_AUTH_URL. `wurmhol.dev` in production, `pipe.localhost` locally.
     */
    SHARE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "use a lowercase domain like example-pipes.dev"),
    /**
     * The host the CLI dials (ADR 0006), e.g. `api.wurmhol.com`: it answers `/connect`,
     * `/device/code`, `/device/token` and `/health` only. Empty: the CLI dials the app's own host (BETTER_AUTH_URL).
     */
    CONNECT_HOST: optionalHost("api.example.com"),
    /**
     * The OAuth callback relay's host (ADR 0010), e.g. `oauth.wurmhol.dev`: one redirect URI per
     * provider for every pipe. Same scheme and port as BETTER_AUTH_URL. Under SHARE_DOMAIN, its
     * label is reserved: no pipe may take that name. Empty: no relay.
     */
    OAUTH_RELAY_HOST: optionalHost("oauth.example-pipes.dev"),
    /** Hosts that permanently redirect to the app, e.g. `app.wurmhol.com`. Comma-separated. */
    APP_ALIASES: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      ),
    /** Where the wall's Docs links go. The hosted docs by default; a self-hosted install may
     * point it at its own copy. */
    DOCS_URL: z
      .string()
      .optional()
      .transform((value) => value || "https://wurmhol.com/docs")
      .pipe(z.url({ protocol: /^https?$/ })),
    /** Fair-use limits per org (spec section 4), enforced by the Durable Objects. */
    LIMIT_ACTIVE_SHARES: positive(5),
    /** Bytes relayed per org per calendar month (UTC), both directions. 100 GB by default. */
    LIMIT_MONTHLY_BYTES: positive(100 * 1000 ** 3),
    /** Longest a share stays open, in seconds; the CLI's `--ttl` may ask up to this. 12 hours. */
    LIMIT_SHARE_SECONDS: positive(12 * 3600),
    /** Days the daily retention job keeps a pipe's history (`shares` rows). 90 by default. */
    RETENTION_DAYS: positive(90),
    /**
     * How long a share stays open when the CLI asks for no lifetime, in seconds, capped at
     * `LIMIT_SHARE_SECONDS`. 4 hours by default (ADR 0008).
     */
    DEFAULT_SHARE_SECONDS: positive(4 * 3600),
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
    /** Per person (OAuth) or token (`wh_`): calls to the hosted MCP server (ADR 0014). */
    RATE_LIMIT_MCP: rateLimit("120/60"),
    /**
     * The hosted MCP server at `/mcp` on the CLI's host (ADR 0014). On by default; `false` turns
     * it off, and `/mcp` and its OAuth routes answer 404.
     */
    MCP_ENABLED: z
      .string()
      .optional()
      .transform((value) => value?.trim().toLowerCase() || "true")
      .pipe(z.enum(["true", "false"], 'use "true" or "false"'))
      .transform((value) => value === "true"),
  })
  .and(z.object({ auth: authEnvSchema, github: githubSchema }))
  .superRefine((config, ctx) => {
    const app = new URL(config.auth.baseURL).hostname;
    if (app === config.SHARE_DOMAIN || app.endsWith(`.${config.SHARE_DOMAIN}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["SHARE_DOMAIN"],
        message: "must not contain the app's host: shares and the app are separate sites",
      });
    }
    const relay = config.OAUTH_RELAY_HOST;
    if (relay) {
      if (relay === app || relay === config.CONNECT_HOST || config.APP_ALIASES.includes(relay)) {
        ctx.addIssue({
          code: "custom",
          path: ["OAUTH_RELAY_HOST"],
          message: "must be a host of its own, not the app's, the CLI's or an alias",
        });
      }
      const label = labelUnder(relay, config.SHARE_DOMAIN);
      if (label !== null && (label.includes(".") || SHARE_ID.test(label))) {
        ctx.addIssue({
          code: "custom",
          path: ["OAUTH_RELAY_HOST"],
          message: `under SHARE_DOMAIN, use one label that is not 10 letters and digits, like oauth.${config.SHARE_DOMAIN}`,
        });
      }
    }
  });

export type Config = z.output<typeof configSchema>;

/** Whether `hostname` is a loopback host, where OAuth allows plain `http`. */
function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The hosted MCP server's URL (ADR 0014), the audience of its access tokens: `/mcp` on the CLI's
 * host, on the app's scheme and port; on the app's own host when there is no CLI host. Null when
 * it is off: by `MCP_ENABLED=false`, or because OAuth needs HTTPS and this stack serves plain
 * HTTP on a host that is not loopback (`api.localhost` in development).
 */
export function mcpResource(config: Config): string | null {
  if (!config.MCP_ENABLED) return null;
  const app = new URL(config.auth.baseURL);
  const hostname = config.CONNECT_HOST ?? app.hostname;
  if (app.protocol !== "https:" && !isLoopback(hostname)) return null;
  return `${app.protocol}//${hostname}${app.port ? `:${app.port}` : ""}/mcp`;
}

const cache = new WeakMap<object, Config>();

/** Validates the Worker's vars and secrets once per isolate; throws naming every bad variable. */
export function loadConfig(env: Env): Config {
  let config = cache.get(env);
  if (!config) {
    const parsed = configSchema.safeParse({ ...env, auth: env, github: env });
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

/**
 * The public origin of a share: `https://<label>.wurmhol.dev`, where the label is a named pipe's
 * name (ADR 0009) or the share's id.
 */
export function shareOrigin(config: Config, share: { id: string; name?: string | null }) {
  return originOnAppPort(config, `${share.name || share.id}.${config.SHARE_DOMAIN}`);
}

/** `hostname`'s origin on the app's scheme and port (BETTER_AUTH_URL). */
function originOnAppPort(config: Config, hostname: string) {
  const app = new URL(config.auth.baseURL);
  return `${app.protocol}//${hostname}${app.port ? `:${app.port}` : ""}`;
}

/** A Host header's hostname: lowercased, without its port. */
function hostnameOf(host: string | null) {
  return (host ?? "").toLowerCase().replace(/:\d+$/, "");
}

/** What `hostname` puts before `.<domain>`, or null when it is not under `domain`. */
function labelUnder(hostname: string, domain: string) {
  const suffix = `.${domain}`;
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : null;
}

/**
 * The first label of a share host, or null when the host is not one. An id names its share; a
 * name (ADR 0009) names its org's open pipe, if any. Anything else is "".
 */
export function shareLabelFromHost(config: Config, host: string | null): string | null {
  if (!host) return null;
  const label = labelUnder(hostnameOf(host), config.SHARE_DOMAIN);
  if (label === null) return null;
  return SHARE_ID.test(label) || pipeName(label) === label ? label : "";
}

/** The relay's public origin (ADR 0010), on the app's scheme and port; null when it is off. */
export function relayOrigin(config: Config) {
  return config.OAUTH_RELAY_HOST ? originOnAppPort(config, config.OAUTH_RELAY_HOST) : null;
}

/** The pipe name the relay's host takes from SHARE_DOMAIN, or null when it lives elsewhere. */
export function reservedPipeName(config: Config) {
  const relay = config.OAUTH_RELAY_HOST;
  return relay ? labelUnder(relay, config.SHARE_DOMAIN) : null;
}

/** What a request's host is for (ADR 0006). */
export type HostRole =
  | { role: "share"; label: string }
  | { role: "connect" }
  | { role: "oauth" }
  | { role: "alias" }
  | { role: "app" };

export function hostRole(config: Config, host: string | null): HostRole {
  const hostname = hostnameOf(host);
  // Before share labels: the relay may live under SHARE_DOMAIN, with its label reserved.
  if (config.OAUTH_RELAY_HOST && hostname === config.OAUTH_RELAY_HOST) return { role: "oauth" };
  const label = shareLabelFromHost(config, host);
  if (label !== null) return { role: "share", label };
  if (config.CONNECT_HOST && hostname === config.CONNECT_HOST) return { role: "connect" };
  if (config.APP_ALIASES.includes(hostname)) return { role: "alias" };
  return { role: "app" };
}
