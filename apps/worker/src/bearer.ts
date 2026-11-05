// What the CLI and orchestrators present on the CLI's host: `Authorization: Bearer wh_…`.
// Refusals are `{ error, fix }`: the CLI prints `fix`, one line that says what to do.
import { findMember, useToken } from "@wurmhol/db";
import type { HonoRequest } from "hono";
import type { AppEnv } from "./context.ts";
import { checkRateLimit } from "./rate-limiter.ts";

export function refuse(
  status: number,
  error: string,
  fix: string,
  extra: Record<string, unknown> = {},
) {
  return Response.json({ error, fix, ...extra }, { status });
}

export type BearerToken = Extract<Awaited<ReturnType<typeof useToken>>, { ok: true }>;

/**
 * The request's live, unexpired token, counted against the `connect` rate limit; or the refusal
 * to send instead.
 */
export async function bearerToken(c: {
  env: Env;
  req: HonoRequest;
  var: Pick<AppEnv["Variables"], "config" | "db">;
}): Promise<BearerToken | Response> {
  const { config, db } = c.var;
  const tokensPage = `${config.auth.baseURL} (menu → Tokens)`;
  const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (!presented) {
    return refuse(401, "token missing", `Set WURMHOL_TOKEN to a token from ${tokensPage}.`);
  }
  const token = await useToken(db, presented);
  if (!token.ok) {
    return token.reason === "expired"
      ? refuse(
          401,
          "token expired",
          `This token expired. Create a new one at ${tokensPage} and set WURMHOL_TOKEN.`,
        )
      : refuse(
          401,
          "token revoked or unknown",
          `Create a new token at ${tokensPage} and set WURMHOL_TOKEN.`,
        );
  }
  // A token acts for whoever made it, so only while they are in its org. Leaving revokes their
  // tokens (ADR 0021); this holds in the moment between the two, and for any token missed.
  if (token.createdBy && !(await findMember(db, token.createdBy, token.orgId))) {
    return refuse(
      401,
      "token owner left the org",
      `Whoever made this token is no longer in its org. Create a new token at ${tokensPage} and set WURMHOL_TOKEN.`,
    );
  }
  const wait = await checkRateLimit(c.env, config, "connect", token.id);
  if (wait) {
    return refuse(429, "too many requests", `Wait ${wait} s and try again.`, {
      retryAfter: wait,
    });
  }
  return token;
}
