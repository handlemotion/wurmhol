// `GET /open?share=<id>&next=<path>` (spec section 6, step 2): a viewer arriving from a share
// host. Signed in as a member of the share's org, they go back with a one-time code; otherwise
// to the login page, never to the app or the share.
import { findMember, findShare } from "@wurmhol/db";
import { Hono } from "hono";
import { type AppEnv, resolveSession } from "../context.ts";
import { shareOrigin, SHARE_ID } from "../env.ts";
import { errorPage } from "../pages.ts";
import { sameOriginPath } from "@wurmhol/protocol";
import { RESERVED_PREFIX } from "../viewer.ts";

export const open = new Hono<AppEnv>().get("/", async (c) => {
  const shareId = c.req.query("share") ?? "";
  const next = sameOriginPath(c.req.query("next"));
  if (!SHARE_ID.test(shareId)) return errorPage(404, "This pipe has ended.");
  const share = await findShare(c.var.db, shareId);
  if (!share || share.endedAt) return errorPage(410, "This pipe has ended.");

  const here = `/open?${new URLSearchParams({ share: shareId, next })}`;
  const login = (reason?: string) => {
    const params = new URLSearchParams({ next: here });
    if (reason) params.set("reason", reason);
    return c.redirect(`/login?${params}`, 302);
  };
  const session = await resolveSession(c);
  if (!session) return login();
  // Any of the user's orgs may own it, not only the active one.
  if (!(await findMember(c.var.db, session.user.id, share.orgId))) return login("not-member");

  const stub = c.env.SHARE.get(c.env.SHARE.idFromName(shareId));
  const code = await stub.issueCode(session.user.id);
  const target = new URL(`${RESERVED_PREFIX}auth`, shareOrigin(c.var.config, shareId));
  target.searchParams.set("code", code);
  target.searchParams.set("next", next);
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.redirect(target.toString(), 302);
});
