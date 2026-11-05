// Data minimization and retention (ADR 0008): what the relay keeps and passes on about viewers,
// and the daily job that deletes old history. Read through the same surfaces the product uses:
// the dev server's received headers, the wall's API, the share host, and D1.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  browserFetch,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let stack: Stack;
let ada: Person;
let env: Record<string, string>;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
});

afterAll(async () => {
  await stopAll(env);
  await stack.stop();
});

/** Rows of `sql` in the local D1. */
function rows<T>(sql: string, ...params: string[]): T[] {
  const db = stack.db();
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("what the relay keeps about viewers", () => {
  it("never passes the viewer's IP to the dev server", async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const local = await localServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    const started = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, started.url);
    // Cloudflare adds these toward the Worker in production; locally the request carries them.
    const response = await browserFetch(`${started.url}/`, {
      cookie,
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.7",
        "true-client-ip": "203.0.113.7",
      },
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("x-forwarded-for");
    expect(seen[0]).not.toHaveProperty("x-real-ip");
    expect(seen[0]).not.toHaveProperty("true-client-ip");
    expect(JSON.stringify(seen[0])).not.toContain("203.0.113.7");
    // The headers apps need to build absolute URLs still arrive.
    expect(seen[0]!["x-forwarded-host"]).toBe(new URL(started.url).host);
    await local.close();
  });

  it("stores no IP address on a new session", async () => {
    const email = `${randomUUID()}@example.com`;
    await signIn(stack, email, { "x-forwarded-for": "203.0.113.7" });
    const [session] = rows<{ ip_address: string | null }>(
      "select s.ip_address from sessions s join users u on u.id = s.user_id where u.email = ?",
      email,
    );
    // Better Auth writes "" when tracking is off; either way, no address.
    expect(session).toBeDefined();
    expect(["", null]).toContain(session!.ip_address);
  });

  it("forgets a pipe's title and favicon when it ends", async () => {
    const local = await localServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(200, { "content-type": "image/x-icon" }).end(Buffer.from([0, 0, 1, 0, 1]));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Secret roadmap</title>");
    });
    const started = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, started.url);
    await browserFetch(`${started.url}/`, { cookie, headers: { accept: "text/html" } });
    type Wall = { shares: { id: string; title: string | null; favicon: boolean }[] };
    await waitFor(
      async () => {
        const card = (await api<Wall>(stack, ada, "/api/shares")).body.shares.find(
          (s) => s.id === started.id,
        );
        return card?.title === "Secret roadmap" && card.favicon;
      },
      { what: "the title and favicon on the wall" },
    );

    const terminated = await api(stack, ada, `/api/shares/${started.id}/terminate`, {
      method: "POST",
    });
    expect(terminated.status).toBe(200);

    const wall = await api<Wall>(stack, ada, "/api/shares");
    expect(wall.body.shares.map((s) => s.id)).not.toContain(started.id);
    expect(JSON.stringify(wall.body)).not.toContain("Secret roadmap");
    const icon = await browserFetch(`${stack.url}/api/shares/${started.id}/favicon`, {
      cookie: ada.cookie,
    });
    expect(icon.status).toBe(404);
    // The share host still answers "ended" from the tombstone, and nothing reaches the server.
    const after = await browserFetch(`${started.url}/`, { cookie });
    expect(after.status).toBe(410);
    expect(await after.text()).not.toContain("Secret roadmap");
    await local.close();
  });
});

describe("the daily retention job", () => {
  /** Runs the Worker's cron handler, as the daily trigger does. */
  async function runRetention() {
    const response = await fetch(`${stack.url}/__scheduled?cron=17+3+*+*+*`);
    expect(response.status).toBe(200);
  }

  it("deletes expired sign-in rows, and pipe history after 90 days", async () => {
    const bo = await signIn(stack);
    const boId = rows<{ id: string }>("select id from users where email = ?", bo.email)[0]!.id;
    // An invite link nobody used, and a magic link nobody clicked.
    const invite = await api<{ url: string }>(stack, bo, "/api/invites", { method: "POST" });
    expect(invite.status).toBe(201);
    const pending = `${randomUUID()}@example.com`;
    await browserFetch(`${stack.url}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: stack.url },
      body: JSON.stringify({ email: pending, callbackURL: "/" }),
    });
    const boEnv = cliEnv(stack, (await createToken(stack, bo)).token);
    const local = await localServer((_req, res) => res.end("ok"));
    const started = await share(stack, boEnv, local.port);
    await stopAll(boEnv);
    await local.close();
    await waitFor(
      () =>
        rows<{ ended_at: number | null }>("select ended_at from shares where id = ?", started.id)[0]
          ?.ended_at,
      { what: "the share's end in D1" },
    );

    const orgOfBo = "select organization_id from members where user_id = ?";
    const counts = () => ({
      sessions: rows("select id from sessions where user_id = ?", boId).length,
      verifications: rows("select id from verifications where value like ?", `%${pending}%`).length,
      invites: rows(`select id from invite_links where org_id in (${orgOfBo})`, boId).length,
      shares: rows("select id from shares where id = ?", started.id).length,
    });

    // Fresh rows: nothing is due.
    await runRetention();
    expect(counts()).toEqual({ sessions: 1, verifications: 1, invites: 1, shares: 1 });

    // Expired a minute ago, and a pipe from 89 days ago: the sign-in rows go, history stays.
    const ago = (ms: number) => Date.now() - ms;
    stack.exec("update sessions set expires_at = ? where user_id = ?", ago(60_000), boId);
    stack.exec(
      "update verifications set expires_at = ? where value like ?",
      ago(60_000),
      `%${pending}%`,
    );
    stack.exec(
      `update invite_links set expires_at = ? where org_id in (${orgOfBo})`,
      ago(60_000),
      boId,
    );
    stack.exec("update shares set started_at = ? where id = ?", ago(89 * DAY_MS), started.id);
    await runRetention();
    expect(counts()).toEqual({ sessions: 0, verifications: 0, invites: 0, shares: 1 });
    // Ada's live session is untouched.
    expect((await api(stack, ada, "/api/me")).status).toBe(200);

    // A pipe from 91 days ago: its history goes too.
    stack.exec("update shares set started_at = ? where id = ?", ago(91 * DAY_MS), started.id);
    await runRetention();
    expect(counts().shares).toBe(0);
  });
});
