import { createAuth, type Auth } from "@wurmhol/auth";
import { createDb, findMember, type Db, type Membership } from "@wurmhol/db";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { loadConfig, mcpResource, type Config } from "./env.ts";
import type { Logger } from "./log.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    config: Config;
    db: Db;
    auth: Auth;
    member: Membership;
    user: SessionUser;
    /** This request's ID (`x-request-id`), on every log line. */
    requestId: string;
    log: Logger;
    /** Development only: the magic link this request created, for the login page to show. */
    devLink?: string;
  };
}

/** Whether this install signs in by magic link: with a sender, or where links are logged. */
export function magicLinksOn(config: Config) {
  return config.MAIL_FROM !== undefined || config.ENVIRONMENT !== "production";
}

/**
 * The magic link on the origin the person asked from. The login page sends an absolute
 * `callbackURL`, which Better Auth has already checked against the trusted origins; a stack
 * opened through a pipe gets a link that opens on that pipe, not on its own `BETTER_AUTH_URL`
 * (`localhost`), which the person can't reach.
 */
export function linkOnCallbackOrigin(url: string) {
  const link = new URL(url);
  const callback = link.searchParams.get("callbackURL") ?? "";
  if (!URL.canParse(callback)) return url;
  const origin = new URL(callback).origin;
  return origin === link.origin
    ? url
    : new URL(`${link.pathname}${link.search}`, origin).toString();
}

/**
 * Builds Better Auth for one request scope. In development, `onDevLink` receives each magic
 * link, since no mail is sent there. `mcp` adds the hosted MCP server's OAuth provider (ADR
 * 0014), for its routes only: the provider reads D1 each time an instance starts.
 */
export function authFor(
  env: Env,
  config: Config,
  db: Db,
  onDevLink: (url: string) => void = () => {},
  options: { mcp?: boolean } = {},
): Auth {
  const resource = options.mcp ? mcpResource(config) : null;
  return createAuth({
    db,
    ...config.auth,
    mcp: resource ? { resource } : undefined,
    sendMagicLink: magicLinksOn(config)
      ? async ({ email, url: built }) => {
          const url = linkOnCallbackOrigin(built);
          if (config.ENVIRONMENT === "development") {
            // oxlint-disable-next-line no-console -- the dev sign-in link, by design
            console.log(JSON.stringify({ event: "auth.dev_link", email, url }));
            onDevLink(url);
          }
          // Mail goes out whenever a sender is set (wrangler dev simulates the binding). The
          // e2e suites leave it unset and read the link from D1 instead.
          if (config.MAIL_FROM) await sendMagicLinkMail(env, config, email, url);
        }
      : undefined,
  });
}

/** The sign-in email, through Cloudflare Email Service (ADR 0005). */
async function sendMagicLinkMail(env: Env, config: Config, email: string, url: string) {
  const app = config.auth.appName;
  const escaped = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  await env.EMAIL.send({
    from: { email: config.MAIL_FROM!, name: app },
    to: email,
    subject: `Sign in to ${app}`,
    text: `Open this link to sign in to ${app}:\n\n${url}\n\nIt works once, for 5 minutes. If you did not ask for it, ignore this email.`,
    html: `<p>Open this link to sign in to ${app}:</p><p><a href="${escaped}">Sign in to ${app}</a></p><p>It works once, for 5 minutes. If you did not ask for it, ignore this email.</p>`,
  });
}

/** Per-request config, database and Better Auth. */
export const requestScope = createMiddleware<AppEnv>(async (c, next) => {
  const config = loadConfig(c.env);
  const db = createDb(c.env.DB);
  c.set("config", config);
  c.set("db", db);
  c.set(
    "auth",
    authFor(c.env, config, db, (url) => c.set("devLink", url)),
  );
  await next();
});

/**
 * The same scope, with the hosted MCP server's OAuth provider loaded: `/mcp`, its metadata, and
 * the OAuth routes under `/api/auth`.
 */
export const mcpScope = createMiddleware<AppEnv>(async (c, next) => {
  const config = loadConfig(c.env);
  const db = createDb(c.env.DB);
  c.set("config", config);
  c.set("db", db);
  c.set("auth", authFor(c.env, config, db, undefined, { mcp: true }));
  await next();
});

/** The signed-in user, from Better Auth's session. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** The picture Google or GitHub gave at sign-in, or null. */
  image: string | null;
}

/**
 * The session's user and their membership in the active org (or their oldest org), or null when
 * signed out. `member` is null for a user in no org.
 */
export async function resolveSession(c: {
  req: { raw: Request };
  var: { auth: Auth; db: Db };
}): Promise<{ user: SessionUser; member: Membership | null; activeOrgId: string | null } | null> {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  const member =
    (activeOrgId ? await findMember(c.var.db, session.user.id, activeOrgId) : null) ??
    (await findMember(c.var.db, session.user.id));
  const { id, email, name } = session.user;
  return { user: { id, email, name, image: session.user.image ?? null }, member, activeOrgId };
}

/** Resolves the session to a member of its active org. 401 signed out, 403 in no org. */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  if (!resolved.member) throw new HTTPException(403, { message: "not a member of any org" });
  c.set("user", resolved.user);
  c.set("member", resolved.member);
  await next();
});

/** Owners only: members, invites and billing. Mount after `requireMember`. */
export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.member.role !== "owner") {
    throw new HTTPException(403, { message: "only owners can do this" });
  }
  await next();
});
