// A pipe that outlives the relay's reconnect grace (a laptop asleep, a network gone for minutes)
// is opened again by its daemon: a named pipe at the same URL, an unnamed one at a new URL that
// `wurmhol ls`, the state file and `wurmhol logs` all show. Here a sandbox's CONNECT proxy cuts
// the CLI's socket and then refuses it until the relay has ended the share for `disconnected`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECONNECT_GRACE_MS } from "@wurmhol/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  alive,
  browserFetch,
  cli,
  cliEnv,
  connectProxy,
  createToken,
  localServer,
  type Person,
  shareStates,
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
let proxy: Awaited<ReturnType<typeof connectProxy>>;
/** The ports the proxy tunnels to: emptied, it refuses every CONNECT with a 403. */
const allowed: number[] = [];

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  allowed.push(stack.port);
  proxy = await connectProxy(allowed);
  env = cliEnv(stack, (await createToken(stack, ada)).token, {
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
  });
});

afterAll(async () => {
  allowed.splice(0, allowed.length, stack.port);
  await stopAll(env);
  await proxy.close();
  await stack.stop();
});

interface Listed {
  id: string;
  url: string;
  port: number;
  endsAt: string;
}

async function open(args: string[]) {
  const result = await cli([...args, "--json"], env);
  if (result.code !== 0) throw new Error(`wurmhol ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout.split("\n")[0]!) as Listed;
}

async function ls() {
  return JSON.parse((await cli(["ls", "--json"], env)).stdout) as Listed[];
}

async function events(target: string) {
  const run = await cli(["logs", target, "--json"], env);
  return run.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; from?: string; to?: string });
}

function endReason(id: string) {
  const db = stack.db();
  try {
    return (
      db.prepare("select end_reason from shares where id = ?").get(id) as {
        end_reason: string | null;
      }
    ).end_reason;
  } finally {
    db.close();
  }
}

function pidOf(id: string) {
  const file = join(env.WURMHOL_HOME!, "shares", `${id}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
}

/** Signs Ada in to `url` and returns the body of `/`, once the pipe answers there. */
async function answer(url: string) {
  return waitFor(
    async () => {
      const cookie = await viewerCookie(stack, ada, url).catch(() => null);
      if (!cookie) return null;
      const response = await browserFetch(`${url}/`, { cookie });
      return response.status === 200 ? response.text() : null;
    },
    { timeoutMs: 90_000, intervalMs: 500, what: `${url} to answer` },
  );
}

it(
  "reopens pipes the relay ended for a lost connection, and stop ends them for good",
  { timeout: RECONNECT_GRACE_MS + 150_000 },
  async () => {
    const namedApp = await localServer((_req, res) => res.end("named app"));
    const plainApp = await localServer((_req, res) => res.end("plain app"));
    const stoppedApp = await localServer((_req, res) => res.end("stopped app"));
    const named = await open([String(namedApp.port), "--name", "sleepy", "--note", "nap"]);
    const plain = await open([String(plainApp.port)]);
    const stopped = await open([String(stoppedApp.port)]);
    expect(await answer(named.url)).toBe("named app");
    expect(await answer(plain.url)).toBe("plain app");
    const pids = [named, plain, stopped].map((p) => pidOf(p.id));

    // The laptop sleeps: the socket drops and nothing gets through until the relay gives up.
    allowed.length = 0;
    proxy.cutAll();
    await waitFor(() => [named, plain, stopped].every((p) => endReason(p.id) === "disconnected"), {
      timeoutMs: RECONNECT_GRACE_MS + 60_000,
      intervalMs: 500,
      what: "the relay to end them",
    });
    // Three refused reopens (after waits of 1, 2 and 4 s): the daemon now waits 8 s, longer than
    // `wurmhol stop` waits for a process to exit.
    await waitFor(
      async () => (await events(stopped.id)).filter((e) => e.event === "reopen.failed").length >= 3,
      { timeoutMs: 60_000, intervalMs: 250, what: "three refused reopens" },
    );

    // Catches: SIGTERM ignored, or only heard after the wait, while the daemon waits to reopen.
    expect((await cli(["stop", String(stoppedApp.port)], env)).code).toBe(0);
    expect(alive(pids[2]!)).toBe(false);

    // The laptop wakes.
    allowed.push(stack.port);

    // Catches: a daemon that exits on `disconnected`, leaving a named URL dead for good.
    expect(await answer(named.url)).toBe("named app");
    const listed = await waitFor(
      async () => {
        const now = await ls();
        const fresh = now.find((p) => p.port === plainApp.port);
        return fresh && fresh.id !== plain.id && now.length === 2 ? now : null;
      },
      { timeoutMs: 90_000, intervalMs: 500, what: "the new unnamed pipe in ls" },
    );
    const reopened = listed.find((p) => p.port === plainApp.port)!;
    const namedAgain = listed.find((p) => p.port === namedApp.port)!;
    expect(namedAgain.url).toBe(named.url);
    expect(namedAgain.id).not.toBe(named.id);
    // Catches: ls still listing the ended pipe's URL, which only says "This pipe has ended."
    expect(reopened.url).not.toBe(plain.url);
    expect(await answer(reopened.url)).toBe("plain app");
    // Catches: a second daemon (a new process) instead of the same one holding on.
    expect(pidOf(reopened.id)).toBe(pids[1]);
    expect(shareStates(env).toSorted()).toEqual(
      [`${reopened.id}.json`, `${namedAgain.id}.json`].toSorted(),
    );

    // Catches: `wurmhol logs <port>` reading a log the daemon no longer writes, and the old log
    // giving no hint where the pipe went.
    for (const log of [plain.id, String(plainApp.port)]) {
      expect(await events(log)).toContainEqual(
        expect.objectContaining({ event: "reopened", from: plain.id, to: reopened.id }),
      );
    }

    // Catches: the rewritten state file losing `request`, so the same command opens a second pipe.
    expect((await open([String(namedApp.port), "--name", "sleepy", "--note", "nap"])).id).toBe(
      namedAgain.id,
    );
    expect((await open([String(plainApp.port)])).id).toBe(reopened.id);

    // Catches: stop no longer finding a reopened pipe by its name or port.
    expect((await cli(["stop", "sleepy"], env)).code).toBe(0);
    expect((await cli(["stop", String(plainApp.port)], env)).code).toBe(0);
    expect(pids.map(alive)).toEqual([false, false, false]);
    expect(await ls()).toEqual([]);
    const gone = await browserFetch(`${named.url}/`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(gone.status).toBe(404);

    await Promise.all([namedApp.close(), plainApp.close(), stoppedApp.close()]);
  },
);
