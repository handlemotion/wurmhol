// Who may open a share (spec section 6): only signed-in members of the org that owns it. Each
// refusal is also checked at the dev server: a refused viewer's request never reaches it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  browserFetch,
  browserSocket,
  cliEnv,
  createToken,
  localServer,
  me,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;
let hits: string[];
let shared: { id: string; url: string };

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  hits = [];
  local = await localServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/favicon.ico") {
      return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0, 0, 1, 0]));
    }
    res.writeHead(200, { "content-type": "text/html" }).end("<title>secret app</title>secret");
  });
  shared = await share(stack, env, local.port);
  // The relay asks the dev server for `/` and its favicon itself when a pipe starts, for the
  // wall, until it has the favicon. Wait for that, so `hits` counts only what viewers cause.
  await waitFor(
    async () =>
      (await browserFetch(`${stack.url}/api/shares/${shared.id}/favicon`, { cookie: ada.cookie }))
        .status === 200,
    { timeoutMs: 15_000, what: "the relay's own probe of the pipe" },
  );
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

const page = { accept: "text/html", "sec-fetch-mode": "navigate" };

describe("a signed-out viewer", () => {
  it("is sent to sign in, never to the app, and nothing reaches the dev server", async () => {
    hits.length = 0;
    const first = await browserFetch(`${shared.url}/admin?x=1`, { headers: page });
    expect(first.status).toBe(302);
    const open = new URL(first.headers.get("location")!);
    expect(open.origin).toBe(stack.url);
    expect(open.pathname).toBe("/open");
    expect(open.searchParams.get("share")).toBe(shared.id);
    expect(open.searchParams.get("next")).toBe("/admin?x=1");

    const login = await browserFetch(open.toString());
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toMatch(/^\/login\?next=/);

    // Scripts and assets get a plain 401, not a redirect they cannot follow.
    const asset = await browserFetch(`${shared.url}/app.js`, {
      headers: { "sec-fetch-mode": "no-cors" },
    });
    expect(asset.status).toBe(401);
    expect(hits).toEqual([]);
  });

  it("cannot get in with a forged cookie, another share's cookie, or a used code", async () => {
    hits.length = 0;
    const cookie = await viewerCookie(stack, ada, shared.url);
    const [name, value] = cookie.split("=") as [string, string];
    const [, user, expires, signature] = value.split(".");
    const forged = [
      // Someone else's user id under Ada's signature.
      `${name}=${shared.id}.someone-else.${expires}.${signature}`,
      // A later expiry under the same signature.
      `${name}=${shared.id}.${user}.${Number(expires) + 3600}.${signature}`,
      // Unsigned.
      `${name}=${shared.id}.${user}.${expires}.`,
    ];
    for (const bad of forged) {
      const response = await browserFetch(`${shared.url}/`, { cookie: bad, headers: page });
      expect(response.status).toBe(302);
    }
    // A cookie is for one share only.
    const otherLocal = await localServer((_req, res) => res.end("other"));
    const other = await share(stack, env, otherLocal.port);
    const otherCookie = await viewerCookie(stack, ada, other.url);
    expect(
      (await browserFetch(`${shared.url}/`, { cookie: otherCookie, headers: page })).status,
    ).toBe(302);
    expect(hits).toEqual([]);

    // A one-time code works once.
    const first = await browserFetch(`${shared.url}/`, { headers: page });
    const back = await browserFetch(first.headers.get("location")!, { cookie: ada.cookie });
    const callback = back.headers.get("location")!;
    expect((await browserFetch(callback)).status).toBe(302);
    const replay = await browserFetch(callback);
    expect(replay.status).toBe(400);
    expect(replay.headers.getSetCookie()).toEqual([]);
    await otherLocal.close();
  });
});

