// Agents re-run commands: `npx wurmhol <port>` again with the same flags prints the pipe that is
// already open instead of opening a second one (and using another of the org's active pipes).
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  api,
  cli,
  cliEnv,
  createToken,
  localServer,
  parseJson,
  type Person,
  shareStates,
  signIn,
  type Stack,
  startStack,
  stopAll,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  local = await localServer((_req, res) => res.end("ok"));
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

const wallSchema = z.object({ shares: z.array(z.object({ id: z.string() })) });

const open = async () =>
  (await api(stack, ada, "/api/shares", {}, wallSchema)).body.shares.map((s) => s.id);

async function run(args: string[]) {
  const result = await cli([String(local.port), ...args, "--json"], env);

  if (result.code !== 0) throw new Error(`wurmhol exited ${result.code}: ${result.stderr}`);

  return parseJson(
    z.object({ id: z.string(), url: z.string(), port: z.number(), endsAt: z.string() }),
    result.stdout.split("\n")[0]!,
  );
}

it("the same command again prints the open pipe, in the same shape, and opens no other", async () => {
  const first = await run([]);
  const again = await run([]);
  // Catches: a second daemon and URL per re-run, each one of the org's 5 active pipes.
  expect(again).toEqual(first);
  expect(await open()).toEqual([first.id]);
  expect(shareStates(env)).toHaveLength(1);
  const plain = await cli([String(local.port)], env);
  expect(plain.stdout).toBe(`${first.url}\n`);
  expect(plain.stderr).toContain(`wurmhol stop ${local.port}`);

  // After a stop, the same command opens a new pipe.
  await cli(["stop", String(local.port)], env);
  const fresh = await run([]);
  expect(fresh.id).not.toBe(first.id);
  await stopAll(env);
});

it("a different --only, --note or any --ttl opens a new pipe instead", async () => {
  const everyone = await run([]);
  // Catches: reusing a pipe the whole org can open for a command that names only some viewers.
  const onlyAda = await run(["--only", ada.email]);
  expect(onlyAda.id).not.toBe(everyone.id);
  // The same viewers, written differently, are the same request.
  expect((await run(["--only", ` ${ada.email.toUpperCase()} `])).id).toBe(onlyAda.id);
  const noted = await run(["--note", "checkout flow"]);
  expect([everyone.id, onlyAda.id]).not.toContain(noted.id);
  const timed = await run(["--ttl", "1h"]);
  expect([everyone.id, onlyAda.id, noted.id]).not.toContain(timed.id);
  expect((await open()).toSorted()).toEqual(
    [everyone.id, onlyAda.id, noted.id, timed.id].toSorted(),
  );
  await stopAll(env);
});
