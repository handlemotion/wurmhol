// Machines (ADR 0018): the real `wurmhol host` connected to the real stack reports this
// computer's web ports, and its owner opens a pipe to one from the API the Create pipe card uses.
import { type ChildProcess, spawn } from "node:child_process";
import type WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  browserFetch,
  browserSocket,
  cli,
  cliEnv,
  cliPath,
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

interface Machine {
  id: string;
  name: string;
  ports: { port: number; title: string | null }[];
}

/** A Create pipe card's feed of `person`'s machines: the latest list it was sent. */
function watch(stack: Stack, person: Person) {
  const state: { machines: Machine[] | null; socket: WebSocket } = {
    machines: null,
    socket: browserSocket(`${stack.url}/api/machines/live`, [], {
      cookie: person.cookie,
      origin: stack.url,
    }),
  };
  state.socket.on("message", (data) => {
    const event = JSON.parse(String(data)) as { type: string; machines: Machine[] };
    if (event.type === "machines") state.machines = event.machines;
  });
  return state;
}

/**
 * How long a disconnected `wurmhol host` may take to exit: `ws` fires `close` once the TCP
 * connection ends, and when the server is slow to end it, only at its own 30 s close timeout.
 */
const HOST_EXIT_MS = 40_000;

/** The real `wurmhol host`, with what it printed and how it exited (undefined while it runs). */
function startHost(env: Record<string, string>) {
  const state: { process: ChildProcess; output: string; exited: number | null | undefined } = {
    process: spawn(process.execPath, [cliPath, "host"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    output: "",
    exited: undefined,
  };
  state.process.stdout!.on("data", (chunk: Buffer) => (state.output += chunk));
  state.process.stderr!.on("data", (chunk: Buffer) => (state.output += chunk));
  state.process.on("exit", (code) => (state.exited = code));
  return state;
}

describe("a computer running wurmhol host", () => {
  let stack: Stack;
  let ada: Person;
  let bea: Person;
  let cy: Person;
  let token: { id: string; token: string };
  let env: Record<string, string>;
  let host: ReturnType<typeof startHost>;
  let local: Awaited<ReturnType<typeof localServer>>;
  let hits = 0;
  // What else answers on a dev machine: an API with no root route, a Node-style inspector, and a
  // web server its owner listed in WURMHOL_HOST_IGNORE.
  let apiServer: Awaited<ReturnType<typeof localServer>>;
  let inspector: Awaited<ReturnType<typeof localServer>>;
  let ignored: Awaited<ReturnType<typeof localServer>>;

  beforeAll(async () => {
    stack = await startStack();
    ada = await signIn(stack);
    bea = await signIn(stack);
    cy = await signIn(stack);
    for (const person of [bea, cy]) {
      const { body: invite } = await api<{ url: string }>(stack, ada, "/api/invites", {
        method: "POST",
      });
      const code = invite.url.split("/join/")[1]!;
      await api(stack, person, `/api/invites/${code}/accept`, { method: "POST" });
    }
    local = await localServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Machine &amp; test</title>");
    });
    apiServer = await localServer((req, res) => {
      res.writeHead(req.url === "/" ? 404 : 200, { "content-type": "application/json" }).end("{}");
    });
    inspector = await localServer((req, res) => {
      if (req.url !== "/json/version") return res.writeHead(404).end();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ Browser: "node.js/v26", "Protocol-Version": "1.1" }));
    });
    ignored = await localServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Helper</title>");
    });
    token = await createToken(stack, ada, "laptop");
    env = cliEnv(stack, token.token, { WURMHOL_HOST_IGNORE: `9229, ${ignored.port}` });
    host = startHost(env);
  });

  afterAll(async () => {
    host?.process.kill();
    await stopAll(env);
    await Promise.all([local, apiServer, inspector, ignored].map((server) => server?.close()));
    await stack?.stop();
  });

  it("shows its owner the web servers open on it, with their titles, and no one else", async () => {
    const adas = watch(stack, ada);
    const beas = watch(stack, bea);
    // Catches: ports never reported, the title probe failing, or the card's feed not pushed.
    const machine = await waitFor(
      () => adas.machines?.find((m) => m.ports.some((p) => p.port === local.port)) ?? null,
      { timeoutMs: 15_000, what: `ada's machine with port ${local.port}` },
    );
    expect(machine.ports.find((p) => p.port === local.port)?.title).toBe("Machine & test");
    // Catches: one member's computer listed (and openable) for everyone in the org.
    await waitFor(() => beas.machines !== null, { what: "bea's feed" });
    expect(beas.machines).toEqual([]);
    const asBea = await api(stack, bea, `/api/machines/${machine.id}/open`, {
      method: "POST",
      body: { port: local.port },
    });
    expect(asBea.status).toBe(404);
    adas.socket.close();
    beas.socket.close();
  });

  it("lists dev servers and APIs, but not debuggers or the ports its owner ignores", async () => {
    const adas = watch(stack, ada);
    // Every port open before the CLI started is probed in its first scan, so once these two are
    // listed the others have been decided. Catches: an API whose `/` is a 404 dropped as noise.
    const machine = await waitFor(
      () =>
        adas.machines?.find((m) =>
          [local.port, apiServer.port].every((port) => m.ports.some((p) => p.port === port)),
        ) ?? null,
      { timeoutMs: 15_000, what: "the dev server and the API listed" },
    );
    const ports = machine.ports.map((p) => p.port);
    // Catches: a debugger's port offered as a web server to share.
    expect(ports).not.toContain(inspector.port);
    // Catches: WURMHOL_HOST_IGNORE not read, or not parsed past its first entry.
    expect(ports).not.toContain(ignored.port);
    // Catches: the CLI offering its own server, a pipe that would loop through itself.
    expect(ports).not.toContain(Number(new URL(stack.url).port));
    adas.socket.close();
  });

  it("opens a pipe to a port it reported when its owner picks it, and to no other port", async () => {
    const adas = watch(stack, ada);
    const machine = await waitFor(
      () => adas.machines?.find((m) => m.ports.some((p) => p.port === local.port)) ?? null,
      { timeoutMs: 15_000, what: "ada's machine" },
    );
    // Catches: the wall reaching a port the computer did not offer (a database, say).
    const unlisted = await api(stack, ada, `/api/machines/${machine.id}/open`, {
      method: "POST",
      body: { port: 1 },
    });
    expect(unlisted.status).toBe(409);

    const opened = await api<{ url: string }>(stack, ada, `/api/machines/${machine.id}/open`, {
      method: "POST",
      body: { port: local.port },
    });
    // Catches: the open never reaching the CLI, or its answer never reaching the caller.
    expect(opened.status).toBe(200);
    const before = hits;
    const cookie = await viewerCookie(stack, ada, opened.body.url);
    const page = await browserFetch(`${opened.body.url}/`, { cookie });
    expect(await page.text()).toContain("Machine &amp; test");
    expect(hits).toBeGreaterThan(before);
    const { body } = await api<{ shares: { url: string }[] }>(stack, ada, "/api/shares");
    expect(body.shares.map((s) => s.url)).toContain(opened.body.url);

    // Catches: a second pick of the same port opening a second pipe to it.
    const again = await api<{ url: string }>(stack, ada, `/api/machines/${machine.id}/open`, {
      method: "POST",
      body: { port: local.port },
    });
    expect(again.body.url).toBe(opened.body.url);
    adas.socket.close();
  });

  it("disconnects, and the CLI stops with the fix, when its token is revoked", async () => {
    const adas = watch(stack, ada);
    await waitFor(() => adas.machines?.length === 1, { timeoutMs: 15_000, what: "one machine" });
    expect((await api(stack, ada, `/api/tokens/${token.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    // Catches: a revoked token's computer still listed, and still able to open pipes.
    await waitFor(() => adas.machines?.length === 0, { what: "the machine gone" });
    await waitFor(() => host.exited !== undefined, {
      timeoutMs: HOST_EXIT_MS,
      what: "the CLI to exit",
    });
    expect(host.exited).toBe(1);
    expect(host.output).toContain("token");
    adas.socket.close();
  });

  /**
   * `person` runs `wurmhol host` and a pipe in ada's org, then `go` takes them out of it. Their
   * tokens there are revoked (ADR 0021), so both stop and neither can come back.
   */
  async function leavesTheOrg(person: Person, go: () => Promise<void>) {
    const theirEnv = cliEnv(stack, (await createToken(stack, person, "their laptop")).token);
    const theirHost = startHost(theirEnv);
    try {
      const feed = watch(stack, person);
      await waitFor(() => feed.machines?.length === 1, {
        timeoutMs: 15_000,
        what: "their machine",
      });
      const pipe = await share(stack, theirEnv, local.port);
      await go();
      // Catches: a departed member's computer staying connected to the org, reporting its ports.
      await waitFor(() => feed.machines?.length === 0, { what: "their machine gone" });
      // Catches: `/host` taking their token back on reconnect, or refusing it with a status the
      // CLI retries forever.
      await waitFor(() => theirHost.exited !== undefined, {
        timeoutMs: HOST_EXIT_MS,
        what: "their wurmhol host to exit",
      });
      expect(theirHost.exited).toBe(1);
      expect(theirHost.output).toContain("Create a new token");
      // Catches: their open pipe still on the org's wall, served from a computer the org let go.
      await waitFor(
        async () => {
          const { body } = await api<{ shares: { url: string }[] }>(stack, ada, "/api/shares");
          return !body.shares.some((s) => s.url === pipe.url);
        },
        { what: "their pipe ended" },
      );
      // Catches: their token still opening new pipes into the org.
      const again = await cli([String(local.port)], theirEnv);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("Create a new token");
      feed.socket.close();
    } finally {
      theirHost.process.kill();
      await stopAll(theirEnv);
    }
  }

  it("disconnects a member's computer and ends their pipes when an owner removes them", async () => {
    const { body } = await api<{ members: { id: string; email: string }[] }>(
      stack,
      ada,
      "/api/members",
    );
    const member = body.members.find((m) => m.email === bea.email)!;
    await leavesTheOrg(bea, async () => {
      const removed = await api(stack, ada, `/api/members/${member.id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
    });
  });

  it("disconnects a member's computer and ends their pipes when they leave", async () => {
    await leavesTheOrg(cy, async () => {
      expect((await api(stack, cy, "/api/org/leave", { method: "POST" })).status).toBe(200);
    });
  });
});
