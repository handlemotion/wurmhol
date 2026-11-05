import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { type AppEnv, magicLinksOn, requestScope } from "./context.ts";
import { createLogger, REQUEST_ID_HEADER, requestIdFrom } from "./log.ts";
import { limitAuth } from "./rate-limiter.ts";
import { account, api } from "./routes/api.ts";
import { connect } from "./routes/connect.ts";
import { deviceApproval, deviceFlow } from "./routes/device.ts";
import { open } from "./routes/open.ts";
import { pipes } from "./routes/pipes.ts";
import { securityHeaders } from "./security-headers.ts";

/**
 * One ID per request: the caller's `x-request-id` when well-formed, else a fresh one. Logs the
 * route pattern, never the URL: query strings carry one-time codes.
 */
const trace = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = requestIdFrom(c.req.header(REQUEST_ID_HEADER));
  const log = createLogger({ component: "api", requestId });
  c.set("requestId", requestId);
  c.set("log", log);
  const started = Date.now();
  try {
    await next();
  } finally {
    try {
      c.res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      // Immutable headers (a websocket upgrade): the log still has it.
    }
    log.info("http.request", {
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      durationMs: Date.now() - started,
      orgId: c.var.member?.orgId,
    });
  }
});

/** The app's host: the console, its API, `/connect`, `/device/*` and `/v1`. Share hosts never reach this (index.ts). */
export const app = new Hono<AppEnv>()
  .use(trace)
  .get("/health", (c) => c.json({ ok: true }))
  .use("/connect", requestScope)
  .route("/connect", connect)
  .use("/device/*", requestScope)
  .route("/device", deviceFlow)
  .use("/v1/*", requestScope, securityHeaders)
  .route("/v1/pipes", pipes)
  .all("/v1/*", (c) => c.json({ error: "not found" }, 404))
  .use("/open", requestScope, securityHeaders)
  .route("/open", open)
  .use("/api/*", requestScope, securityHeaders)
  /** Public: which sign-in buttons the login page shows. */
  .get("/api/sign-in-methods", (c) => {
    const { auth } = c.var.config;
    return c.json({
      google: auth.google !== undefined,
      github: auth.github !== undefined,
      magicLink: magicLinksOn(c.var.config),
    });
  })
  // Stripe calls this, not a browser: no per-IP auth limit. The plugin verifies the signature.
  .post("/api/auth/stripe/webhook", (c) => c.var.auth.handler(c.req.raw))
  // Checkout and the portal go through /api/billing, which pins them to the active org and to
  // owners. The plugin's own POSTs would let anyone subscribe for themselves, so they are closed.
  .post("/api/auth/subscription/*", (c) => c.json({ error: "use /api/billing" }, 404))
  // The device flow goes through /device and /api/device: the plugin's own token endpoint hands
  // out a full session, and its approve route records no org.
  .on(["GET", "POST"], ["/api/auth/device", "/api/auth/device/*"], (c) =>
    c.json({ error: "use /api/device" }, 404),
  )
  .on(["GET", "POST"], "/api/auth/*", limitAuth, (c) => c.var.auth.handler(c.req.raw))
  .route("/api/device", deviceApproval)
  .route("/api", account)
  .route("/api", api)
  .all("/api/*", (c) => c.json({ error: "not found" }, 404))
  // Everything else is the web app: a file from its build, or index.html for its routes.
  .all("*", (c) => c.env.ASSETS.fetch(c.req.raw))
  .onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    (c.var.log ?? createLogger()).error("http.error", { error, orgId: c.var.member?.orgId });
    return c.json({ error: "internal error", requestId: c.var.requestId }, 500);
  });

export type AppType = typeof app;