describe("redirects after sign-in", () => {
  // A crafted `next` must not turn sign-in into an open redirect: browsers drop tabs and read
  // `\` as `/`, so "/\t/evil.example" would land on evil.example.
  const crafted = [
    "/\t/evil.example/x",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
  ];

  it("/open passes only same-site paths on to the pipe", async () => {
    for (const next of crafted) {
      const open = await browserFetch(
        `${stack.url}/open?${new URLSearchParams({ share: shared.id, next })}`,
        { cookie: ada.cookie },
      );
      expect(new URL(open.headers.get("location")!).searchParams.get("next")).toBe("/");
    }
  });

  it("the pipe never redirects off itself, even with a tampered callback", async () => {
    for (const next of crafted) {
      const open = await browserFetch(`${stack.url}/open?share=${shared.id}`, {
        cookie: ada.cookie,
      });
      const callback = new URL(open.headers.get("location")!);
      callback.searchParams.set("next", next);
      const response = await browserFetch(callback.toString());
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
    }
  });
});

describe("a member of another org", () => {
  it("gets the login page, never the share", async () => {
    hits.length = 0;
    const bob = await signIn(stack);
    const first = await browserFetch(`${shared.url}/`, { headers: page });
    const open = await browserFetch(first.headers.get("location")!, { cookie: bob.cookie });
    expect(open.status).toBe(302);
    const login = new URL(open.headers.get("location")!, stack.url);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("reason")).toBe("not-member");
    // Nor can Bob see or end it from his own wall.
    expect(
      (await api(stack, bob, `/api/shares/${shared.id}/terminate`, { method: "POST" })).status,
    ).toBe(404);
    expect((await api<{ shares: unknown[] }>(stack, bob, "/api/shares")).body.shares).toEqual([]);
    expect(hits).toEqual([]);
  });

  it("gets in once invited, and is shut out again when removed", async () => {
    const cleo = await signIn(stack);
    const { body: invite } = await api<{ url: string }>(stack, ada, "/api/invites", {
      method: "POST",
    });
    const code = invite.url.split("/join/")[1]!;
    expect((await api<{ orgName: string }>(stack, cleo, `/api/invites/${code}`)).status).toBe(200);
    expect((await api(stack, cleo, `/api/invites/${code}/accept`, { method: "POST" })).status).toBe(
      200,
    );
    // Single use: a second person cannot reuse the link.
    const dan = await signIn(stack);
    expect((await api(stack, dan, `/api/invites/${code}/accept`, { method: "POST" })).status).toBe(
      404,
    );

    const cookie = await viewerCookie(stack, cleo, shared.url);
    expect((await browserFetch(`${shared.url}/`, { cookie })).status).toBe(200);

    const { body } = await api<{ members: { id: string; email: string }[] }>(
      stack,
      ada,
      "/api/members",
    );
    const member = body.members.find((m) => m.email === cleo.email)!;
    // Only owners remove members; Cleo is a member.
    expect((await api(stack, cleo, `/api/members/${member.id}`, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await api(stack, ada, `/api/members/${member.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    // Her cookie still verifies, but the Share DO re-checks membership (within 10 s).
    const refused = await waitFor(
      async () => {
        const response = await browserFetch(`${shared.url}/`, { cookie, headers: page });
        return response.status === 302 ? response : null;
      },
      { timeoutMs: 15_000, intervalMs: 500, what: "the removed member to be refused" },
    );
    expect(refused.headers.getSetCookie().join()).toContain("__Host-wurmhol=;");
    // An org keeps its last owner.
    const adaMember = body.members.find((m) => m.email === ada.email)!;
    expect(
      (await api(stack, ada, `/api/members/${adaMember.id}`, { method: "DELETE" })).status,
    ).toBe(409);
  });
});

describe("the app's own cookies and pages", () => {
  it("issues __Host- session cookies and hardened API responses", async () => {
    const response = await browserFetch(`${stack.url}/api/me`, { cookie: ada.cookie });
    expect(ada.cookie).toMatch(/^__Host-wurmhol\.session_token=/);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await me(stack, ada)).activeOrgId).toBeTruthy();
  });

  it("refuses the wall's live feed to other origins", async () => {
    // Cross-site WebSocket hijacking: a foreign page opening the feed with Ada's cookie.
    const status = (origin: string) =>
      new Promise<number>((resolve) => {
        const socket = browserSocket(`${stack.url}/api/live`, [], { cookie: ada.cookie, origin });
        socket.once("open", () => {
          socket.close();
          resolve(101);
        });
        socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      });
    expect(await status("https://evil.example")).toBe(403);
    expect(await status(stack.url)).toBe(101);
  });
});
