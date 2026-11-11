// `/v1/embed`: what a SaaS's backend does with its integration key (`whk_`, ADR 0032). Tenants
// and subjects named by the SaaS's own ids, tunnels for them, who may be granted each tunnel, and
// the connectors their agents open them with. Lifecycle and health only: nothing here reads a
// tunnel's traffic, and an embedded session never reaches the wall or the org's pipes API.
import { zValidator } from "@hono/zod-validator";
import {
  addEmbedTunnelAccess,
  createEmbedConnector,
  createEmbedTunnel,
  deleteEmbedTunnels,
  embedTunnelIdsOf,
  type EmbedScope,
  findEmbedSubject,
  findEmbedTenant,
  findEmbedTunnel,
  isOrgBlocked,
  latestSharesOfTunnels,
  listEmbedTunnelAccess,
  listEmbedTunnels,
  openSharesOfTunnels,
  putEmbedSubject,
  putEmbedTenant,
  removeEmbedSubjectAccess,
  removeEmbedTunnelAccess,
  revokeEmbedConnectors,
  setEmbedTunnelStopped,
  useEmbedAppKey,
} from "@wurmhol/db";
import {
  CONNECTOR_TTL,
  embedCredentialKind,
  type EmbedPermission,
  embedTtlSeconds,
  SUBJECT_KINDS,
} from "@wurmhol/protocol";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { refuse } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { endShare, endTunnelSessions } from "../ending.ts";
import { shareOrigin } from "../env.ts";
import { orgPlan } from "../plan.ts";
import { checkRateLimit } from "../rate-limiter.ts";
import { shareStub } from "../share-do.ts";

interface EmbedKey extends EmbedScope {
  keyId: string;
  permissions: EmbedPermission[];
}

type EmbedEnv = AppEnv & { Variables: { key: EmbedKey } };

/** The SaaS's own id for a tenant or subject: printable ASCII, no spaces, at most 200. */
const EXTERNAL_ID = /^[\x21-\x7e]{1,200}$/;
const externalId = z.string().regex(EXTERNAL_ID, "use 1 to 200 printable characters, no spaces");

/** The live integration key on the request, of an org that may use embedded mode. */
const requireKey = createMiddleware<EmbedEnv>(async (c, next) => {
  const { config, db } = c.var;
  if (!config.EMBEDDED_ENABLED) return c.json({ error: "not found" }, 404);
  const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  if (embedCredentialKind(presented) !== "key") {
    return refuse(401, "key missing", "Send the application's integration key (whk_…).");
  }
  const key = await useEmbedAppKey(db, presented);
  if (!key.ok) {
    return key.reason === "expired"
      ? refuse(401, "key expired", "This key expired. An owner makes a new one in the console.")
      : refuse(401, "key revoked or unknown", "An owner makes a new key in the console.");
  }
  if (await isOrgBlocked(db, key.orgId)) {
    return refuse(401, "org blocked", `Contact the operator of ${config.auth.baseURL}.`);
  }
  const plan = await orgPlan(db, config, key.orgId);
  if (!plan || (config.auth.billing && plan.plan !== "business")) {
    return refuse(402, "no subscription", "Embedded tunnels need the org on Business.");
  }
  const wait = await checkRateLimit(c.env, config, "manage", key.keyId);
  if (wait) {
    return refuse(429, "too many requests", `Wait ${wait} s and try again.`, { retryAfter: wait });
  }
  c.set("key", key);
  await next();
});

/** The key holds `permission`. Lifecycle and traffic are separate permissions. */
const can = (permission: EmbedPermission) =>
  createMiddleware<EmbedEnv>(async (c, next) => {
    if (!c.var.key.permissions.includes(permission)) {
      return refuse(403, "key permission", `This key cannot ${permission}. Use one that can.`);
    }
    await next();
  });

function notFound(what: string) {
  return refuse(404, `${what} not found`, `No ${what} has that id in this application.`);
}

async function tenantOf(c: { var: EmbedEnv["Variables"] }, id: string) {
  return EXTERNAL_ID.test(id) ? findEmbedTenant(c.var.db, c.var.key, id) : undefined;
}

/** An enabled subject of an enabled tenant, by the SaaS's ids. */
async function liveSubject(c: { var: EmbedEnv["Variables"] }, tenantId: string, id: string) {
  if (!EXTERNAL_ID.test(id)) return undefined;
  const subject = await findEmbedSubject(c.var.db, c.var.key, tenantId, id);
  return subject && !subject.disabledAt ? subject : undefined;
}

