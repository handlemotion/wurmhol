// Named pipes (ADR 0009): `wurmhol <port> --name <name>` opens `<name>.<SHARE_DOMAIN>`, the same
// host every time, held by the first org to use the name, one open pipe per name.
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let bea: Person;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  bea = await signIn(stack);
});

afterAll(async () => {
  await stack.stop();
});

const navigate = { accept: "text/html", "sec-fetch-mode": "navigate" };

async function openNamed(env: Record<string, string>, port: number, name: string) {
  const result = await cli([String(port), "--name", name, "--json"], env);
  if (result.code !== 0) throw new Error(`wurmhol --name failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { id: string; url: string };
}

it("a name keeps its URL across pipes, and a viewer's cookie for one pipe does not open the next", async () => {
  const local = await localServer((req, res) => res.end(`host ${req.headers["x-forwarded-host"]}`));
  const env = cliEnv(stack, (await createToken(stack, ada)).token);
  const named = stack.shareUrl("my-app");

  const first = await openNamed(env, local.port, "My-App");
  expect(first.url).toBe(named);
  const cookie = await viewerCookie(stack, ada, named);
  // The dev server builds OAuth redirect URIs from the forwarded host: it must be the name.
  expect(await (await browserFetch(`${named}/`, { cookie })).text()).toBe(
    `host ${new URL(named).host}`,
  );

  expect((await cli(["stop", "my-app"], env)).code).toBe(0);
  const between = await browserFetch(`${named}/`, { cookie, headers: navigate });
  expect(between.status).toBe(404);
  expect(await between.text()).toContain("This pipe has ended.");

  const second = await openNamed(env, local.port, "my-app");
  expect(second.url).toBe(named);
  expect(second.id).not.toBe(first.id);
  // Catches: the host routing to the new pipe while the old pipe's cookie still lets anyone in.
  const stale = await browserFetch(`${named}/`, { cookie, headers: navigate });
  expect(stale.status).toBe(302);
  expect(stale.headers.get("location")).toContain(`share=${second.id}`);
  const again = await viewerCookie(stack, ada, named);
  expect((await browserFetch(`${named}/`, { cookie: again })).status).toBe(200);

  await stopAll(env);
  await local.close();
});

it("a name stays with its org, and one pipe at a time holds it", async () => {
  const local = await localServer((_req, res) => res.end("ada's app"));
  const adaEnv = cliEnv(stack, (await createToken(stack, ada)).token);
  const beaEnv = cliEnv(stack, (await createToken(stack, bea)).token);
  const named = await openNamed(adaEnv, local.port, "claimed");

  // Catches: another org opening a pipe at a host an OAuth provider already trusts for Ada's org.
  const taken = await cli([String(local.port), "--name", "claimed"], beaEnv);
  expect(taken.code).toBe(1);
  expect(taken.stderr).toContain("Another org has the pipe name claimed");

  // Catches: a second pipe silently taking the host over from the open one.
  const twice = await cli(
    [String(local.port), "--name", "claimed"],
    cliEnv(stack, (await createToken(stack, ada)).token),
  );
  expect(twice.code).toBe(1);
  expect(twice.stderr).toContain("wurmhol stop claimed");

  const cookie = await viewerCookie(stack, ada, named.url);
  expect(await (await browserFetch(`${named.url}/`, { cookie })).text()).toBe("ada's app");

  // Ended, the name is still Ada's org's.
  await stopAll(adaEnv);
  expect((await cli([String(local.port), "--name", "claimed"], beaEnv)).code).toBe(1);

  await local.close();
});
