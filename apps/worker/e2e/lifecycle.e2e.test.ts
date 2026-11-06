// How shares start and end: the live wall, Terminate, revoked tokens, and the fair-use limits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alive,
  api,
  browserFetch,
  browserSocket,
  cli,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  shareStates,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

function pidOf(env: Record<string, string>, id: string) {
  return (
    JSON.parse(readFileSync(join(env.WURMHOL_HOME!, "shares", `${id}.json`), "utf8")) as {
      pid: number;
    }
  ).pid;
}

describe("the wall and Terminate", () => {
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

  it("shows a share live within 2 s with its title, and Terminate ends it within 5 s", async () => {
    const events: {
      type: string;
      share?: { id: string; title: string | null };
      id?: string;
      shares?: unknown[];
    }[] = [];
    const wall = browserSocket(`${stack.url}/api/live`, [], {
      cookie: ada.cookie,
      origin: stack.url,
    });
    wall.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      wall.once("open", () => resolve());
      wall.once("error", reject);
    });
    await waitFor(() => events.some((e) => e.type === "snapshot"), { what: "the snapshot" });

    const local = await localServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Wall test</title>ok"),
    );
    const startedAt = Date.now();
    const started = await share(stack, env, local.port);
    await waitFor(
      () => events.some((e) => e.type === "share.started" && e.share?.id === started.id),
      { what: "share.started" },
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
    // The title arrives with the first page view.
    const cookie = await viewerCookie(stack, ada, started.url);
    await browserFetch(`${started.url}/`, { cookie });
    await waitFor(
      () => events.some((e) => e.type === "share.updated" && e.share?.title === "Wall test"),
      { what: "the title" },
    );

    const pid = pidOf(env, started.id);
    const terminatedAt = Date.now();
    expect(
      (await api(stack, ada, `/api/shares/${started.id}/terminate`, { method: "POST" })).status,
    ).toBe(200);
    await waitFor(() => events.some((e) => e.type === "share.ended" && e.id === started.id), {
      what: "share.ended",
    });
    await waitFor(() => !alive(pid), { what: "the CLI to exit" });
    expect(Date.now() - terminatedAt).toBeLessThan(5000);
    const ended = await browserFetch(`${started.url}/`, { cookie });
    expect(ended.status).toBe(410);
    expect(await ended.text()).toContain("This pipe has ended.");
    // The history records how it ended.
    const db = stack.db();
    expect(db.prepare("select end_reason from shares where id = ?").get(started.id)).toEqual({
      end_reason: "terminated",
    });
    db.close();
    wall.close();
    await local.close();
  });

  it("a frozen CLI shows away once its heartbeats stop, and live again when it wakes", async () => {
    // SIGSTOP is a container paused or a laptop asleep: the CLI's TCP connection stays open, so
    // only the missing heartbeats say it is gone. Without that check the wall says live and the
    // pipe holds its place until Cloudflare drops the socket.
    const local = await localServer((_req, res) => res.end("x"));
    const started = await share(stack, env, local.port);
    const stateOf = async () => {
      const { body } = await api<{ shares: { id: string; state: string }[] }>(
        stack,
        ada,
        "/api/shares",
      );
      return body.shares.find((s) => s.id === started.id)?.state;
    };
    expect(await stateOf()).toBe("live");
    const pid = pidOf(env, started.id);
    process.kill(pid, "SIGSTOP");
    const frozenAt = Date.now();
    try {
      await waitFor(async () => (await stateOf()) === "away", {
        timeoutMs: 75_000,
        intervalMs: 1000,
        what: "the wall to show the frozen pipe away",
      });
      // Two missed heartbeats (20 s each), not one.
      expect(Date.now() - frozenAt).toBeGreaterThan(30_000);
    } finally {
      process.kill(pid, "SIGCONT");
    }
    await waitFor(async () => (await stateOf()) === "live", {
      timeoutMs: 20_000,
      what: "the woken CLI to bring its pipe back",
    });
    await cli(["stop", String(local.port)], env);
    await local.close();
  });

  it("a revoked token ends its shares and cannot start new ones", async () => {
    const second = await createToken(stack, ada, "to revoke");
    const revocable = cliEnv(stack, second.token);
    const local = await localServer((_req, res) => res.end("ok"));
    const started = await share(stack, revocable, local.port);
    const pid = pidOf(revocable, started.id);
    expect((await api(stack, ada, `/api/tokens/${second.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    await waitFor(() => !alive(pid), { what: "the revoked token's CLI to exit" });
    const again = await cli([String(local.port)], revocable);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("Create a new token");
    // The list no longer shows it.
    const { body } = await api<{ tokens: { id: string }[] }>(stack, ada, "/api/tokens");
    expect(body.tokens.map((t) => t.id)).not.toContain(second.id);
    await local.close();
  });

  it("says what to do without a token or with a wrong one", async () => {
    const missing = await cli(["8080"], {
      WURMHOL_URL: stack.url,
      WURMHOL_HOME: env.WURMHOL_HOME!,
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(
      `wurmhol: Run wurmhol login, or set WURMHOL_TOKEN to a token from ${stack.url} (menu → Tokens).\n`,
    );
    const wrong = await cli(["8080"], { ...env, WURMHOL_TOKEN: "wh_not-a-real-token" });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("Create a new token");
  });
});

describe("fair-use limits", () => {
  it("refuses a share over the org's active limit until one stops", async () => {
    const stack = await startStack({ LIMIT_ACTIVE_SHARES: "2" });
    try {
      const ada = await signIn(stack);
      const env = cliEnv(stack, (await createToken(stack, ada)).token);
      const local = await localServer((_req, res) => res.end("ok"));
      // Two CLIs racing for the last slots: the Org DO hands out exactly two.
      const results = await Promise.all([0, 1, 2].map(() => cli([String(local.port)], env)));
      expect(results.filter((r) => r.code === 0)).toHaveLength(2);
      const refused = results.find((r) => r.code !== 0)!;
      expect(refused.stderr).toContain("already has 2 open pipes");
      await cli(["stop", String(local.port)], env);
      expect((await cli([String(local.port)], env)).code).toBe(0);
      await stopAll(env);
      await local.close();
    } finally {
      await stack.stop();
    }
  });

  it("ends shares and refuses new ones once the org's monthly transfer is used", async () => {
    const stack = await startStack({ LIMIT_MONTHLY_BYTES: String(4 * 1024 * 1024) });
    try {
      const ada = await signIn(stack);
      const env = cliEnv(stack, (await createToken(stack, ada)).token);
      const body = Buffer.alloc(3 * 1024 * 1024, 7);
      const local = await localServer((_req, res) => res.end(body));
      const started = await share(stack, env, local.port);
      const cookie = await viewerCookie(stack, ada, started.url);
      const pid = pidOf(env, started.id);
      for (let i = 0; i < 3 && alive(pid); i++) {
        await (
          await browserFetch(`${started.url}/file`, { cookie })
        )
          .arrayBuffer()
          .catch(() => null);
      }
      await waitFor(() => !alive(pid), { what: "the share to end at the limit" });
      const refused = await cli([String(local.port)], env);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("this month's transfer allowance");
      await local.close();
    } finally {
      await stack.stop();
    }
  });

  it("ends shares and refuses new ones once the org's monthly requests are used", async () => {
    const stack = await startStack({ LIMIT_MONTHLY_REQUESTS: "3" });
    try {
      const ada = await signIn(stack);
      const env = cliEnv(stack, (await createToken(stack, ada)).token);
      const local = await localServer((_req, res) => res.end("ok"));
      const started = await share(stack, env, local.port);
      const cookie = await viewerCookie(stack, ada, started.url);
      const pid = pidOf(env, started.id);
      // Usage reaches the Org object at most every few seconds: keep asking until it ends.
      await waitFor(
        async () => {
          await browserFetch(`${started.url}/`, { cookie }).catch(() => null);
          return !alive(pid);
        },
        { what: "the share to end at the request limit", timeoutMs: 20_000, intervalMs: 250 },
      );
      const refused = await cli([String(local.port)], env);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("this month's request allowance");
      await local.close();
    } finally {
      await stack.stop();
    }
  });
});

describe("a pipe's lifetime", () => {
  let stack: Stack;
  let env: Record<string, string>;

  beforeAll(async () => {
    stack = await startStack({ DEFAULT_SHARE_SECONDS: "6", LIMIT_SHARE_SECONDS: "3600" });
    const ada = await signIn(stack);
    env = cliEnv(stack, (await createToken(stack, ada)).token);
  });
  afterAll(async () => {
    await stopAll(env);
    await stack.stop();
  });

  function endsAt(id: string) {
    return cli(["ls", "--json"], env).then((run) => {
      const pipes = JSON.parse(run.stdout) as { id: string; endsAt: string }[];
      return Date.parse(pipes.find((p) => p.id === id)!.endsAt);
    });
  }

  it("lasts DEFAULT_SHARE_SECONDS without --ttl, and ls says when it ends", async () => {
    const local = await localServer((_req, res) => res.end("ok"));
    const before = Date.now();
    const started = await share(stack, env, local.port);
    // Catches: the default not applied (the pipe would run to the 1 h limit), or `ls` showing an
    // end the relay doesn't enforce.
    expect(Math.abs((await endsAt(started.id)) - before - 6000)).toBeLessThan(3000);
    const pid = pidOf(env, started.id);
    await waitFor(() => !alive(pid), { timeoutMs: 15_000, what: "the default lifetime to end it" });
    expect((await browserFetch(`${started.url}/`)).status).toBe(410);
    await local.close();
  });

  it("ends at a shorter --ttl, with reason expired", async () => {
    const local = await localServer((_req, res) => res.end("ok"));
    const before = Date.now();
    const result = await cli([String(local.port), "--ttl", "2s", "--json"], env);
    expect(result.code).toBe(0);
    const started = JSON.parse(result.stdout) as { id: string; url: string; endsAt: string };
    expect(Math.abs(Date.parse(started.endsAt) - before - 2000)).toBeLessThan(2000);
    const pid = pidOf(env, started.id);
    await waitFor(() => !alive(pid), { timeoutMs: 4000, what: "--ttl 2s to end the pipe" });
    const db = stack.db();
    try {
      expect(db.prepare("select end_reason from shares where id = ?").get(started.id)).toEqual({
        end_reason: "expired",
      });
    } finally {
      db.close();
    }
    const page = await browserFetch(`${started.url}/`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This pipe has ended.");
    await local.close();
  });

  it("refuses a --ttl over the limit, or one it can't read, with a one-line fix", async () => {
    const over = await cli(["8787", "--ttl", "2h"], env);
    expect(over.code).toBe(1);
    expect(over.stderr).toBe("wurmhol: Pipes last at most 1h. Pass --ttl 1h or less.\n");
    // Catches: `--ttl 90` (no unit) silently opening a pipe for the default lifetime.
    const unreadable = await cli(["8787", "--ttl", "90"], env);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("--ttl 90m");
    expect(shareStates(env)).toEqual([]);
  });
});
