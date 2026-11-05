import { app } from "./app.ts";
import { loadConfig, shareIdFromHost } from "./env.ts";
import { createLogger } from "./log.ts";
import { handleShareHost } from "./viewer.ts";

export type { AppType } from "./app.ts";
export { Org } from "./org-do.ts";
export { RateLimiter } from "./rate-limiter.ts";
export { Share } from "./share-do.ts";

export default {
  /** `<id>.on.wurmhol.com` is a share; every other host is the app. */
  async fetch(request, env, ctx) {
    const shareId = shareIdFromHost(loadConfig(env), request.headers.get("host"));
    if (shareId === null) return app.fetch(request, env, ctx);
    try {
      return await handleShareHost(request, env, shareId);
    } catch (error) {
      createLogger({ component: "viewer" }).error("viewer.error", { error, shareId });
      return new Response("internal error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