type Tunnel = NonNullable<Awaited<ReturnType<typeof findEmbedTunnel>>>;

/** Tunnels as the integration sees them: lifecycle and health, never their pages. */
async function describeTunnels(c: { env: Env; var: EmbedEnv["Variables"] }, tunnels: Tunnel[]) {
  const latest = await latestSharesOfTunnels(
    c.var.db,
    tunnels.map((tunnel) => tunnel.id),
  );
  return Promise.all(
    tunnels.map(async (tunnel) => {
      const session = latest.get(tunnel.id);
      const open = session && !session.endedAt;
      const health = open ? await shareStub(c.env, session.id).health() : null;
      const state = health
        ? health.state
        : tunnel.stoppedAt
          ? "stopped"
          : session
            ? "ended"
            : "never";
      return {
        id: tunnel.id,
        url: shareOrigin(c.var.config, { id: tunnel.id, name: tunnel.name }),
        tenant: tunnel.tenant,
        owner: tunnel.owner,
        state,
        createdAt: tunnel.createdAt.toISOString(),
        stoppedAt: tunnel.stoppedAt?.toISOString() ?? null,
        session:
          health && session
            ? {
                id: session.id,
                startedAt: session.startedAt.toISOString(),
                liveSince: health.liveSince ? new Date(health.liveSince).toISOString() : null,
                awaySince: health.awaySince ? new Date(health.awaySince).toISOString() : null,
                lastRequestAt: health.lastRequestAt
                  ? new Date(health.lastRequestAt).toISOString()
                  : null,
                bytes: health.bytes,
              }
            : null,
        lastEnd:
          session?.endedAt && !health
            ? { reason: session.endReason, at: session.endedAt.toISOString() }
            : null,
      };
    }),
  );
}

/** Ends the tunnels' sessions and deletes them for good. */
async function deleteTunnels(c: { env: Env; var: EmbedEnv["Variables"] }, tunnelIds: string[]) {
  await deleteEmbedTunnels(c.var.db, c.var.key.orgId, tunnelIds);
  await endTunnelSessions(c, tunnelIds, "revoked", "embed delete");
}

const tenantBody = z.object({ disabled: z.boolean().optional() }).default({});
const subjectBody = z.object({ kind: z.enum(SUBJECT_KINDS), disabled: z.boolean().optional() });
const tunnelBody = z.object({
  tenant: externalId,
  owner: externalId,
  access: z.array(externalId).max(100).default([]),
  connectorTtlSeconds: z.number().int().optional(),
});
const connectorBody = z
  .object({ rotate: z.boolean().default(false), ttlSeconds: z.number().int().optional() })
  .default({ rotate: false });

/** A connector's expiry from a requested lifetime, or null when it is out of bounds. */
function connectorExpiry(requested: number | undefined) {
  const seconds = embedTtlSeconds(requested, CONNECTOR_TTL);
  return seconds === null ? null : new Date(Date.now() + seconds * 1000);
}

function badTtl() {
  return refuse(
    400,
    "bad ttl",
    `Pass a lifetime from 60 seconds to ${CONNECTOR_TTL.max / 86_400} days, in seconds.`,
  );
}

