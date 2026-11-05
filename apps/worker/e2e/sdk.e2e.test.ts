// `openPipe` in this process, against the real stack: the `wurmhol` package's export, as an
// orchestrator imports it (built `packages/cli/dist/index.js`).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixError, openPipe, type CloseReason, type RequestEvent } from "wurmhol";
import {
  api,
  browserFetch,
  createToken,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  viewerCookie,
  waitFor,
} from "./support.ts";

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

    const wall = async () =>
      (await api<{ shares: { id: string }[] }>(stack, ada, "/api/shares")).body.shares;
    expect((await wall()).map((s) => s.id)).toContain(pipe.id);
    await pipe.close();
    expect(closes).toEqual(["stopped"]);
    expect(logged).toEqual(expect.arrayContaining(["connected", "ended"]));
    await waitFor(async () => !(await wall()).some((s) => s.id === pipe.id), {
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
