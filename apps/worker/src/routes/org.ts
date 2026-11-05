// Org settings (spec section 3, header menu and Members dialog): start a new org, rename, change a
// member's role, hand ownership over, leave, delete. Each goes through Better Auth's organization plugin, which
// keeps its own checks (owners only; an org never loses its last owner). These routes add what
// Wurmhol needs around them: only our two roles, nobody left without an org, no deleting an org
// that is still paying, its open pipes ended first, and departing members' machines disconnected.
import { zValidator } from "@hono/zod-validator";
import { APIError, ROLES } from "@wurmhol/auth";
import { listOrgsForUser, orgSubscription } from "@wurmhol/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, requireOwner } from "../context.ts";
import { limitPerMember } from "../rate-limiter.ts";

/** Runs a plugin call, turning its refusals into ours: its 400s (a rule it holds) are 409s. */
async function plugin<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    const status = ([401, 403, 404] as const).find((s) => s === error.statusCode) ?? 409;
    throw new HTTPException(status, {
      message: (error.body as { message?: string } | undefined)?.message ?? error.message,
    });
  }
}

/** Leaving or deleting the caller's only org would leave them in none, with no way back in. */
async function refuseLastOrg(c: { var: AppEnv["Variables"] }, verb: string) {
  if ((await listOrgsForUser(c.var.db, c.var.user.id)).length <= 1) {
    throw new HTTPException(409, { message: `This is your only org, so you can’t ${verb} it.` });
  }
}

/** An org's name, new or changed. */
const renameBody = z.object({ name: z.string().trim().min(1).max(80) });
const roleBody = z.object({ role: z.enum(ROLES) });

export const org = new Hono<AppEnv>()
  /**
   * Starts another org with the caller as its owner, and makes it their active one. The slug is
   * the plugin's unique key, not shown anywhere, so it is random rather than taken from the name.
   */
  .post("/orgs", limitPerMember("manage"), zValidator("json", renameBody), async (c) => {
    const created = await plugin(
      c.var.auth.api.createOrganization({
        headers: c.req.raw.headers,
        body: { name: c.req.valid("json").name, slug: `org-${crypto.randomUUID()}` },
      }),
    );
    if (!created) throw new HTTPException(500, { message: "could not create the org" });
    c.var.log.info("org.created", { orgId: created.id });
    return c.json({ id: created.id });
  })
  .patch("/org", requireOwner, limitPerMember("manage"), zValidator("json", renameBody), (c) =>
    plugin(
      c.var.auth.api.updateOrganization({
        headers: c.req.raw.headers,
        body: { organizationId: c.var.member.orgId, data: { name: c.req.valid("json").name } },
      }),
    ).then(() => c.json({ ok: true })),
  )
  /** Owner or member. Demoting yourself as the last owner is refused by the plugin. */
  .post(
    "/members/:id/role",
    requireOwner,
    limitPerMember("manage"),
    zValidator("json", roleBody),
    async (c) => {
      await plugin(
        c.var.auth.api.updateMemberRole({
          headers: c.req.raw.headers,
          body: {
            organizationId: c.var.member.orgId,
            memberId: c.req.param("id"),
            role: c.req.valid("json").role,
          },
        }),
      );
      return c.json({ ok: true });
    },
  )
  /** Hands the org over: they become an owner, then you a member. */
  .post("/members/:id/transfer", requireOwner, limitPerMember("manage"), async (c) => {
    const memberId = c.req.param("id");
    if (memberId === c.var.member.id) {
      throw new HTTPException(409, { message: "You already own this org." });
    }
    const body = { organizationId: c.var.member.orgId };
    await plugin(
      c.var.auth.api.updateMemberRole({
        headers: c.req.raw.headers,
        body: { ...body, memberId, role: "owner" },
      }),
    );
    await plugin(
      c.var.auth.api.updateMemberRole({
        headers: c.req.raw.headers,
        body: { ...body, memberId: c.var.member.id, role: "member" },
      }),
    );
    c.var.log.info("org.transferred", { orgId: c.var.member.orgId });
    return c.json({ ok: true });
  })
  /** Any member may leave; the last owner may not (the plugin refuses). Their machines go too. */
  .post("/org/leave", limitPerMember("manage"), async (c) => {
    const orgId = c.var.member.orgId;
    await refuseLastOrg(c, "leave");
    await plugin(
      c.var.auth.api.leaveOrganization({
        headers: c.req.raw.headers,
        body: { organizationId: orgId },
      }),
    );
    await c.env.ORG.get(c.env.ORG.idFromName(orgId)).dropUser(c.var.user.id);
    return c.json({ ok: true });
  })
  /**
   * Deletes the org with its tokens, pipes and history. Its open pipes end first, so no CLI keeps
   * serving an org that is gone, and its machines are disconnected. A paid plan must be cancelled first: Stripe would go on billing.
   */
  .delete("/org", requireOwner, limitPerMember("manage"), async (c) => {
    const orgId = c.var.member.orgId;
    await refuseLastOrg(c, "delete");
    if (c.var.config.auth.billing && (await orgSubscription(c.var.db, orgId))) {
      throw new HTTPException(409, {
        message: "Cancel the plan in Billing first, then delete the org.",
      });
    }
    const orgObject = c.env.ORG.get(c.env.ORG.idFromName(orgId));
    const open = await orgObject.list();
    for (const share of open) {
      await c.env.SHARE.get(c.env.SHARE.idFromName(share.id)).terminate("terminated");
    }
    await plugin(
      c.var.auth.api.deleteOrganization({
        headers: c.req.raw.headers,
        body: { organizationId: orgId },
      }),
    );
    // After the delete, so a machine that reconnects meanwhile finds its token gone.
    await orgObject.dropAll();
    c.var.log.info("org.deleted", { orgId });
    return c.json({ ok: true });
  });
