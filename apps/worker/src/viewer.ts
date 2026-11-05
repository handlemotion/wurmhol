// Requests to a share host, `<id>.wurmhol.dev` (spec section 6). Every one needs the viewer's
// `__Host-wurmhol` cookie for this share; without it a page navigation goes to the app to sign
// in (`/open`), and comes back with a one-time code that this swaps for the cookie. The cookie
// is stripped before anything reaches the dev server.
import { readCookie, sameOriginPath, SHARE_COOKIE } from "@wurmhol/protocol";
import { loadConfig, shareOrigin } from "./env.ts";
import { createLogger } from "./log.ts";
import { errorPage } from "./pages.ts";
import {
  clearShareCookieHeader,
  SHARE_COOKIE_TTL_SECONDS,
  shareCookieHeader,
  signShareCookie,
  verifyShareCookie,
} from "./share-cookie.ts";
import { INTERNAL_HEADERS } from "./share-do.ts";

/** Paths on a share host the relay keeps for itself. */
export const RESERVED_PREFIX = "/__wurmhol/";

function isNavigation(request: Request) {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export async function handleShareHost(request: Request, env: Env, shareId: string) {
  const config = loadConfig(env);
  if (!shareId) return errorPage(404, "This pipe has ended.");
  const stub = env.SHARE.get(env.SHARE.idFromName(shareId));
  const status = await stub.status();
  if (status.state === "unknown" || status.state === "ended") {
    return errorPage(410, "This pipe has ended.");
  }
  const url = new URL(request.url);

  // Step 3: the app sent the viewer back with a one-time code.
  if (url.pathname === `${RESERVED_PREFIX}auth`) {
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

  const userId = await verifyShareCookie(
    config.auth.secret,
    readCookie(request.headers.get("cookie"), SHARE_COOKIE),
    shareId,
  );
  if (!userId) return signIn(request, config.auth.baseURL, shareId);

  // Our own headers are never taken from the viewer: rebuild them.
  const headers = new Headers(request.headers);
  for (const name of Object.values(INTERNAL_HEADERS)) headers.delete(name);
  headers.set(INTERNAL_HEADERS.viewer, userId);
  headers.set(INTERNAL_HEADERS.clientIp, request.headers.get("cf-connecting-ip") ?? "");
  const response = await stub.fetch(new Request(request, { headers }));
  if (response.headers.get("x-wurmhol-refused")) {
    // Removed from the org since the cookie was issued: sign in again, as someone who belongs.
    createLogger({ component: "viewer" }).info("viewer.refused", { shareId });
    const again = signIn(request, config.auth.baseURL, shareId);
    const out = new Response(again.body, again);
    out.headers.append("set-cookie", clearShareCookieHeader());
    return out;
  }
  return response;
}

/** Step 1: an unknown viewer goes to the app's `/open`; anything else that is not a page, 401. */
function signIn(request: Request, appURL: string, shareId: string) {
  if (!isNavigation(request)) {
    return new Response("sign in to view this pipe", {
      status: 401,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const open = new URL("/open", appURL);
  open.searchParams.set("share", shareId);
  open.searchParams.set("next", `${url.pathname}${url.search}`);
  return new Response(null, {
    status: 302,
    headers: { location: open.toString(), "cache-control": "no-store" },
  });
}

export { shareOrigin };
