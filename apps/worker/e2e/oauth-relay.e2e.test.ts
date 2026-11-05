// The OAuth callback relay (ADR 0010): an app registers one redirect URI per provider, on the
// relay's host, and every pipe of it signs in through that URI. A real local server plays the
// provider (it redirects only to the URI registered with it), and a real dev server starts the
// flow the way OAuth libraries do: a state in a cookie, a redirect to the provider.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  browserFetch,
  cli,
  cliEnv,
  cookiesOf,
  createToken,
  localServer,
  type Person,
  sha256,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
} from "./support.ts";

const navigate = { accept: "text/html", "sec-fetch-mode": "navigate" };
const CALLBACK = "/api/auth/callback/test";

let stack: Stack;
let ada: Person;
let bea: Person;
let relay: string;
let provider: Awaited<ReturnType<typeof localServer>>;
let app: Awaited<ReturnType<typeof localServer>>;

beforeAll(async () => {
  stack = await startStack({ OAUTH_RELAY_HOST: "oauth.pipe.localhost" });
  relay = `http://oauth.pipe.localhost:${stack.port}`;
  const registered = `${relay}${CALLBACK}`;
  // The provider: like Google, it sends the browser back only to the redirect URI registered
  // with it, exactly.
  provider = await localServer((req, res) => {
    const url = new URL(req.url!, "http://provider");
    const redirect = url.searchParams.get("redirect_uri");
    if (url.pathname !== "/authorize" || redirect !== registered) {
      res.writeHead(400).end("redirect_uri is not registered");
      return;
    }
    const back = new URL(redirect);
    back.searchParams.set("code", randomUUID());
    back.searchParams.set("state", url.searchParams.get("state")!);
    res.writeHead(302, { location: back.toString() }).end();
  });
  const authorize = `http://localhost:${provider.port}/authorize`;
  // The dev server: one app, shared through several pipes. `/login` keeps a state in a cookie and
  // sends the viewer to the provider, as a 302, or (`?json`) as Better Auth's `signIn.social`
  // does, a 200 with a `Location` header and the URL in the body. The callback checks the state.
  app = await localServer((req, res) => {
    const url = new URL(req.url!, "http://app");
    const host = req.headers["x-forwarded-host"];
    if (url.pathname === "/login") {
      const state = url.searchParams.get("state") ?? randomUUID();
      const to = `${authorize}?client_id=app&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(registered)}`;
      const json = url.searchParams.has("json");
      res
        .writeHead(json ? 200 : 302, {
          location: to,
          "set-cookie": `app_state=${state}; Path=/; HttpOnly`,
          "content-type": json ? "application/json" : "text/plain",
        })
        .end(json ? JSON.stringify({ url: to, redirect: true }) : "");
      return;
    }
    if (url.pathname === CALLBACK) {
      const cookie = /app_state=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (!cookie || cookie !== url.searchParams.get("state")) {
        res.writeHead(400).end(`${host}: state mismatch`);
        return;
      }
      res.end(`${host} signed in with ${url.searchParams.get("code")}`);
      return;
    }
    res.end(`${host}`);
  });
  ada = await signIn(stack);
  bea = await signIn(stack);
});

afterAll(async () => {
  await app?.close();
  await provider?.close();
  await stack?.stop();
});

