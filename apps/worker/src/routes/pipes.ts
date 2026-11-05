// `/v1/pipes`: the org's open pipes for orchestrators (ADR 0008), on the CLI's host with a bearer
// token of scope `org`. The same cards and the same Terminate as the wall.
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { type BearerToken, bearerToken, refuse } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { endShare, shareOfOrg } from "../ending.ts";
import { orgStub } from "../org-do.ts";

type PipesEnv = AppEnv & { Variables: { token: BearerToken } };

const requireOrgToken = createMiddleware<PipesEnv>(async (c, next) => {
  const token = await bearerToken(c, { org: true });
  if (token instanceof Response) return token;
  c.set("token", token);
  await next();
});

export const pipes = new Hono<PipesEnv>()
  .use(requireOrgToken)
  .get("/", async (c) => {
    return c.json({ pipes: await orgStub(c.env, c.var.token.orgId).list() });
  })
  /** Terminate, as from the wall. Another org's pipe does not exist here. */
  .delete("/:id", async (c) => {
    const share = await shareOfOrg(c.var.db, c.var.token.orgId, c.req.param("id"));
    if (!share) {
      return refuse(404, "pipe not found", "List the org's open pipes with GET /v1/pipes.");
    }
    await endShare(c, share, "terminated", "api");
    return c.json({ ok: true });
  });
