// Requests to a share host, `<id>.wurmhol.dev` (spec section 6). Every one needs the viewer's
// `__Host-wurmhol` cookie for this share; without it a page navigation goes to the app to sign
// in (`/open`), and comes back with a one-time code that this swaps for the cookie. The cookie
// is stripped before anything reaches the dev server.
import { ACCESS_KEY_HEADER, readCookie, sameOriginPath, SHARE_COOKIE } from "@wurmhol/protocol";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import { noteOAuthRedirect } from "./oauth-relay.ts";
import { errorPage } from "./pages.ts";
import {
  clearShareCookieHeader,
  SHARE_COOKIE_TTL_SECONDS,
  shareCookieHeader,
  signShareCookie,
  verifyShareCookie,
} from "./share-cookie.ts";
import { fromShare, refusedViewer, shareStub, toShare } from "./share-do.ts";

/** Paths on a share host the relay keeps for itself. */
export const RESERVED_PREFIX = "/__wurmhol/";

export function isNavigation(request: Request) {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export async function handleShareHost(
  request: Request,
  env: Env,
  shareId: string,
  /** The custom domain (ADR 0030) the request came to, when it did not come to a `SHARE_DOMAIN` host. */
  customHost: string | null = null,
) {
  const config = loadConfig(env);
  if (!shareId) return errorPage(404, "This pipe has ended.");
  const stub = shareStub(env, shareId);
  const open = async () => {
    const { state } = await stub.status();
    return state === "live" || state === "away";
  };
  const ended = () => errorPage(410, "This pipe has ended.");
  const url = new URL(request.url);

  // Step 3: the app sent the viewer back with a one-time code.
  if (url.pathname === `${RESERVED_PREFIX}auth`) {
    if (!(await open())) return ended();
    const code = url.searchParams.get("code");
    const userId = code ? await stub.redeemCode(code) : null;
    if (!userId) return errorPage(400, "This sign-in link has expired. Open the pipe's URL again.");
    const cookie = await signShareCookie(config.auth.secret, {
      shareId,
      userId,
      expiresAt: Math.floor(Date.now() / 1000) + SHARE_COOKIE_TTL_SECONDS,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: sameOriginPath(url.searchParams.get("next")),
        "set-cookie": shareCookieHeader(cookie),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  // A client with no browser session (ADR 0028): a pipe opened with an access key takes it in
  // place of the sign-in, and the object checks it. Nothing here redirects to the app.
  const accessKey = request.headers.get(ACCESS_KEY_HEADER);
  if (accessKey !== null) {
    if (!(await open())) return ended();
    return fromShare(await stub.fetch(toShare(request, { key: accessKey }))).response;
  }

  const userId = await verifyShareCookie(
    config.auth.secret,
    readCookie(request.headers.get("cookie"), SHARE_COOKIE),
    shareId,
  );
  if (!userId) {
    const status = await stub.status();
    if (status.state !== "live" && status.state !== "away") return ended();
    // An embedded tunnel is reached through its own host and a grant (`embedded-host.ts`); a
    // session found here anyway is never sent to Wurmhol's sign-in.
    if (status.embedded) return grantRequired();
    return signIn(request, config.auth.baseURL, shareId, customHost);
  }

  // The hot path, one trip to the object: it answers an ended or unknown share itself.
  const { response, orgId } = fromShare(await stub.fetch(toShare(request, { viewer: userId })));
  if (refusedViewer(response)) {
    // Removed from the org since the cookie was issued: sign in again, as someone who belongs.
    createLogger({ component: "viewer" }).info("viewer.refused", { shareId });
    const again = signIn(request, config.auth.baseURL, shareId, customHost);
    const out = new Response(again.body, again);
    out.headers.append("set-cookie", clearShareCookieHeader());
    return out;
  }
  if (orgId) {
    await noteOAuthRedirect(env, config, { id: shareId, orgId }, request, response, customHost);
  }
  return response;
}

/** An embedded tunnel without a grant (ADR 0032). */
function grantRequired() {
  return new Response("grant required", {
    status: 401,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

/** Step 1: an unknown viewer goes to the app's `/open`; anything else that is not a page, 401. */
function signIn(request: Request, appURL: string, shareId: string, customHost: string | null) {
  if (!isNavigation(request)) {
    return new Response("sign in to view this pipe", {
      status: 401,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const open = new URL("/open", appURL);
  open.searchParams.set("share", shareId);
  // Back to the host the viewer came to, which `/open` checks is this pipe's own (ADR 0030).
  if (customHost) open.searchParams.set("host", customHost);
  open.searchParams.set("next", `${url.pathname}${url.search}`);
  return new Response(null, {
    status: 302,
    headers: { location: open.toString(), "cache-control": "no-store" },
  });
}
