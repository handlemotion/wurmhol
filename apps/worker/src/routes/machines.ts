// Machines (ADR 0018): `wurmhol host` keeps one WebSocket on `GET /host`, on the CLI's host, and
// reports the ports open on its computer. Its owner's Create pipe card watches them on
// `/api/machines/live` and opens a pipe to one with `POST /api/machines/:id/open`. The Org object
// holds the sockets; a machine belongs to the person whose token it runs on.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { bearerToken, refuse } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { ORG_SOCKET_HEADERS } from "../org-do.ts";
import { limitPerMember } from "../rate-limiter.ts";

/** The request to forward to the Org object, with only the socket fields this route sets. */
export function toOrg(
  raw: Request,
  fields: Partial<Record<keyof typeof ORG_SOCKET_HEADERS, string>>,
): Request {
  const headers = new Headers(raw.headers);
  for (const name of Object.values(ORG_SOCKET_HEADERS)) headers.delete(name);
  for (const [key, value] of Object.entries(fields)) {
    headers.set(ORG_SOCKET_HEADERS[key as keyof typeof ORG_SOCKET_HEADERS], value);
  }
  return new Request(raw, { headers });
}

const machineName = z.string().trim().min(1).max(80);

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
  const name = machineName.safeParse(c.req.query("name"));
  const org = c.env.ORG.get(c.env.ORG.idFromName(token.orgId));
  c.var.log.info("machine.connected", { orgId: token.orgId });
  return org.fetch(
    toOrg(c.req.raw, {
      kind: "machine",
      userId: token.createdBy,
      tokenId: token.id,
      name: name.success ? name.data : "Computer",
    }),
  );
});

/** The Create pipe card's calls, as a member of the active org (mounted behind `requireMember`). */
export const machines = new Hono<AppEnv>()
  /** The caller's machines, live. Cookie-authenticated: only our own origins (as `/api/live`). */
  .get("/live", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected a websocket upgrade" }, 426);
    }
    const origin = c.req.header("origin");
    const allowed = new Set([
      new URL(c.var.config.auth.baseURL).origin,
      ...c.var.config.auth.trustedOrigins,
    ]);
    if (origin !== undefined && !allowed.has(origin)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    const org = c.env.ORG.get(c.env.ORG.idFromName(c.var.member.orgId));
    return org.fetch(toOrg(c.req.raw, { kind: "watch", userId: c.var.user.id }));
  })
  /** Opens a pipe on one of the caller's machines, to a port it reported. */
  .post(
    "/:id/open",
    limitPerMember("manage"),
    zValidator("json", z.object({ port: z.number().int().min(1).max(65535) })),
    async (c) => {
      const org = c.env.ORG.get(c.env.ORG.idFromName(c.var.member.orgId));
      const result = await org.openPort(c.var.user.id, c.req.param("id"), c.req.valid("json").port);
      if (!result.ok) throw new HTTPException(result.status, { message: result.error });
      c.var.log.info("machine.opened", { orgId: c.var.member.orgId });
      return c.json({ url: result.url });
    },
  );
