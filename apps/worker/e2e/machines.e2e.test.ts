// Machines (ADR 0018): the real `wurmhol host` connected to the real stack reports this
// computer's web ports, and its owner opens a pipe to one from the API the Create pipe card uses.
import { type ChildProcess, spawn } from "node:child_process";
import type WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  browserFetch,
  browserSocket,
  cliEnv,
  cliPath,
  createToken,
  localServer,
  type Person,
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

describe("a computer running wurmhol host", () => {
  let stack: Stack;
  let ada: Person;
  let bea: Person;
  let token: { id: string; token: string };
  let env: Record<string, string>;
  let host: ChildProcess;
  let output = "";
  let exited: number | null | undefined;
  let local: Awaited<ReturnType<typeof localServer>>;
  let hits = 0;

  beforeAll(async () => {
    stack = await startStack();
    ada = await signIn(stack);
    bea = await signIn(stack);
    const { body: invite } = await api<{ url: string }>(stack, ada, "/api/invites", {
      method: "POST",
    });
    const code = invite.url.split("/join/")[1]!;
    await api(stack, bea, `/api/invites/${code}/accept`, { method: "POST" });
    local = await localServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Machine &amp; test</title>");
    });
    token = await createToken(stack, ada, "laptop");
    env = cliEnv(stack, token.token);
    host = spawn(process.execPath, [cliPath, "host"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    host.stdout!.on("data", (chunk: Buffer) => (output += chunk));
    host.stderr!.on("data", (chunk: Buffer) => (output += chunk));
    host.on("exit", (code) => (exited = code));
  });

  afterAll(async () => {
    host?.kill();
    await stopAll(env);
    await local?.close();
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
    await waitFor(() => exited !== undefined, { timeoutMs: 15_000, what: "the CLI to exit" });
    expect(exited).toBe(1);
    expect(output).toContain("token");
    adas.socket.close();
  });
});
