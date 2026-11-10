// The `Wurmhol` client against the real stack (ADR 0030): signing in with the device flow into a
// token store, opening a pipe that reopens itself, and listing and ending the org's pipes.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fileTokenStore, FixError, Wurmhol } from "wurmhol";
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

let stack: Stack;
let ada: Person;
let dir: string;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  dir = mkdtempSync(join(tmpdir(), "wurmhol-client-"));
});
afterAll(async () => {
  await stack.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("signs in with the device flow into a 0600 token store, opens a pipe, and signs out", async () => {
  const file = join(dir, "token.json");
  const wurmhol = new Wurmhol({ server: stack.url, tokenStore: fileTokenStore(file) });
  expect(await wurmhol.auth.status()).toBeNull();
  const before = await wurmhol.pipes.open({ port: 3000 }).catch((error: unknown) => error);
  expect(before).toMatchObject({ code: "no_token" });

  const code = await wurmhol.auth.start({ name: "sdk e2e" });
  const waiting = wurmhol.auth.wait(code);
  expect(
    (
      await api(stack, ada, "/api/device/approve", {
        method: "POST",
        body: { code: code.user_code },
      })
    ).status,
  ).toBe(200);
  const stored = await waiting;
  expect(stored.token).toMatch(/^wh_/);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await wurmhol.auth.status()).toMatchObject({ server: stack.url, name: "sdk e2e" });

  const local = await localServer((_req, res) => res.writeHead(200).end("signed in"));
  const pipe = await wurmhol.pipes.open({ port: local.port });
  const cookie = await viewerCookie(stack, ada, pipe.url);
  expect(await (await browserFetch(pipe.url, { cookie })).text()).toBe("signed in");
  await pipe.close();
  await local.close();

  // A token a person made works the same, and signing out forgets the stored one only.
  await wurmhol.auth.signOut();
  expect(await wurmhol.auth.status()).toBeNull();
  const after = await wurmhol.pipes.open({ port: 3000 }).catch((error: unknown) => error);
  expect(after).toMatchObject({ code: "no_token" });
});

it("lists and ends the org's pipes, and refuses a token that cannot", async () => {
  const orgToken = (await createToken(stack, ada, "orchestrator", { scope: "org" })).token;
  const pipesToken = (await createToken(stack, ada, "narrow")).token;
  const wurmhol = new Wurmhol({ server: stack.url, token: orgToken });
  const local = await localServer((_req, res) => res.writeHead(200).end("ok"));
  const pipe = await wurmhol.pipes.open({ port: local.port, name: "listed" });
  try {
    const listed = await wurmhol.pipes.list();
    expect(listed.find((p) => p.id === pipe.id)).toMatchObject({
      url: pipe.url,
      port: local.port,
      state: "live",
    });

    const narrow = new Wurmhol({ server: stack.url, token: pipesToken });
    const refused = await narrow.pipes.list().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FixError);
    expect(refused).toMatchObject({ code: "refused", status: 403 });

    const closed = new Promise<string>((resolve) => pipe.once("close", resolve));
    await wurmhol.pipes.end(pipe.id);
    expect(await closed).toBe("terminated");
    expect((await wurmhol.pipes.list()).map((p) => p.id)).not.toContain(pipe.id);
    // Ending a pipe that already ended is fine; one that never existed is a 404.
    await wurmhol.pipes.end(pipe.id);
    const gone = await wurmhol.pipes.end("nope").catch((error: unknown) => error);
    expect(gone).toMatchObject({ code: "refused", status: 404 });
  } finally {
    await pipe.close();
    await local.close();
  }
});

it("keeps a pipe open: reopens after expiry with a new URL, and stops for good when it is terminated", async () => {
  const token = (await createToken(stack, ada, "keeper", { scope: "org" })).token;
  const wurmhol = new Wurmhol({ server: stack.url, token });
  const local = await localServer((_req, res) => res.writeHead(200).end("ok"));
  const pipe = wurmhol.pipes.keepOpen({
    port: local.port,
    ttl: "2s",
    reopen: { initialDelayMs: 50, maxDelayMs: 200, jitter: 0 },
  });
  const opens: { url: string; reopened: boolean }[] = [];
  const reasons: string[] = [];
  pipe.on("open", ({ url, reopened }) => opens.push({ url, reopened }));
  pipe.on("reopening", ({ reason }) => reasons.push(reason));
  try {
    await pipe.ready();
    expect(pipe.state).toBe("open");
    await waitFor(() => (opens.length >= 2 ? opens : null), { what: "a reopened pipe" });
    expect(reasons[0]).toBe("expired");
    expect(opens[1]).toMatchObject({ reopened: true });
    // Unnamed: a new pipe has a new URL, and the old one is gone.
    expect(opens[1]!.url).not.toBe(opens[0]!.url);

    const closed = new Promise<string>((resolve) =>
      pipe.once("closed", ({ reason }) => resolve(reason)),
    );
    await wurmhol.pipes.end(pipe.id!);
    expect(await closed).toBe("terminated");
    expect(pipe.state).toBe("closed");
  } finally {
    await pipe.close();
    await local.close();
  }
});
