// `/v1/domains` on the CLI's host (org-scope token) and `/api/domains` in the console (any member):
// custom domains for branded pipe URLs (ADR 0033). The same handlers answer both; they differ only
// in who the caller is and which org they act for.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { bearerToken } from "../bearer.ts";
import { type AppEnv, requireMember } from "../context.ts";
import {
  add,
  check,
  DomainRefusal,
  domainDeps,
  type DomainDeps,
  domainView,
  get,
  list,
  remove,
} from "../domains/service.ts";
import { checkRateLimit, tooManyRequests } from "../rate-limiter.ts";

type DomainsEnv = AppEnv & {
  Variables: { orgId: string; rateKey: string; domains: DomainDeps };
};

/** The feature is configured, or every call answers that it is off. */
const requireEnabled = createMiddleware<DomainsEnv>(async (c, next) => {
  const deps = domainDeps(c.var.config, c.var.db);
  if (!deps) {
    return c.json(
      {
        error: "custom domains are not enabled on this install",
        fix: "Ask the operator to set CUSTOM_DOMAIN_TARGET (see the self-hosting docs).",
        code: "custom_domains_off",
      },
      404,
    );
  }
  c.set("domains", deps);
  await next();
});

/** Adds, verifies and removes count against the `manage` limit, per member or token. */
const limitChanges = createMiddleware<DomainsEnv>(async (c, next) => {
  if (c.req.method !== "GET") {
    const wait = await checkRateLimit(c.env, c.var.config, "manage", c.var.rateKey);
    if (wait) return tooManyRequests(wait);
  }
  await next();
});

const addBody = z.object({
  hostname: z.string().trim().min(1).max(300),
  pipe: z.string().min(1).max(80),
});

/** What a refusal from the service becomes on the wire. */
function refusal(error: unknown) {
  if (error instanceof DomainRefusal) {
    return Response.json(error.body(), { status: error.status });
  }
  throw error;
}

const endpoints = new Hono<DomainsEnv>()
  .use(requireEnabled, limitChanges)
  .get("/", async (c) => c.json({ domains: await list(c.var.domains, c.var.orgId) }))
  .post("/", zValidator("json", addBody), async (c) => {
    try {
      const row = await add(c.var.domains, c.var.orgId, c.req.valid("json"));
      return c.json({ domain: domainView(c.var.config, row) }, 201);
    } catch (error) {
      return refusal(error);
    }
  })
  .get("/:hostname", async (c) => {
    try {
      const row = await get(c.var.domains, c.var.orgId, c.req.param("hostname"));
      return c.json({ domain: domainView(c.var.config, row) });
    } catch (error) {
      return refusal(error);
    }
  })
  .post("/:hostname/verify", async (c) => {
    try {
      const row = await get(c.var.domains, c.var.orgId, c.req.param("hostname"));
      const checked = await check(c.var.domains, row, { nudge: true });
      return c.json({ domain: domainView(c.var.config, checked) });
    } catch (error) {
      return refusal(error);
    }
  })
  .delete("/:hostname", async (c) => {
    try {
      // Removing one that is already gone is fine (ADR 0033: calls are idempotent).
      const row = await get(c.var.domains, c.var.orgId, c.req.param("hostname")).catch((error) => {
        if (error instanceof DomainRefusal && error.code === "not_found") return null;
        throw error;
      });
      if (row) await remove(c.var.domains, row);
      return c.json({ ok: true });
    } catch (error) {
      return refusal(error);
    }
  });

/** `/v1/domains`: a bearer token of scope `org`. */
export const domainsV1 = new Hono<DomainsEnv>()
  .use(
    createMiddleware<DomainsEnv>(async (c, next) => {
      const token = await bearerToken(c, { org: true });
      if (token instanceof Response) return token;
      c.set("orgId", token.orgId);
      c.set("rateKey", token.id);
      await next();
    }),
  )
  .route("/", endpoints);

/** `/api/domains`: the console, as a member of the active org. Mount after `requireMember`. */
export const domainsConsole = new Hono<DomainsEnv>()
  .use(requireMember)
  .use(
    createMiddleware<DomainsEnv>(async (c, next) => {
      c.set("orgId", c.var.member.orgId);
      c.set("rateKey", c.var.member.id);
      await next();
    }),
  )
  .route("/", endpoints);
