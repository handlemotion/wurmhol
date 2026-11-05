// Per-pipe access and the view log (ADR 0008): `--only` narrows a pipe to named members of the
// token's org, and the relay records who opened it (first and last seen, a count), never what
// they opened.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  me,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let bo: Person;
let cleo: Person;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;
let hits: string[];

/** `person` joins `owner`'s org through an invite link. */
async function join(owner: Person, person: Person) {
  const { body } = await api<{ url: string }>(stack, owner, "/api/invites", { method: "POST" });
  const code = body.url.split("/join/")[1]!;
  const accepted = await api(stack, person, `/api/invites/${code}/accept`, { method: "POST" });
  if (accepted.status !== 200) throw new Error(`invite: ${accepted.status}`);
}

/** Opens a pipe with `wurmhol <port> --only <only>`. */
async function shareOnly(only: string) {
  const result = await cli([String(local.port), "--json", "--only", only], env);
  if (result.code !== 0) throw new Error(`wurmhol --only failed: ${result.stderr}`);
  return JSON.parse(result.stdout.split("\n")[0]!) as { id: string; url: string };
}

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  bo = await signIn(stack);
  cleo = await signIn(stack);
  await join(ada, bo);
  await join(ada, cleo);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  hits = [];
  local = await localServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html" }).end("<title>only for bo</title>hello");
  });
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

const page = { accept: "text/html", "sec-fetch-mode": "navigate" };

describe("a pipe opened with --only", () => {
  it("lets a listed member in, named in any case", async () => {
    const shared = await shareOnly(bo.email.toUpperCase());
    const cookie = await viewerCookie(stack, bo, shared.url);
    const response = await browserFetch(`${shared.url}/`, { cookie, headers: page });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
  });

  it("refuses a member of the same org who is not on the list, with the reason", async () => {
    const shared = await shareOnly(bo.email);
    hits.length = 0;
    const first = await browserFetch(`${shared.url}/`, { headers: page });
    const open = await browserFetch(first.headers.get("location")!, { cookie: cleo.cookie });
    expect(open.status).toBe(302);
    const login = new URL(open.headers.get("location")!, stack.url);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("reason")).toBe("not-listed");
    // Not even its starter, when they left themselves off.
    const fromAda = await browserFetch(first.headers.get("location")!, { cookie: ada.cookie });
    expect(new URL(fromAda.headers.get("location")!, stack.url).pathname).toBe("/login");
    expect(hits).toEqual([]);
  });

  it("is refused at connect when it names someone outside the org, with the fix", async () => {
    const outsider = await signIn(stack);
    const before = (await api<{ shares: unknown[] }>(stack, ada, "/api/shares")).body.shares;
    const result = await cli([String(local.port), "--only", `${bo.email},${outsider.email}`], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${outsider.email} is not a member of the token's org`);
    expect(result.stderr).toContain("menu → Members");
    expect(result.stderr).not.toContain(bo.email);
    const after = (await api<{ shares: unknown[] }>(stack, ada, "/api/shares")).body.shares;
    expect(after).toHaveLength(before.length);
  });
});

describe("the view log", () => {
  it("shows who opened a pipe and how often, and never what they opened", async () => {
    const shared = await shareOnly(`${bo.email}, ${cleo.email}`);
    const secret = `/private/${crypto.randomUUID()}?q=${crypto.randomUUID()}`;
    const cookie = await viewerCookie(stack, bo, shared.url);
    for (let i = 0; i < 3; i++) {
      expect((await browserFetch(`${shared.url}${secret}`, { cookie })).status).toBe(200);
    }

    // The wall's card names the viewer as soon as they first open it.
    const card = await waitFor(
      async () => {
        const { body } = await api<{
          shares: { id: string; views: { name: string; lastSeenAt: number }[] }[];
        }>(stack, ada, "/api/shares");
        const found = body.shares.find((s) => s.id === shared.id);
        return found?.views.length ? found : null;
      },
      { what: "the viewer on the wall" },
    );
    expect(card.views).toEqual([{ name: bo.email, lastSeenAt: expect.any(Number) }]);
    expect(Date.now() - card.views[0]!.lastSeenAt).toBeLessThan(30_000);

    // At the end the last counts reach D1: one row per viewer, with the org, and no path.
    const stopped = await cli(["stop", shared.id], env);
    expect(stopped.code).toBe(0);
    const { activeOrgId } = await me(stack, ada);
    const { user } = await me(stack, bo);
    const rows = await waitFor(
      () => {
        const db = stack.db();
        try {
          const all = db
            .prepare("select * from share_views where share_id = ?")
            .all(shared.id) as Record<string, unknown>[];
          return all.length && all[0]!.requests === 3 ? all : null;
        } finally {
          db.close();
        }
      },
      { what: "the view log in D1" },
    );
    expect(rows).toEqual([
      {
        share_id: shared.id,
        org_id: activeOrgId,
        user_id: user.id,
        first_seen_at: expect.any(Number),
        last_seen_at: expect.any(Number),
        requests: 3,
      },
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("/private/");
    expect(stored).not.toContain("q=");
  });
});
