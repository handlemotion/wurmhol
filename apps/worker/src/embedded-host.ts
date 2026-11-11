// Requests to an embedded tunnel's host, `e<15>.<pipe domain>` (ADR 0032). Its users have no
// Wurmhol account: a request opens it with a grant only, never a member's cookie or an access
// key. A browser's grant arrives through a one-time launch code that this swaps for a grant
// cookie; a program sends its grant token in `x-wurmhol-grant`; a browser WebSocket from the
// SaaS's own pages offers it as a subprotocol. Without one, a page goes to the application's
// launch URL, where the SaaS signs its user in and issues a new grant.
import {
  createDb,
  type Db,
  embedAppLaunchUrl,
  findLiveEmbedGrant,
  takeEmbedLaunchCode,
} from "@wurmhol/db";
import {
  GRANT_HEADER,
  readCookie,
  sameOriginPath,
  SHARE_COOKIE,
  splitGrantProtocols,
} from "@wurmhol/protocol";
import { loadConfig } from "./env.ts";
import { grantCookieHeader, signGrantCookie, verifyGrantCookie } from "./grant-cookie.ts";
import { noteOAuthRedirect } from "./oauth-relay.ts";
import { errorPage } from "./pages.ts";
import { clearShareCookieHeader } from "./share-cookie.ts";
import { fromShare, refusedViewer, shareStub, toShare } from "./share-do.ts";
import { isNavigation, RESERVED_PREFIX } from "./viewer.ts";

interface Tunnel {
  tunnelId: string;
  appId: string;
}

export async function handleEmbeddedHost(request: Request, env: Env, shareId: string) {
  const config = loadConfig(env);
  const db = createDb(env.DB);
  if (!shareId) return errorPage(404, "This tunnel is not open.");
  const stub = shareStub(env, shareId);
  const status = await stub.status();
  if (status.state !== "live" && status.state !== "away") {
    return errorPage(410, "This tunnel is not open.");
  }
  if (!status.embedded || !status.tunnelId || !status.appId) {
    return errorPage(404, "This tunnel is not open.");
  }
  const tunnel: Tunnel = { tunnelId: status.tunnelId, appId: status.appId };
  const url = new URL(request.url);

  // A browser arriving from the SaaS with a one-time launch code: swap it for the grant cookie.
  if (url.pathname === `${RESERVED_PREFIX}launch`) {
    const code = url.searchParams.get("code");
    const grantId = code ? await takeEmbedLaunchCode(db, code) : null;
    const grant = grantId ? await findLiveEmbedGrant(db, { id: grantId }) : undefined;
    if (!grant || grant.kind !== "browser" || grant.tunnelId !== tunnel.tunnelId) {
      return errorPage(400, "This link has expired. Open the tunnel again from the app.");
    }
    const expiresAt = Math.floor(grant.expiresAt.getTime() / 1000);
    const cookie = await signGrantCookie(config.auth.secret, {
      tunnelId: tunnel.tunnelId,
      grantId: grant.id,
      expiresAt,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: sameOriginPath(url.searchParams.get("next")),
        "set-cookie": grantCookieHeader(cookie, expiresAt),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  let grant: { id: string } | { token: string; origin?: string } | null = null;
  const header = request.headers.get(GRANT_HEADER);
  if (header) grant = { token: header };
  else if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const offered = splitGrantProtocols(request.headers.get("sec-websocket-protocol")).grant;
    // The page's origin goes with it: the object checks it against the application's list.
    if (offered) grant = { token: offered, origin: request.headers.get("origin") ?? "" };
  }
  const hadCookie = readCookie(request.headers.get("cookie"), SHARE_COOKIE) !== null;
  if (!grant) {
    const cookie = await verifyGrantCookie(
      config.auth.secret,
      readCookie(request.headers.get("cookie"), SHARE_COOKIE),
    );
    if (cookie && cookie.tunnelId === tunnel.tunnelId) grant = { id: cookie.grantId };
  }
  if (!grant) return withoutGrant(request, db, tunnel, hadCookie);

  const answer = await stub.fetch(toShare(request, { grant }));
  if (refusedViewer(answer)) return withoutGrant(request, db, tunnel, "id" in grant);
  const { response, orgId } = fromShare(answer);
  if (orgId) await noteOAuthRedirect(env, config, { id: shareId, orgId }, request, response);
  return response;
}

/**
 * No grant, or one that no longer opens the tunnel: a page goes to the application's launch URL
 * to be signed in again (with which tunnel and where it was going); anything else is a 401.
 */
async function withoutGrant(request: Request, db: Db, tunnel: Tunnel, clearCookie: boolean) {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (clearCookie) headers["set-cookie"] = clearShareCookieHeader();
  if (isNavigation(request)) {
    const launch = await embedAppLaunchUrl(db, tunnel.appId);
    if (launch) {
      const url = new URL(request.url);
      const target = new URL(launch);
      target.searchParams.set("tunnel", tunnel.tunnelId);
      target.searchParams.set("next", `${url.pathname}${url.search}`);
      return new Response(null, {
        status: 302,
        headers: { ...headers, location: target.toString(), "referrer-policy": "no-referrer" },
      });
    }
  }
  return new Response("grant required", {
    status: 401,
    headers: { ...headers, "content-type": "text/plain" },
  });
}
