// Machines (ADR 0018): `wurmhol host` keeps one WebSocket on `GET /host`, on the CLI's host, and
// reports the ports open on its computer. Its owner's Create pipe card watches them on
// `/api/machines/live` and opens a pipe to one with `POST /api/machines/:id/open`. The Org object
// holds the sockets; a machine belongs to the person whose token it runs on.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { computerName, DEFAULT_COMPUTER_NAME, MAX_PORT } from "@wurmhol/protocol";
import { bearerToken, refuse } from "../bearer.ts";
import { type AppEnv, ownOriginSocket } from "../context.ts";
import { orgStub, toOrg } from "../org-do.ts";
import { limitPerMember } from "../rate-limiter.ts";

/** `GET /host?name=<computer>`: a machine's socket, authenticated by its bearer token. */
export const machineConnect = new Hono<AppEnv>().get("/", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(426, "expected a websocket upgrade", "Run wurmhol host.");
  }

  const token = await bearerToken(c);

  if (token instanceof Response) return token;

  if (!token.createdBy) {
    return refuse(
      401,
      "token has no owner",
      `Whoever made this token has left. Run wurmhol login, or make a token at ${c.var.config.auth.baseURL} (menu → Tokens).`,
    );
  }

  c.var.log.info("machine.connected", { orgId: token.orgId });

  return orgStub(c.env, token.orgId).fetch(
    toOrg(c.req.raw, {
      kind: "machine",
      userId: token.createdBy,
      tokenId: token.id,
      name: computerName(c.req.query("name")) ?? DEFAULT_COMPUTER_NAME,
    }),
  );
});

/** The Create pipe card's calls, as a member of the active org (mounted behind `requireMember`). */
export const machines = new Hono<AppEnv>()
  /** The caller's machines, live. Cookie-authenticated: only our own origins (as `/api/live`). */
  .get("/live", ownOriginSocket, async (c) =>
    orgStub(c.env, c.var.member.orgId).fetch(
      toOrg(c.req.raw, { kind: "watch", userId: c.var.user.id }),
    ),
  )
  /** Opens a pipe on one of the caller's machines, to a port it reported. */
  .post(
    "/:id/open",
    limitPerMember("manage"),
    zValidator("json", z.object({ port: z.number().int().min(1).max(MAX_PORT) })),
    async (c) => {
      const result = await orgStub(c.env, c.var.member.orgId).openPort(
        c.var.user.id,
        c.req.param("id"),
        c.req.valid("json").port,
      );

      if (!result.ok) throw new HTTPException(result.status, { message: result.error });
      c.var.log.info("machine.opened", { orgId: c.var.member.orgId });

      return c.json({ url: result.url });
    },
  );
