// `/v1/pipes`: the org's open pipes for orchestrators (ADR 0008), on the CLI's host with a bearer
// token of scope `org`. The same cards and the same Terminate as the wall.
import { findShare } from "@wurmhol/db";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { type BearerToken, bearerToken, refuse } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { SHARE_ID } from "../env.ts";
import { orgStub } from "../org-do.ts";
import { shareStub } from "../share-do.ts";

type PipesEnv = AppEnv & { Variables: { token: BearerToken } };

/** A live `org` token, or the refusal. */
const requireOrgToken = createMiddleware<PipesEnv>(async (c, next) => {
  const token = await bearerToken(c);
  if (token instanceof Response) return token;
  if (token.scope !== "org") {
    return refuse(
      403,
      "token scope",
      `This token can only open pipes. Create one that can list and close every pipe in the org at ${c.var.config.auth.baseURL} (menu → Tokens).`,
    );
  }
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
    const id = c.req.param("id");
    const share = SHARE_ID.test(id) ? await findShare(c.var.db, id) : null;
    if (!share || share.orgId !== c.var.token.orgId) {
      return refuse(404, "pipe not found", "List the org's open pipes with GET /v1/pipes.");
    }
    await shareStub(c.env, share.id).terminate("terminated");
    c.var.log.info("share.terminated", { shareId: share.id, orgId: share.orgId });
    return c.json({ ok: true });
  });
