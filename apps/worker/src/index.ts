import {
  createDb,
  findActiveDomain,
  findOpenShareByName,
  isOrgBlocked,
  pruneExpired,
} from "@wurmhol/db";
import { app } from "./app.ts";
import { isEmbedTunnelName, SHARE_ID } from "@wurmhol/protocol";
import { hostRole, loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import { handleRelay } from "./oauth-relay.ts";
import { handleEmbeddedHost } from "./embedded-host.ts";
import { errorPage } from "./pages.ts";
import { domainDeps, refreshDomains } from "./domains/service.ts";
import { handleShareHost } from "./viewer.ts";

export type { AppType } from "./app.ts";
export { Org } from "./org-do.ts";
export { RateLimiter } from "./rate-limiter.ts";
export { Share } from "./share-do.ts";

/**
 * The CLI's host answers these, `/v1/pipes`, `/v1/embed` and `/v1/domains` (ADR 0006, ADR 0008,
 * ADR 0018, ADR 0032, ADR 0033): the pipe socket,
 * `wurmhol host`, `wurmhol login`, health, and the hosted MCP server with its protected resource
 * metadata (ADR 0014).
 */
const CLI_PATHS = new Set([
  "/connect",
  "/host",
  "/device/code",
  "/device/token",
  "/health",
  "/mcp",
  "/.well-known/oauth-protected-resource/mcp",
]);

export default {
  /**
   * One Worker, five kinds of host (ADR 0006, ADR 0010): pipes (`<id>.wurmhol.dev`, or `<name>.wurmhol.dev`), the CLI's
   * endpoint (`api.wurmhol.com`: `/connect`, `/device/*`, the `/v1/pipes` and `/v1/embed` APIs and `/health`), aliases that redirect to the app
   * (`app.wurmhol.com`), the app itself (`dirt.wurmhol.com`: console, API, sign-in), and the OAuth callback relay
   * (`oauth.wurmhol.dev`).
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
      if (CLI_PATHS.has(pathname) || /^\/v1\/(pipes|embed|domains)(\/|$)/.test(pathname)) {
        return app.fetch(request, env, ctx);
      }
      return Response.json(
        {
          error: "not found",
          fix: `This host is for the wurmhol CLI. Open ${config.auth.baseURL}.`,
        },
        { status: 404 },
      );
    }
    if (host.role === "app") return app.fetch(request, env, ctx);
    if (host.role === "oauth") return handleRelay(request, env, config);
    if (host.role === "custom") {
      // A customer's hostname (ADR 0030): routed only when the org proved it owns it and
      // Cloudflare serves it, to its pipe name's open pipe. Anything else is not found.
      try {
        const db = createDb(env.DB);
        const domain = await findActiveDomain(db, host.hostname);
        if (!domain || (await isOrgBlocked(db, domain.orgId))) {
          return errorPage(404, "This address is not connected to a pipe.");
        }
        const open = await findOpenShareByName(db, domain.pipeName);
        return await handleShareHost(request, env, open?.id ?? "", host.hostname);
      } catch (error) {
        createLogger({ component: "viewer" }).error("viewer.error", { error, host: host.hostname });
        return new Response("internal error", { status: 500 });
      }
    }
    let shareId = host.label;
    try {
      // A named pipe (ADR 0009): its host serves whichever of the name's pipes is open.
      if (shareId && !SHARE_ID.test(shareId)) {
        shareId = (await findOpenShareByName(createDb(env.DB), shareId))?.id ?? "";
      }
      // An embedded tunnel's host (ADR 0032): grants, never a member's sign-in.
      if (isEmbedTunnelName(host.label ?? "")) {
        return await handleEmbeddedHost(request, env, shareId);
      }
      return await handleShareHost(request, env, shareId);
    } catch (error) {
      createLogger({ component: "viewer" }).error("viewer.error", { error, shareId });
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
    // Custom domains (ADR 0033): expire the unfinished, and notice a CNAME that went away.
    const domains = domainDeps(config, createDb(env.DB));
    if (domains) await refreshDomains(domains);
  },
} satisfies ExportedHandler<Env>;
