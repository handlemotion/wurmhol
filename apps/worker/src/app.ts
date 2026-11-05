import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { type AppEnv, magicLinksOn, requestScope } from "./context.ts";
import { type Config, loadConfig } from "./env.ts";
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

/** Which sign-in buttons the login page shows. */
function signInMethods(config: Config) {
  return {
    google: config.auth.google !== undefined,
    github: config.auth.github !== undefined,
    magicLink: magicLinksOn(config),
  };
}

/** The config the web app reads beyond sign-in: where its Docs links go. */
function appConfig(config: Config) {
  return { docsUrl: config.DOCS_URL };
}

/** JSON for inside a `<script>`: `<` escaped, so no value can close the element. */
const inlineJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/**
 * Serves the web app. Pages (HTML) carry the sign-in methods and the app config inline, as JSON
 * scripts the app reads on its first render, so the login form and the wall paint complete
 * instead of waiting on `/api/sign-in-methods` and `/api/app-config`. A JSON script never
 * executes, so the CSP's `script-src 'self'` holds.
 */
async function serveApp(c: { env: Env; req: { raw: Request } }) {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (!res.headers.get("content-type")?.includes("text/html")) return res;
  const config = loadConfig(c.env);
  const methods = inlineJson(signInMethods(config));
  const app = inlineJson(appConfig(config));
  return new HTMLRewriter()
    .on("head", {
      element(head) {
        head.append(
          `<script id="sign-in-methods" type="application/json">${methods}</script>` +
            `<script id="app-config" type="application/json">${app}</script>`,
          { html: true },
        );
      },
    })
    .transform(res);
}

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
  .get("/api/sign-in-methods", (c) => c.json(signInMethods(c.var.config)))
  /** Public: the app config, for the Vite dev server, whose pages don't carry it inline. */
  .get("/api/app-config", (c) => c.json(appConfig(c.var.config)))
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
  // Development sends no mail: the link comes back in the response, for the login page to show.
  .post("/api/auth/sign-in/magic-link", limitAuth, async (c) => {
    const response = await c.var.auth.handler(c.req.raw);
    const devLink = c.get("devLink");
    if (!devLink || !response.ok) return response;
    return c.json({ ...(await response.json<object>()), devLink });
  })
  .on(["GET", "POST"], "/api/auth/*", limitAuth, (c) => c.var.auth.handler(c.req.raw))
  .route("/api/device", deviceApproval)
  .route("/api", account)
  .route("/api", api)
  .all("/api/*", (c) => c.json({ error: "not found" }, 404))
  // Everything else is the web app: a file from its build, or index.html for its routes.
  .all("*", (c) => serveApp(c))
  .onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    (c.var.log ?? createLogger()).error("http.error", { error, orgId: c.var.member?.orgId });
    return c.json({ error: "internal error", requestId: c.var.requestId }, 500);
  });

export type AppType = typeof app;