export const embed = new Hono<EmbedEnv>()
  .use(requireKey)
  /** Makes or updates a tenant; `disabled` ends its sessions and refuses its connectors. */
  .put("/tenants/:tenant", can("subjects:manage"), zValidator("json", tenantBody), async (c) => {
    const id = c.req.param("tenant");
    if (!EXTERNAL_ID.test(id))
      return refuse(400, "bad tenant id", "Use 1 to 200 printable characters.");
    const { disabled } = c.req.valid("json");
    const tenant = await putEmbedTenant(c.var.db, c.var.key, id, disabled);
    if (disabled) {
      await endTunnelSessions(
        c,
        await embedTunnelIdsOf(c.var.db, c.var.key, { tenantId: tenant.id }),
        "revoked",
        "embed stop",
      );
    }
    return c.json({ tenant: { id: tenant.externalId, disabled: tenant.disabledAt !== null } });
  })
  /** Disables a tenant and deletes its tunnels. */
  .delete("/tenants/:tenant", can("subjects:manage"), async (c) => {
    const tenant = await tenantOf(c, c.req.param("tenant"));
    if (!tenant) return notFound("tenant");
    await putEmbedTenant(c.var.db, c.var.key, tenant.externalId, true);
    await deleteTunnels(c, await embedTunnelIdsOf(c.var.db, c.var.key, { tenantId: tenant.id }));
    return c.json({ ok: true });
  })
  .put(
    "/tenants/:tenant/subjects/:subject",
    can("subjects:manage"),
    zValidator("json", subjectBody),
    async (c) => {
      const tenant = await tenantOf(c, c.req.param("tenant"));
      if (!tenant || tenant.disabledAt) return notFound("tenant");
      const id = c.req.param("subject");
      if (!EXTERNAL_ID.test(id)) {
        return refuse(400, "bad subject id", "Use 1 to 200 printable characters.");
      }
      const result = await putEmbedSubject(c.var.db, c.var.key, tenant.id, id, c.req.valid("json"));
      if (result.conflict) {
        return refuse(409, "subject kind", "This subject exists with the other kind.");
      }
      const { subject } = result;
      if (subject.disabledAt) {
        const owned = await embedTunnelIdsOf(c.var.db, c.var.key, { ownerSubjectId: subject.id });
        await endTunnelSessions(c, owned, "revoked", "embed stop");
      }
      return c.json({
        subject: {
          id: subject.externalId,
          tenant: tenant.externalId,
          kind: subject.kind,
          disabled: subject.disabledAt !== null,
        },
      });
    },
  )
  /** Disables a subject, takes it off every access list, and deletes the tunnels it owns. */
  .delete("/tenants/:tenant/subjects/:subject", can("subjects:manage"), async (c) => {
    const tenant = await tenantOf(c, c.req.param("tenant"));
    if (!tenant) return notFound("tenant");
    const subject = EXTERNAL_ID.test(c.req.param("subject"))
      ? await findEmbedSubject(c.var.db, c.var.key, tenant.id, c.req.param("subject"))
      : undefined;
    if (!subject) return notFound("subject");
    await putEmbedSubject(c.var.db, c.var.key, tenant.id, subject.externalId, {
      kind: subject.kind,
      disabled: true,
    });
    await removeEmbedSubjectAccess(c.var.db, c.var.key.orgId, subject.id);
    await deleteTunnels(
      c,
      await embedTunnelIdsOf(c.var.db, c.var.key, { ownerSubjectId: subject.id }),
    );
    return c.json({ ok: true });
  })
  /** A new tunnel for a tenant, owned by one of its subjects, with its first connector. */
  .post("/tunnels", can("tunnels:manage"), zValidator("json", tunnelBody), async (c) => {
    const body = c.req.valid("json");
    const tenant = await tenantOf(c, body.tenant);
    if (!tenant || tenant.disabledAt) return notFound("tenant");
    const owner = await liveSubject(c, tenant.id, body.owner);
    if (!owner) return notFound("subject");
    const access: string[] = [];
    for (const id of body.access) {
      const subject = await liveSubject(c, tenant.id, id);
      // A subject of another tenant is not found here: a tunnel's list never crosses tenants.
      if (!subject) return notFound("subject");
      access.push(subject.id);
    }
    const expiresAt = connectorExpiry(body.connectorTtlSeconds);
    if (!expiresAt) return badTtl();
    const { tunnel, connector } = await createEmbedTunnel(c.var.db, c.var.key, {
      tenantId: tenant.id,
      ownerSubjectId: owner.id,
      access,
      connectorExpiresAt: expiresAt,
    });
    c.var.log.info("embed.tunnel_created", {
      orgId: c.var.key.orgId,
      appId: c.var.key.appId,
      tunnelId: tunnel.id,
    });
    const [described] = await describeTunnels(c, [tunnel]);
    return c.json(
      {
        tunnel: described,
        connector: {
          id: connector.id,
          connector: connector.connector,
          expiresAt: connector.expiresAt.toISOString(),
        },
      },
      201,
    );
  })
  /** The application's tunnels, of a tenant, or that one of its subjects may be granted. */
  .get("/tunnels", can("tunnels:read"), async (c) => {
    const tenantId = c.req.query("tenant");
    const subjectId = c.req.query("subject");
    if (subjectId !== undefined && tenantId === undefined) {
      return refuse(400, "tenant missing", "Pass tenant with subject: a subject is a tenant's.");
    }
    let filter: { tenantId?: string; subjectId?: string } = {};
    if (tenantId !== undefined) {
      const tenant = await tenantOf(c, tenantId);
      if (!tenant) return c.json({ tunnels: [] });
      filter = { tenantId: tenant.id };
      if (subjectId !== undefined) {
        const subject = EXTERNAL_ID.test(subjectId)
          ? await findEmbedSubject(c.var.db, c.var.key, tenant.id, subjectId)
          : undefined;
        if (!subject) return c.json({ tunnels: [] });
        filter.subjectId = subject.id;
      }
    }
    const tunnels = await listEmbedTunnels(c.var.db, c.var.key, filter);
    return c.json({ tunnels: await describeTunnels(c, tunnels) });
  })
  .get("/tunnels/:id", can("tunnels:read"), async (c) => {
    const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
    if (!tunnel) return notFound("tunnel");
    const [described] = await describeTunnels(c, [tunnel]);
    const access = await listEmbedTunnelAccess(c.var.db, c.var.key.orgId, tunnel.id);
    return c.json({ tunnel: { ...described, access: access.map((s) => s.externalId) } });
  })
  /** Ends the tunnel's session (`terminated`); its connector may open it again. */
  .post("/tunnels/:id/stop", can("tunnels:manage"), async (c) => {
    const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
    if (!tunnel) return notFound("tunnel");
    await setEmbedTunnelStopped(c.var.db, c.var.key.orgId, tunnel.id, true);
    await endTunnelSessions(c, [tunnel.id], "terminated", "embed stop");
    return c.json({ ok: true });
  })
  /** Ends the tunnel for good: its session, its connectors; its host is never reused. */
  .delete("/tunnels/:id", can("tunnels:manage"), async (c) => {
    const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
    if (!tunnel) return notFound("tunnel");
    await deleteTunnels(c, [tunnel.id]);
    return c.json({ ok: true });
  })
  .put("/tunnels/:id/access/:subject", can("tunnels:manage"), async (c) => {
    const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
    if (!tunnel) return notFound("tunnel");
    const subject = await liveSubject(c, tunnel.tenantId, c.req.param("subject"));
    if (!subject) return notFound("subject");
    await addEmbedTunnelAccess(c.var.db, c.var.key.orgId, tunnel.id, subject.id);
    return c.json({ ok: true });
  })
  .delete("/tunnels/:id/access/:subject", can("tunnels:manage"), async (c) => {
    const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
    if (!tunnel) return notFound("tunnel");
    const id = c.req.param("subject");
    const subject = EXTERNAL_ID.test(id)
      ? await findEmbedSubject(c.var.db, c.var.key, tunnel.tenantId, id)
      : undefined;
    if (!subject) return notFound("subject");
    if (subject.id === tunnel.ownerSubjectId) {
      return refuse(409, "owner", "A tunnel's owner stays on its list. Delete the tunnel instead.");
    }
    if (!(await removeEmbedTunnelAccess(c.var.db, c.var.key.orgId, tunnel.id, subject.id))) {
      return notFound("subject");
    }
    return c.json({ ok: true });
  })
  /** A new connector; `rotate` revokes the others and ends a session they opened. */
  .post(
    "/tunnels/:id/connectors",
    can("tunnels:manage"),
    zValidator("json", connectorBody),
    async (c) => {
      const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
      if (!tunnel) return notFound("tunnel");
      const { rotate, ttlSeconds } = c.req.valid("json");
      const expiresAt = connectorExpiry(ttlSeconds);
      if (!expiresAt) return badTtl();
      const made = await createEmbedConnector(c.var.db, {
        orgId: c.var.key.orgId,
        tunnelId: tunnel.id,
        expiresAt,
      });
      if (rotate) {
        await revokeEmbedConnectors(c.var.db, c.var.key.orgId, tunnel.id, { except: made.id });
        await endTunnelSessions(c, [tunnel.id], "revoked", "connector revoked");
      }
      return c.json(
        {
          connector: {
            id: made.id,
            connector: made.connector,
            expiresAt: made.expiresAt.toISOString(),
          },
        },
        201,
      );
    },
  )
  /** Revokes a connector; a session it opened ends with `revoked`, which its agent stops on. */
  .delete("/tunnels/:id/connectors/:connector", can("tunnels:manage"), async (c) => {
    const tunnel = await findEmbedTunnel(c.var.db, c.var.key, c.req.param("id"));
    if (!tunnel) return notFound("tunnel");
    const connectorId = c.req.param("connector");
    const revoked = await revokeEmbedConnectors(c.var.db, c.var.key.orgId, tunnel.id, {
      id: connectorId,
    });
    if (!revoked) return notFound("connector");
    for (const share of await openSharesOfTunnels(c.var.db, [tunnel.id])) {
      if (share.connectorId === connectorId) {
        await endShare(c, share, "revoked", "connector revoked");
      }
    }
    return c.json({ ok: true });
  });
