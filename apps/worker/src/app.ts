import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { type AppEnv, magicLinksOn, mcpScope, requestScope } from "./context.ts";
import { type Config, loadConfig, mcpResource } from "./env.ts";
import { createLogger, REQUEST_ID_HEADER, requestIdFrom } from "./log.ts";
import { limitAuth } from "./rate-limiter.ts";
import { account, api } from "./routes/api.ts";
import { connect } from "./routes/connect.ts";
import { deviceApproval, deviceFlow } from "./routes/device.ts";
import { domainsConsole, domainsV1 } from "./routes/domains.ts";
import { open } from "./routes/open.ts";
import { githubRoutes } from "./routes/github.ts";
import { machineConnect } from "./routes/machines.ts";
import { serveMcp } from "./routes/mcp.ts";
import { operator } from "./routes/operator.ts";
import { embed } from "./routes/embed.ts";
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

/** The config the web app reads beyond sign-in: where its Docs links go, and whether custom domains are on (ADR 0033). */
function appConfig(config: Config) {
  return { docsUrl: config.DOCS_URL, customDomains: config.customDomains !== undefined };
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

/**
 * The hosted MCP server's resource URL (ADR 0014) when this request's host serves it; else null.
 * With a CLI host, `/mcp` lives there only: a token's audience names one host.
 */
function mcpHere(c: { req: { url: string }; var: AppEnv["Variables"] }) {
  const resource = mcpResource(c.var.config);
  return resource && new URL(resource).host === new URL(c.req.url).host ? resource : null;
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/**
 * The OAuth provider's routes the hosted MCP server needs (ADR 0014): authorize, the consent
 * page's call, the token and revocation endpoints a client calls, a client's public name for the
 * consent page, and the signing keys. The rest (client management, consents, introspection,
 * userinfo, registration, session JWTs) stay closed until something of ours uses them.
 */
const OAUTH_ROUTES = new Set([
  "GET /api/auth/oauth2/authorize",
  "POST /api/auth/oauth2/consent",
  "POST /api/auth/oauth2/token",
  "POST /api/auth/oauth2/revoke",
  "GET /api/auth/oauth2/public-client",
  "GET /api/auth/jwks",
]);

/** The app's host: the console, its API, `/connect`, `/host`, `/device/*`, `/v1` and `/operator`. Share hosts never reach this (index.ts). */
export const app = new Hono<AppEnv>()
  .use(trace)
  .get("/health", (c) => c.json({ ok: true }))
  // The hosted MCP server (ADR 0014). POST only: every request stands alone, so there is no
  // session to resume (GET) or end (DELETE).
  .use("/mcp", mcpScope, securityHeaders)
  .post("/mcp", async (c) => {
    const resource = mcpHere(c);
    return resource ? serveMcp(c, resource) : notFound();
  })
  .all("/mcp", (c) =>
    mcpHere(c)
      ? Response.json({ error: "use POST" }, { status: 405, headers: { allow: "POST" } })
      : notFound(),
  )
  // Its protected resource metadata (RFC 9728), beside it, and the authorization server's
  // metadata (RFC 8414) on the app's host, where people sign in. Better Auth serves both.
  .use("/.well-known/*", mcpScope)
  .get("/.well-known/oauth-protected-resource/mcp", async (c) =>
    mcpHere(c) ? c.var.auth.handler(c.req.raw) : notFound(),
  )
  .get("/.well-known/oauth-authorization-server", async (c) =>
    mcpResource(c.var.config) ? c.var.auth.handler(c.req.raw) : notFound(),
  )
  .all("/.well-known/*", () => notFound())
  // Where the OAuth flow sends someone signed out: the login page, which comes back to authorize
  // once they are in, by any sign-in method. The signature is authorize's own business; dropping
  // `prompt=login` keeps authorize from sending them straight back here.
  .get("/oauth/login", (c) => {
    const query = new URLSearchParams();
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (key !== "sig" && key !== "exp" && !key.startsWith("ba_")) query.append(key, value);
    }
    const prompt = (query.get("prompt") ?? "").split(" ").filter((p) => p && p !== "login");
    if (prompt.length) query.set("prompt", prompt.join(" "));
    else query.delete("prompt");
    const next = `/api/auth/oauth2/authorize?${query}`;
    return c.redirect(`/login?next=${encodeURIComponent(next)}`);
  })
  .use("/connect", requestScope)
  .route("/connect", connect)
  .use("/host", requestScope)
  .route("/host", machineConnect)
  .use("/device/*", requestScope)
  .route("/device", deviceFlow)
  .use("/v1/*", requestScope, securityHeaders)
  .route("/v1/pipes", pipes)
  .route("/v1/embed", embed)
  .route("/v1/domains", domainsV1)
  .all("/v1/*", (c) => c.json({ error: "not found" }, 404))
  .use("/operator/*", requestScope, securityHeaders)
  .route("/operator", operator)
  .all("/operator/*", (c) => c.json({ error: "not found" }, 404))
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
  // Orgs are changed through /api (routes/org.ts), which allows only our two roles, keeps
  // everyone in an org and ends a deleted org's pipes. Switching the active org stays here.
  .post("/api/auth/organization/:action", async (c, next) =>
    c.req.param("action") === "set-active"
      ? next()
      : c.json({ error: "use /api/orgs, /api/org and /api/members" }, 404),
  )
  // The OAuth provider loads for its own routes only (context.ts).
  .use("/api/auth/oauth2/*", mcpScope)
  .use("/api/auth/jwks", mcpScope)
  .on(
    ["GET", "POST"],
    ["/api/auth/oauth2/*", "/api/auth/admin/*", "/api/auth/token", "/api/auth/jwks"],
    async (c, next) => (OAUTH_ROUTES.has(`${c.req.method} ${c.req.path}`) ? next() : notFound()),
  )
  // MCP clients call these from their own servers, many people behind one address, with a code
  // or refresh token that is its own proof: no per-IP sign-in limit.
  .post("/api/auth/oauth2/token", (c) => c.var.auth.handler(c.req.raw))
  .post("/api/auth/oauth2/revoke", (c) => c.var.auth.handler(c.req.raw))
  // Development sends no mail: the link comes back in the response, for the login page to show.
  .post("/api/auth/sign-in/magic-link", limitAuth, async (c) => {
    const response = await c.var.auth.handler(c.req.raw);
    const devLink = c.get("devLink");
    if (!devLink || !response.ok) return response;
    return c.json({ ...(await response.json<object>()), devLink });
  })
  .on(["GET", "POST"], "/api/auth/*", limitAuth, (c) => c.var.auth.handler(c.req.raw))
  .route("/api/device", deviceApproval)
  .route("/api/github", githubRoutes)
  .route("/api/domains", domainsConsole)
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
