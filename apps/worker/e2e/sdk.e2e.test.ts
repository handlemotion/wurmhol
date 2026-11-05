// `openPipe` in this process, against the real stack: the `wurmhol` package's export, as an
// orchestrator imports it (built `packages/cli/dist/index.js`).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { FixError, openPipe, type CloseReason, type Pipe, type RequestEvent } from "wurmhol";
import {
  api,
  browserFetch,
  browserSocket,
  connectProxy,
  createToken,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  viewerCookie,
  waitFor,
} from "./support.ts";

/** Records what a pipe emits. */
const watch = (pipe: Pipe) => {
  const requests: RequestEvent[] = [];
  const closes: CloseReason[] = [];
  pipe.on("request", (event) => requests.push(event));
  pipe.on("close", (reason) => closes.push(reason));
  return { requests, closes };
};

describe("openPipe", () => {
  let stack: Stack;
  let ada: Person;
  let token: string;

  beforeAll(async () => {
    stack = await startStack();
    ada = await signIn(stack);
    token = (await createToken(stack, ada)).token;
  });
  afterAll(async () => {
    await stack.stop();
  });

  const wall = async () =>
    (await api<{ shares: { id: string }[] }>(stack, ada, "/api/shares")).body.shares.map(
      (s) => s.id,
    );
  /** Every share row a token started, as D1 has it. */
  const sharesOf = (tokenId: string) => {
    const db = stack.db();
    try {
      return db
        .prepare("select id, end_reason from shares where token_id = ? order by started_at")
        .all(tokenId) as { id: string; end_reason: string | null }[];
    } finally {
      db.close();
    }
  };

  it("opens a pipe a member can use, reports each request here, and close() ends it on the wall", async () => {
    const local = await localServer((_req, res) =>
      res.writeHead(201, { "content-type": "text/html" }).end("<title>SDK</title>hello"),
    );
    // `log` must reach the caller, or an orchestrator cannot tell why a pipe dropped.
    const logged: string[] = [];
    const pipe = await openPipe({
      port: local.port,
      token,
      server: stack.url,
      log: (event) => logged.push(event),
    });
    const requests: RequestEvent[] = [];
    const closes: CloseReason[] = [];
    pipe.on("request", (event) => requests.push(event));
    pipe.on("close", (reason) => closes.push(reason));
    expect(pipe.url).toBe(stack.shareUrl(pipe.id));
    expect(pipe.port).toBe(local.port);

    const cookie = await viewerCookie(stack, ada, pipe.url);
    const response = await browserFetch(`${pipe.url}/page?q=1`, { cookie });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("<title>SDK</title>hello");
    const event = await waitFor(() => requests.find((r) => r.path === "/page?q=1"), {
      what: "the request event",
    });
    expect(event).toMatchObject({ method: "GET", status: 201 });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);

    expect(await wall()).toContain(pipe.id);
    await pipe.close();
    expect(closes).toEqual(["stopped"]);
    expect(logged).toEqual(expect.arrayContaining(["connected", "ended"]));
    await waitFor(async () => !(await wall()).includes(pipe.id), {
      what: "the pipe to leave the wall",
    });
    const db = stack.db();
    try {
      expect(db.prepare("select end_reason from shares where id = ?").get(pipe.id)).toEqual({
        end_reason: "stopped",
      });
    } finally {
      db.close();
    }
    await local.close();
  });

  it("rejects with the one-line fix the CLI prints", async () => {
    const error = await openPipe({ port: 3000, token: "wh_unknown", server: stack.url }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FixError);
    expect((error as FixError).message).toBe(
      `Create a new token at ${stack.url} (menu → Tokens) and set WURMHOL_TOKEN.`,
    );
  });

  // Catches state shared between pipes in one process (streams, share ids, listeners): one
  // pipe's traffic or close leaking into another's.
  it("runs three pipes in one process, each serving its own port and its own events", async () => {
    const locals = await Promise.all(
      ["one", "two", "three"].map((name) =>
        localServer((req, res) =>
          res.writeHead(200, { "content-type": "text/plain" }).end(`${name} ${req.url}`),
        ),
      ),
    );
    const pipes = await Promise.all(
      locals.map((local) => openPipe({ port: local.port, token, server: stack.url })),
    );
    expect(new Set(pipes.map((p) => p.id)).size).toBe(3);
    const seen = pipes.map(watch);
    const cookies = await Promise.all(pipes.map((p) => viewerCookie(stack, ada, p.url)));

    const names = ["one", "two", "three"];
    await Promise.all(
      pipes.map(async (pipe, i) => {
        const response = await browserFetch(`${pipe.url}/from-${names[i]}`, {
          cookie: cookies[i],
        });
        expect(await response.text()).toBe(`${names[i]} /from-${names[i]}`);
      }),
    );
    for (const [i, { requests }] of seen.entries()) {
      await waitFor(() => requests.length >= 1, { what: `pipe ${names[i]}'s request event` });
      expect(requests.map((r) => r.path)).toEqual([`/from-${names[i]}`]);
    }

    await pipes[0]!.close();
    expect(seen.map((s) => s.closes)).toEqual([["stopped"], [], []]);
    expect((await browserFetch(`${pipes[0]!.url}/`, { cookie: cookies[0] })).status).toBe(410);
    for (const i of [1, 2]) {
      const response = await browserFetch(`${pipes[i]!.url}/still`, { cookie: cookies[i] });
      expect(await response.text()).toBe(`${names[i]} /still`);
    }
    const open = await wall();
    expect(open).not.toContain(pipes[0]!.id);
    expect(open).toEqual(expect.arrayContaining([pipes[1]!.id, pipes[2]!.id]));

    await Promise.all(pipes.slice(1).map((p) => p.close()));
    expect(seen.map((s) => s.closes)).toEqual([["stopped"], ["stopped"], ["stopped"]]);
    await Promise.all(locals.map((l) => l.close()));
  });

  // Catches a dial that starts before the signal is checked: a share nobody asked for.
  it("rejects an already aborted signal without starting a share", async () => {
    const own = await createToken(stack, ada, "pre-aborted");
    const error = await openPipe({
      port: 3000,
      token: own.token,
      server: stack.url,
      signal: AbortSignal.abort(),
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");

    // A real pipe on the same token afterwards: the relay sees requests in order, so a stray
    // dial from the aborted call would show up as a second row.
    const local = await localServer((_req, res) => res.end("ok"));
    const pipe = await openPipe({ port: local.port, token: own.token, server: stack.url });
    await pipe.close();
    expect(sharesOf(own.id)).toEqual([{ id: pipe.id, end_reason: "stopped" }]);
    expect(await wall()).not.toContain(pipe.id);
    await local.close();
  });

  // Catches an abort that rejects the caller but leaves the dial to finish into an open share.
  it("rejects when aborted mid-dial, and the share the dial opened ends", async () => {
    const own = await createToken(stack, ada, "mid-dial");
    const local = await localServer((_req, res) => res.end("ok"));
    const controller = new AbortController();
    const pending = openPipe({
      port: local.port,
      token: own.token,
      server: stack.url,
      signal: controller.signal,
    });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");

    const [row] = await waitFor(
      () => {
        const rows = sharesOf(own.id);
        return rows.length > 0 && rows.every((r) => r.end_reason) && rows;
      },
      { what: "the dialed share to end" },
    );
    expect(row!.end_reason).toBe("stopped");
    expect(await wall()).not.toContain(row!.id);
    await local.close();
  });

  // Catches a signal that is only wired to the dial, not to the open pipe.
  it("closes an open pipe when its signal aborts", async () => {
    const local = await localServer((_req, res) => res.end("ok"));
    const controller = new AbortController();
    const pipe = await openPipe({
      port: local.port,
      token,
      server: stack.url,
      signal: controller.signal,
    });
    const { closes } = watch(pipe);
    expect(await wall()).toContain(pipe.id);
    controller.abort();
    await waitFor(() => closes.length > 0, { what: "the close event" });
    expect(closes).toEqual(["stopped"]);
    await waitFor(async () => !(await wall()).includes(pipe.id), {
      what: "the pipe to leave the wall",
    });
    await local.close();
  });

  // Catches `host` reaching only the HTTP path (or being dropped), and the dev server seeing the
  // loopback address instead of the `localhost` Host it is configured for.
  it("reaches a dev server that listens only on the given host", async () => {
    const server = createServer((req, res) =>
      res.writeHead(200, { "content-type": "text/plain" }).end(`host=${req.headers.host}`),
    );
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket, req) => socket.send(`ws host=${req.headers.host}`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    const { port } = server.address() as AddressInfo;
    // Nothing answers on the default host, so only `host` can make this pipe work.
    expect(await fetch(`http://127.0.0.1:${port}/`).catch(() => null)).toBeNull();

    const pipe = await openPipe({ port, token, server: stack.url, host: "127.0.0.2" });
    const cookie = await viewerCookie(stack, ada, pipe.url);
    const response = await browserFetch(`${pipe.url}/`, { cookie });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`host=localhost:${port}`);

    const socket = browserSocket(pipe.url, [], { cookie, origin: pipe.url });
    const message = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data: Buffer) => resolve(data.toString()));
      socket.once("error", reject);
    });
    expect(message).toBe(`ws host=localhost:${port}`);
    socket.close();

    await pipe.close();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  // Catches the relay's close codes reaching the caller as the wrong reason (or as a reconnect).
  it("emits terminated when the wall ends the pipe", async () => {
    const local = await localServer((_req, res) => res.end("ok"));
    const pipe = await openPipe({ port: local.port, token, server: stack.url });
    const { closes } = watch(pipe);
    expect(
      (await api(stack, ada, `/api/shares/${pipe.id}/terminate`, { method: "POST" })).status,
    ).toBe(200);
    await waitFor(() => closes.length > 0, { what: "the close event" });
    expect(closes).toEqual(["terminated"]);
    await local.close();
  });

  it("emits revoked when the pipe's token is deleted", async () => {
    const own = await createToken(stack, ada, "to-revoke");
    const local = await localServer((_req, res) => res.end("ok"));
    const pipe = await openPipe({ port: local.port, token: own.token, server: stack.url });
    const { closes } = watch(pipe);
    expect((await api(stack, ada, `/api/tokens/${own.id}`, { method: "DELETE" })).status).toBe(200);
    await waitFor(() => closes.length > 0, { what: "the close event" });
    expect(closes).toEqual(["revoked"]);
    expect(sharesOf(own.id)).toEqual([{ id: pipe.id, end_reason: "revoked" }]);
    await local.close();
  });

  // Catches a refused reconnect (here: the token expired while the pipe ran) closing the pipe as
  // `disconnected` instead of the reason the relay gave.
  it("emits revoked when a reconnect finds its token expired", async () => {
    const own = await createToken(stack, ada, "to-expire");
    const local = await localServer((_req, res) => res.end("ok"));
    const proxy = await connectProxy([stack.port]);
    const saved = { ...process.env };
    Object.assign(process.env, { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url });
    for (const name of ["NO_PROXY", "no_proxy", "http_proxy", "https_proxy"]) {
      delete process.env[name];
    }
    try {
      const pipe = await openPipe({ port: local.port, token: own.token, server: stack.url });
      expect(proxy.connects).toBe(1);
      const { closes } = watch(pipe);
      const db = stack.db({ write: true });
      try {
        db.prepare("update tokens set expires_at = ? where id = ?").run(Date.now() - 1000, own.id);
      } finally {
        db.close();
      }
      proxy.cutAll();
      await waitFor(() => closes.length > 0, { what: "the close event" });
      expect(closes).toEqual(["revoked"]);
    } finally {
      process.env = saved;
      await proxy.close();
      await local.close();
    }
  });

  it("ends at its ttl with reason expired, and rejects one over the limit", async () => {
    const local = await localServer((_req, res) => res.end("ok"));
    const before = Date.now();
    const pipe = await openPipe({ port: local.port, token, server: stack.url, ttl: "2s" });
    // Catches: the SDK dropping `ttl`, so the pipe runs for the 4 h default.
    expect(Math.abs(pipe.endsAt.getTime() - before - 2000)).toBeLessThan(2000);
    const reason = await new Promise<CloseReason>((resolve) => pipe.once("close", resolve));
    expect(reason).toBe("expired");
    expect(Date.now() - before).toBeLessThan(6000);
    await local.close();

    const error = await openPipe({ port: 3000, token, server: stack.url, ttl: 13 * 3600 }).catch(
      (e: unknown) => e,
    );
    expect((error as FixError).message).toBe("Pipes last at most 12h. Pass --ttl 12h or less.");
  });
});
