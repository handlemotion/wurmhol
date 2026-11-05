import { createDb, pruneExpired } from "@wurmhol/db";
import { app } from "./app.ts";
import { hostRole, loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import { handleShareHost } from "./viewer.ts";

export type { AppType } from "./app.ts";
export { Org } from "./org-do.ts";
export { RateLimiter } from "./rate-limiter.ts";
export { Share } from "./share-do.ts";

export default {
  /**
   * One Worker, four kinds of host (ADR 0006): pipes (`<id>.wurmhol.dev`), the CLI's
   * endpoint (`api.wurmhol.com`, `/connect` only), aliases that redirect to the app
   * (`app.wurmhol.com`), and the app itself (`dirt.wurmhol.com`: console, API, sign-in).
   */
  async fetch(request, env, ctx) {
    const config = loadConfig(env);
    const host = hostRole(config, request.headers.get("host"));
    if (host.role === "alias") {
      const url = new URL(request.url);
      const target = new URL(`${url.pathname}${url.search}`, config.auth.baseURL);
      return Response.redirect(target.toString(), 301);
    }
    if (host.role === "connect") {
      const { pathname } = new URL(request.url);
      if (pathname === "/connect" || pathname === "/health") return app.fetch(request, env, ctx);
      return Response.json(
        {
          error: "not found",
          fix: `This host is for the wurmhol CLI. Open ${config.auth.baseURL}.`,
        },
        { status: 404 },
      );
    }
    if (host.role === "app") return app.fetch(request, env, ctx);
    try {
      return await handleShareHost(request, env, host.shareId);
    } catch (error) {
      createLogger({ component: "viewer" }).error("viewer.error", { error, shareId: host.shareId });
      return new Response("internal error", { status: 500 });
    }
  },

  /** The daily retention job (`triggers.crons`, ADR 0008), as of the time it was scheduled. */
  async scheduled(controller, env) {
    const config = loadConfig(env);
    const now = new Date(controller.scheduledTime);
    const pruned = await pruneExpired(createDb(env.DB), {
      now,
      retentionDays: config.RETENTION_DAYS,
    });
    createLogger({ component: "retention" }).info("retention.pruned", {
      asOf: now.toISOString(),
      ...pruned,
    });
  },
} satisfies ExportedHandler<Env>;
