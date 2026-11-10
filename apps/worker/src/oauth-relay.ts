// The OAuth callback relay (ADR 0010). An app behind a pipe registers one redirect URI per
// provider, on the relay's host (`https://oauth.wurmhol.dev/api/auth/callback/google`), and
// every pipe of it signs in through that URI.
//
// 1. A pipe's response carries a `Location` to the provider whose `redirect_uri` is on the relay.
//    The relay records the URL's `state` (hashed) against that pipe, for 10 minutes.
// 2. The provider sends the browser to `<relay>/<path>?code&state`. The relay takes the state,
//    once, and redirects to `<that pipe's origin>/<path>?<query>`, where the pipe's own sign-in
//    and membership check apply as on any request.
//
// Only response headers are read, never bodies. The code, tokens and the URL are never logged or
// stored; only the state's hash and the pipe's id are, for minutes.
import { createDb, recordOAuthState, takeOAuthState } from "@wurmhol/db";
import { type Config, relayOrigin } from "./env.ts";
import { viewerOrigin } from "./share-url.ts";
import { createLogger } from "./log.ts";
import { errorPage } from "./pages.ts";

/** How long a pipe's viewer has to come back from the provider. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Longer states are not OAuth states worth keeping. */
const MAX_STATE_LENGTH = 1024;

/** The `state` of a redirect to an OAuth provider that will call back on the relay, or null. */
export function relayedState(config: Config, location: string | null, base: string) {
  const relay = relayOrigin(config);
  if (!relay || !location) return null;
  let target: URL;
  let callback: URL;
  try {
    target = new URL(location, base);
    callback = new URL(target.searchParams.get("redirect_uri") ?? "");
  } catch {
    return null;
  }
  if (callback.origin !== relay) return null;
  const state = target.searchParams.get("state");
  return state && state.length <= MAX_STATE_LENGTH ? state : null;
}

/**
 * Step 1: records a pipe's outgoing OAuth state. Any response may carry it: a 302, or a 200 with
 * a `Location` header and the URL in its body (Better Auth's `signIn.social`).
 */
export async function noteOAuthRedirect(
  env: Env,
  config: Config,
  share: { id: string; orgId: string },
  request: Request,
  response: Response,
  /** The custom domain the flow started on (ADR 0030): where it comes back to. */
  host: string | null = null,
) {
  const state = relayedState(config, response.headers.get("location"), request.url);
  if (!state) return;
  await recordOAuthState(createDb(env.DB), {
    state,
    orgId: share.orgId,
    shareId: share.id,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
    host,
  });
  createLogger({ component: "oauth" }).info("oauth.recorded", {
    shareId: share.id,
    orgId: share.orgId,
  });
}

/** Step 2: a request to the relay's host, the provider's callback. */
export async function handleRelay(request: Request, env: Env, config: Config) {
  const log = createLogger({ component: "oauth" });
  if (request.method !== "GET") {
    // `response_mode=form_post` is out of scope: a cross-site POST arrives at the pipe without
    // its SameSite=Lax share cookie, so the pipe could not let it through.
    return errorPage(405, "This sign-in relay takes the provider's redirect only (GET).");
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const db = createDb(env.DB);
  const share = state && state.length <= MAX_STATE_LENGTH ? await takeOAuthState(db, state) : null;
  if (!share) {
    log.info("oauth.unknown");
    return errorPage(
      404,
      "This sign-in has expired or was already used. Start signing in again from the app.",
    );
  }
  if (share.endedAt) {
    log.info("oauth.ended", { shareId: share.id });
    return errorPage(410, "This pipe has ended.");
  }
  log.info("oauth.relayed", { shareId: share.id });
  // Concatenated, never resolved against the origin: a path like `//evil.example` stays a path
  // on the pipe's host.
  return new Response(null, {
    status: 302,
    headers: {
      location: `${await viewerOrigin(db, config, share, share.host)}${url.pathname}${url.search}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
