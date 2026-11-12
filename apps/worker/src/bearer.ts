// What the CLI and orchestrators present on the CLI's host: `Authorization: Bearer wh_…`.
// Refusals are `@wurmhol/protocol`'s `Refusal`: the CLI prints `fix`, one line that says what to
// do, and stops retrying on one with a `reason`.
import { type Db, findMember, isOrgBlocked, useToken } from "@wurmhol/db";
import { refusal } from "@wurmhol/protocol";
import type { HonoRequest } from "hono";
import type { AppEnv } from "./context.ts";
import type { Config } from "./env.ts";
import { checkRateLimit } from "./rate-limiter.ts";

export function refuse(...args: Parameters<typeof refusal>) {
  return Response.json(refusal(...args), { status: args[0] });
}

export type BearerToken = Extract<Awaited<ReturnType<typeof useToken>>, { ok: true }>;

/** Why a presented token is refused, with the one line that fixes it. */
export interface TokenRefusal {
  ok: false;
  status: 401 | 403;
  error: string;
  fix: string;
}

/**
 * The live, unexpired token `presented` is, acting for someone still in its org, of an org no
 * operator blocked (ADR 0022); or why it is refused. `org` asks for a token that can list and end
 * every pipe of the org, not only open its own. Every route that takes a `wh_` token goes through
 * here.
 */
export async function checkToken(
  db: Db,
  config: Config,
  presented: string,
  options: { org?: boolean } = {},
): Promise<BearerToken | TokenRefusal> {
  const tokensPage = `${config.auth.baseURL} (menu → Tokens)`;

  const refusal = (status: 401 | 403, error: string, fix: string): TokenRefusal => ({
    ok: false,
    status,
    error,
    fix,
  });

  const token = await useToken(db, presented);

  if (!token.ok) {
    return token.reason === "expired"
      ? refusal(
          401,
          "token expired",
          `This token expired. Create a new one at ${tokensPage} and set WURMHOL_TOKEN.`,
        )
      : refusal(
          401,
          "token revoked or unknown",
          `Create a new token at ${tokensPage} and set WURMHOL_TOKEN.`,
        );
  }

  // A token acts for whoever made it, so only while they are in its org. Leaving revokes their
  // tokens (ADR 0021); this holds in the moment between the two, and for any token missed.
  if (token.createdBy && !(await findMember(db, token.createdBy, token.orgId))) {
    return refusal(
      401,
      "token owner left the org",
      `Whoever made this token is no longer in its org. Create a new token at ${tokensPage} and set WURMHOL_TOKEN.`,
    );
  }

  if (await isOrgBlocked(db, token.orgId)) {
    return refusal(
      401,
      "org blocked",
      `This org is blocked from opening pipes. Contact the operator of ${config.auth.baseURL}.`,
    );
  }

  if (options.org && token.scope !== "org") {
    return refusal(
      403,
      "token scope",
      `This token can only open pipes. Create one that can list and close every pipe in the org at ${tokensPage}.`,
    );
  }

  return token;
}

/**
 * The request's token (see `checkToken`), counted against the `connect` rate limit; or the
 * refusal to send instead.
 */
export async function bearerToken(
  c: {
    env: Env;
    req: HonoRequest;
    var: Pick<AppEnv["Variables"], "config" | "db">;
  },
  options: { org?: boolean } = {},
): Promise<BearerToken | Response> {
  const { config, db } = c.var;
  const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];

  if (!presented) {
    return refuse(
      401,
      "token missing",
      `Set WURMHOL_TOKEN to a token from ${config.auth.baseURL} (menu → Tokens).`,
    );
  }

  const token = await checkToken(db, config, presented, options);

  if (!token.ok) return refuse(token.status, token.error, token.fix);
  const wait = await checkRateLimit(c.env, config, "connect", token.id);

  if (wait) {
    return refuse(429, "too many requests", `Wait ${wait} s and try again.`, {
      retryAfter: wait,
    });
  }

  return token;
}
