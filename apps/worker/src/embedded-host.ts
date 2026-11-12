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
import { fromShare, refusedViewer, shareStub, toShare, type ViewerGrant } from "./share-do.ts";
import { isNavigation, RESERVED_PREFIX } from "./viewer.ts";

interface Tunnel {
  tunnelId: string;
  appId: string;
}

/** The tunnel a live embedded share serves, or the page that says it is not open. */
async function openTunnel(stub: ReturnType<typeof shareStub>): Promise<Tunnel | Response> {
  const status = await stub.status();

  if (status.state !== "live" && status.state !== "away") {
    return errorPage(410, "This tunnel is not open.");
  }

  if (!status.embedded || !status.tunnelId || !status.appId) {
    return errorPage(404, "This tunnel is not open.");
  }

  return { tunnelId: status.tunnelId, appId: status.appId };
}

/** A browser arriving from the SaaS with a one-time launch code: swap it for the grant cookie. */
async function swapLaunchCode(url: URL, db: Db, secret: string, tunnel: Tunnel) {
  const code = url.searchParams.get("code");
  const grantId = code ? await takeEmbedLaunchCode(db, code) : null;
  const grant = grantId ? await findLiveEmbedGrant(db, { id: grantId }) : undefined;

  if (!grant || grant.kind !== "browser" || grant.tunnelId !== tunnel.tunnelId) {
    return errorPage(400, "This link has expired. Open the tunnel again from the app.");
  }

  const expiresAt = Math.floor(grant.expiresAt.getTime() / 1000);

  const cookie = await signGrantCookie(secret, {
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

/**
 * The grant a request presents: its `x-wurmhol-grant` header, else a WebSocket subprotocol (with
 * the page's origin, which the object checks against the application's list), else a grant
 * cookie signed for this tunnel. Null when it presents none.
 */
async function presentedGrant(
  request: Request,
  secret: string,
  tunnel: Tunnel,
): Promise<ViewerGrant | null> {
  const header = request.headers.get(GRANT_HEADER);

  if (header) return { token: header };

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const offered = splitGrantProtocols(request.headers.get("sec-websocket-protocol")).grant;

    if (offered) return { token: offered, origin: request.headers.get("origin") ?? "" };
  }

  const cookie = await verifyGrantCookie(
    secret,
    readCookie(request.headers.get("cookie"), SHARE_COOKIE),
  );

  return cookie && cookie.tunnelId === tunnel.tunnelId ? { id: cookie.grantId } : null;
}

export async function handleEmbeddedHost(request: Request, env: Env, shareId: string) {
  const config = loadConfig(env);
  const db = createDb(env.DB);

  if (!shareId) return errorPage(404, "This tunnel is not open.");
  const stub = shareStub(env, shareId);
  const tunnel = await openTunnel(stub);

  if (tunnel instanceof Response) return tunnel;
  const url = new URL(request.url);

  if (url.pathname === `${RESERVED_PREFIX}launch`)
    return swapLaunchCode(url, db, config.auth.secret, tunnel);
  const hadCookie = readCookie(request.headers.get("cookie"), SHARE_COOKIE) !== null;
  const grant = await presentedGrant(request, config.auth.secret, tunnel);

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
  const headers = new Headers({ "cache-control": "no-store" });

  if (clearCookie) headers.set("set-cookie", clearShareCookieHeader());

  if (isNavigation(request)) {
    const launch = await embedAppLaunchUrl(db, tunnel.appId);

    if (launch) {
      const url = new URL(request.url);
      const target = new URL(launch);
      target.searchParams.set("tunnel", tunnel.tunnelId);
      target.searchParams.set("next", `${url.pathname}${url.search}`);

      headers.set("location", target.toString());
      headers.set("referrer-policy", "no-referrer");

      return new Response(null, { status: 302, headers });
    }
  }

  headers.set("content-type", "text/plain");

  return new Response("grant required", { status: 401, headers });
}
