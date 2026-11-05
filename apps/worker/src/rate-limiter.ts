// Rate limits for abuse-prone routes (sign-in, starting shares, tokens, invite links). From Omni.
// One Durable Object instance per (rule, key), so every count is strongly consistent and a busy
// key never slows another. Fixed windows: simple, and exact enough for abuse control.
import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "@wurmhol/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context.ts";
import type { Config, RateLimit } from "./env.ts";

/** Each rule and the variable that sets it. */
const RULES = {
  auth: "RATE_LIMIT_AUTH",
  connect: "RATE_LIMIT_CONNECT",
  manage: "RATE_LIMIT_MANAGE",
} as const satisfies Record<string, keyof Config>;

export type RateLimitRule = keyof typeof RULES;

export class RateLimiter extends DurableObject<Env> {
  /**
   * Counts one hit if the window has room. Returns 0 when allowed, otherwise the seconds until
   * the window resets. Refused hits are not counted, so a client that waits gets in again.
   */
  async hit(limit: number, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    let state = await this.ctx.storage.get<{ start: number; count: number }>("window");
    if (!state || now >= state.start + windowMs) state = { start: now, count: 0 };
    if (state.count >= limit) return Math.max(1, Math.ceil((state.start + windowMs - now) / 1000));
    state.count += 1;
    await this.ctx.storage.put("window", state);
    // Nothing outlives its window: the alarm clears this instance's storage.
    await this.ctx.storage.setAlarm(state.start + windowMs);
    return 0;
  }

  override async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Seconds to wait, or 0 if the hit is allowed. Keys are hashed so no address or IP becomes a
 * Durable Object name. A disabled rule (`off`) always allows.
 */
export async function checkRateLimit(
  env: Env,
  config: Config,
  rule: RateLimitRule,
  key: string,
): Promise<number> {
  const limit: RateLimit = config[RULES[rule]];
  if (!limit) return 0;
  const name = await sha256Hex(`${rule}:${key}`);
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
  return stub.hit(limit.count, limit.windowSeconds);
}

export function tooManyRequests(retryAfter: number) {
  return Response.json(
    { error: "too many requests" },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

/** The caller's IP as Cloudflare saw it. Clients cannot set this header through Cloudflare. */
export function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Limits a member route per member. Mount after `requireMember`. */
export function limitPerMember(rule: RateLimitRule) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const wait = await checkRateLimit(c.env, c.var.config, rule, c.var.member.id);
    if (wait) return tooManyRequests(wait);
    await next();
  });
}

/**
 * Better Auth's routes: every sign-in step (passkey options and verification, OAuth start and
 * callback, magic-link verify) counts per IP; reads like `get-session` do not.
 */
export const limitAuth = createMiddleware<AppEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api\/auth/, "");
  const signInStep = c.req.method === "POST" || /^\/(callback|magic-link|passkey)\//.test(path);
  if (!signInStep) return next();
  const wait = await checkRateLimit(c.env, c.var.config, "auth", clientIp(c.req.raw));
  if (wait) return tooManyRequests(wait);
  await next();
});
