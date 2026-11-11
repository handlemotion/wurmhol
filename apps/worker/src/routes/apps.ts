// `/api/apps`: embedded mode's applications and their integration keys (ADR 0032), for an org's
// owners in the console. Lifecycle and settings only: nothing here opens a tunnel or reads its
// traffic. Off unless `EMBEDDED_ENABLED`; with billing on, only for orgs on Business.
import { zValidator } from "@hono/zod-validator";
import {
  createEmbedApp,
  createEmbedAppKey,
  deleteEmbedApp,
  deleteEmbedTunnels,
  embedTunnelIdsOfApp,
  findEmbedApp,
  listEmbedAppKeys,
  listEmbedApps,
  revokeEmbedAppKey,
  revokeEmbedGrants,
  updateEmbedApp,
} from "@wurmhol/db";
import { EMBED_PERMISSIONS, embedPermissions } from "@wurmhol/protocol";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, requireOwner } from "../context.ts";
import { endTunnelSessions } from "../ending.ts";
import { orgPlan } from "../plan.ts";
import { limitPerMember } from "../rate-limiter.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORIGINS = 20;

/** Plain http only for a local development host; everything else https. */
function isLocalHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

function secureUrl(value: string) {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  const ok = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  return ok && !url.username && !url.password ? url : null;
}

/** Where the SaaS signs its user in again: an https URL (http on localhost), no credentials. */
const launchUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => secureUrl(value) !== null, "use an https URL")
  .transform((value) => secureUrl(value)!.toString());

/** A page origin, exactly: scheme, host and port, no path. */
const origin = z
  .string()
  .trim()
  .max(255)
  .refine((value) => {
    const url = secureUrl(value);
    return url !== null && url.origin === value.replace(/\/$/, "");
  }, "use an origin like https://app.example.com, with no path")
  .transform((value) => secureUrl(value)!.origin);

const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();

const settingsShape = {
  name: z.string().trim().min(1).max(80),
  launchUrl: launchUrl.nullable(),
  allowedOrigins: z.array(origin).max(MAX_ORIGINS),
  monthlyRequests: limit,
  activeTunnels: limit,
  tenantMonthlyRequests: limit,
  tenantActiveTunnels: limit,
};

/** A tenant's default may not exceed the application's own limit. */
function tenantWithinApp(settings: {
  monthlyRequests?: number | null;
  activeTunnels?: number | null;
  tenantMonthlyRequests?: number | null;
  tenantActiveTunnels?: number | null;
}) {
  const within = (tenant?: number | null, app?: number | null) =>
    tenant === null || tenant === undefined || app === null || app === undefined || tenant <= app;
  return (
    within(settings.tenantMonthlyRequests, settings.monthlyRequests) &&
    within(settings.tenantActiveTunnels, settings.activeTunnels)
  );
}
const TENANT_OVER_APP = "a tenant's default can't be more than the application's limit";

const createBody = z
  .object({
    name: settingsShape.name,
    launchUrl: settingsShape.launchUrl.default(null),
    allowedOrigins: settingsShape.allowedOrigins.default([]),
    monthlyRequests: limit.default(null),
    activeTunnels: limit.default(null),
    tenantMonthlyRequests: limit.default(null),
    tenantActiveTunnels: limit.default(null),
  })
  .refine(tenantWithinApp, TENANT_OVER_APP);

const updateBody = z.object(settingsShape).partial();

const keyBody = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z
    .array(z.enum(EMBED_PERMISSIONS))
    .min(1)
    .transform((values) => embedPermissions(values)!),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(null),
});

/** Embedded mode is off on this install: the routes do not exist. */
const requireEmbedded = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.config.EMBEDDED_ENABLED) throw new HTTPException(404, { message: "not found" });
  await next();
});