async function openNamed(env: Record<string, string>, name: string) {
  const result = await cli([String(app.port), "--name", name, "--json"], env);
  if (result.code !== 0) throw new Error(`wurmhol --name failed: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { url: string }).url;
}

/** The viewer clicks "Sign in" in the app behind `pipe`: back comes the provider's URL. */
async function startSignIn(pipe: string, shareCookie: string, query = "") {
  const login = await browserFetch(`${pipe}/login${query}`, {
    cookie: shareCookie,
    headers: navigate,
  });
  const authorize = login.headers.get("location");
  const appCookie = cookiesOf(login).find((c) => c.startsWith("app_state="));
  if (!authorize || !appCookie) throw new Error(`no sign-in redirect: ${login.status}`);
  return { authorize, appCookie, state: new URL(authorize).searchParams.get("state")! };
}

/** The provider approves: it sends the browser to the registered URI, the relay's. */
async function approve(authorize: string) {
  const response = await browserFetch(authorize);
  const callback = response.headers.get("location");
  if (response.status !== 302 || !callback?.startsWith(relay)) {
    throw new Error(`provider refused: ${response.status} ${await response.text()}`);
  }
  return callback;
}

function relayedStates() {
  const db = stack.db();
  try {
    return db.prepare("select * from oauth_states").all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

it("two pipes of one app both sign in through the one registered relay URI", async () => {
  const env = cliEnv(stack, (await createToken(stack, ada)).token);
  // Catches: a pipe taking the relay's host as its name, a pipe nobody could ever reach.
  const reserved = await cli([String(app.port), "--name", "oauth"], env);
  expect(reserved.code).toBe(1);
  expect(reserved.stderr).toContain("The pipe name oauth is reserved");

  const one = await openNamed(env, "app-one");
  const two = await openNamed(env, "app-two");
  const oneCookie = await viewerCookie(stack, ada, one);
  const twoCookie = await viewerCookie(stack, ada, two);

  // Both flows in flight at once, as parallel agents' pipes would be. Catches: the relay watching
  // only 3xx responses, which misses Better Auth's 200 with a `Location` header.
  const first = await startSignIn(one, oneCookie);
  const second = await startSignIn(two, twoCookie, "?json");
  // Catches: the state kept in plain text, where a database reader could finish someone's flow.
  const rows = relayedStates();
  expect(rows.map((row) => row.hash).sort()).toEqual(
    [first.state, second.state].map((s) => sha256(Buffer.from(s))).sort(),
  );
  expect(JSON.stringify(rows)).not.toContain(first.state);

  // Out of order: each callback finds its own pipe by its state, not by which came last.
  const callbacks = [await approve(second.authorize), await approve(first.authorize)];
  const landed: string[] = [];
  for (const [callback, pipe, cookie] of [
    [callbacks[0]!, two, `${twoCookie}; ${second.appCookie}`],
    [callbacks[1]!, one, `${oneCookie}; ${first.appCookie}`],
  ] as const) {
    const relayed = await browserFetch(callback, { headers: navigate });
    expect(relayed.status).toBe(302);
    const target = relayed.headers.get("location")!;
    const sent = new URL(callback);
    expect(target).toBe(`${pipe}${sent.pathname}${sent.search}`);
    const page = await browserFetch(target, { cookie, headers: navigate });
    expect(page.status).toBe(200);
    landed.push(await page.text());
  }
  const code = (callback: string) => new URL(callback).searchParams.get("code");
  expect(landed).toEqual([
    `${new URL(two).host} signed in with ${code(callbacks[0]!)}`,
    `${new URL(one).host} signed in with ${code(callbacks[1]!)}`,
  ]);

  // Catches: a state that works twice, so a callback URL left in history replays later.
  const replay = await browserFetch(callbacks[1]!, { headers: navigate });
  expect(replay.status).toBe(404);
  expect(await replay.text()).toContain("expired or was already used");
  expect(relayedStates()).toEqual([]);

  await stopAll(env);
});

it("a state goes back only to the pipe that sent it", async () => {
  const adaEnv = cliEnv(stack, (await createToken(stack, ada)).token);
  const beaEnv = cliEnv(stack, (await createToken(stack, bea)).token);
  const mine = await openNamed(adaEnv, "mine");
  const theirs = await openNamed(beaEnv, "theirs");
  const mineCookie = await viewerCookie(stack, ada, mine);
  const theirsCookie = await viewerCookie(stack, bea, theirs);

  // Another org's app sends its viewer off with Ada's state. Catches: the last pipe to record a
  // state winning, which would send Ada's code to Bea's pipe.
  const flow = await startSignIn(mine, mineCookie);
  await startSignIn(theirs, theirsCookie, `?state=${flow.state}`);
  const relayed = await browserFetch(await approve(flow.authorize), { headers: navigate });
  expect(new URL(relayed.headers.get("location")!).origin).toBe(mine);

  // Catches: resolving the callback's path against the pipe's origin, where `//host` is a
  // different host: an open redirect that carries the code away.
  const tricked = await startSignIn(mine, mineCookie);
  const callback = new URL(await approve(tricked.authorize));
  const escaped = await browserFetch(`${relay}//evil.localhost/x${callback.search}`, {
    headers: navigate,
  });
  expect(new URL(escaped.headers.get("location")!).origin).toBe(mine);

  // Catches: a callback for an ended pipe delivered to the next pipe that took its name.
  const late = await startSignIn(mine, mineCookie);
  await stopAll(adaEnv);
  expect(await openNamed(adaEnv, "mine")).toBe(mine);
  const ended = await browserFetch(await approve(late.authorize), { headers: navigate });
  expect(ended.status).toBe(410);
  expect(await ended.text()).toContain("This pipe has ended.");

  await stopAll(adaEnv);
  await stopAll(beaEnv);
});
