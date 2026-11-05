import { createAuth, type Auth } from "@wurmhol/auth";
import { createDb, findMember, type Db, type Membership } from "@wurmhol/db";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { loadConfig, type Config } from "./env.ts";
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
  };
}

/** Builds Better Auth for one request scope. */
export function authFor(env: Env, config: Config, db: Db): Auth {
  return createAuth({
    db,
    ...config.auth,
    // No mail sender yet (spec open question 4): magic links only outside production, where
    // the link is logged. The e2e suites read it from D1's `verifications` table.
    sendMagicLink:
      config.ENVIRONMENT === "production"
        ? undefined
        : async ({ email, url }) => {
            if (config.ENVIRONMENT === "development") {
              // oxlint-disable-next-line no-console -- the dev sign-in link, by design
              console.log(JSON.stringify({ event: "auth.dev_link", email, url }));
            }
          },
  });
}

/** Per-request config, database and Better Auth. */
export const requestScope = createMiddleware<AppEnv>(async (c, next) => {
  const config = loadConfig(c.env);
  const db = createDb(c.env.DB);
  c.set("config", config);
  c.set("db", db);
  c.set("auth", authFor(c.env, config, db));
  await next();
});

/** The signed-in user, from Better Auth's session. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
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
  return { user: { id, email, name }, member, activeOrgId };
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