/** The org may use embedded mode: billing off, or a Business plan in good standing. */
const requireBusiness = createMiddleware<AppEnv>(async (c, next) => {
  const { config, db, member } = c.var;
  const plan = await orgPlan(db, config, member.orgId);
  if (!plan || (config.auth.billing && plan.plan !== "business")) {
    throw new HTTPException(402, {
      message: "Applications are part of Business. An owner can move the org to it in Billing.",
    });
  }
  await next();
});

async function ownApp(c: { var: AppEnv["Variables"] }, appId: string) {
  const app = await findEmbedApp(c.var.db, c.var.member.orgId, appId);
  if (!app) throw new HTTPException(404, { message: "no such application" });
  return app;
}

export const apps = new Hono<AppEnv>()
  .use(requireEmbedded, requireOwner, requireBusiness)
  .get("/", async (c) => c.json({ apps: await listEmbedApps(c.var.db, c.var.member.orgId) }))
  .post("/", limitPerMember("manage"), zValidator("json", createBody), async (c) => {
    const app = await createEmbedApp(c.var.db, c.var.member.orgId, c.req.valid("json"));
    c.var.log.info("embed.app_created", { orgId: c.var.member.orgId, appId: app.id });
    return c.json({ app }, 201);
  })
  .get("/:id", async (c) => c.json({ app: await ownApp(c, c.req.param("id")) }))
  .patch("/:id", limitPerMember("manage"), zValidator("json", updateBody), async (c) => {
    const current = await ownApp(c, c.req.param("id"));
    const change = c.req.valid("json");
    if (!tenantWithinApp({ ...current, ...change })) {
      throw new HTTPException(400, { message: TENANT_OVER_APP });
    }
    const app = await updateEmbedApp(c.var.db, c.var.member.orgId, current.id, change);
    if (!app) throw new HTTPException(404, { message: "no such application" });
    return c.json({ app });
  })
  /** Deletes the application, revokes its keys, and ends and deletes its tunnels. */
  .delete("/:id", limitPerMember("manage"), async (c) => {
    const appId = c.req.param("id");
    const orgId = c.var.member.orgId;
    const tunnels = await embedTunnelIdsOfApp(c.var.db, orgId, appId);
    if (!(await deleteEmbedApp(c.var.db, orgId, appId))) {
      throw new HTTPException(404, { message: "no such application" });
    }
    await deleteEmbedTunnels(c.var.db, orgId, tunnels);
    await revokeEmbedGrants(c.var.db, orgId, { tunnelIds: tunnels });
    await endTunnelSessions(c, tunnels, "revoked", "embed delete");
    c.var.log.info("embed.app_deleted", { orgId: c.var.member.orgId, appId });
    return c.json({ ok: true });
  })
  .get("/:id/keys", async (c) => {
    const app = await ownApp(c, c.req.param("id"));
    return c.json({ keys: await listEmbedAppKeys(c.var.db, c.var.member.orgId, app.id) });
  })
  /** A new integration key, shown once. It belongs to the application, not to its maker. */
  .post("/:id/keys", limitPerMember("manage"), zValidator("json", keyBody), async (c) => {
    const app = await ownApp(c, c.req.param("id"));
    const { name, permissions, expiresInDays } = c.req.valid("json");
    const { id, key } = await createEmbedAppKey(c.var.db, {
      orgId: c.var.member.orgId,
      appId: app.id,
      name,
      permissions,
      createdBy: c.var.user.id,
      expiresAt: expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY_MS),
    });
    c.var.log.info("embed.key_created", { orgId: c.var.member.orgId, appId: app.id, keyId: id });
    return c.json({ id, key, permissions }, 201);
  })
  .delete("/:id/keys/:keyId", limitPerMember("manage"), async (c) => {
    const app = await ownApp(c, c.req.param("id"));
    const keyId = c.req.param("keyId");
    if (!(await revokeEmbedAppKey(c.var.db, c.var.member.orgId, app.id, keyId))) {
      throw new HTTPException(404, { message: "no such key" });
    }
    c.var.log.info("embed.key_revoked", { orgId: c.var.member.orgId, appId: app.id, keyId });
    return c.json({ ok: true });
  });
