// The operator's takedown path (ADR 0022): a reported pipe ends, the token that opened it is
// revoked with its other pipes, and a blocked org starts no more pipes with any token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  alive,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  parseJson,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

const OPERATOR_TOKEN = "e2e-operator-token-e2e-operator-token-0";

function pidOf(env: Record<string, string>, id: string) {
  return parseJson(
    z.object({ pid: z.number() }),
    readFileSync(join(env.WURMHOL_HOME!, "shares", `${id}.json`), "utf8"),
  ).pid;
}

interface TakedownRequest {
  pipe: string;
  blockOrg?: boolean;
  note?: string;
}

/** What a takedown the operator is allowed ended. */
const takenDown = z.object({
  pipe: z.object({ id: z.string() }),
  tokenRevoked: z.string().nullable(),
  endedPipes: z.array(z.string()),
  orgBlocked: z.boolean(),
});

async function takedown(stack: Stack, body: TakedownRequest, token = OPERATOR_TOKEN) {
  const response = await fetch(`${stack.url}/operator/takedown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: response.status, text: await response.text() };
}

describe("operator takedown", () => {
  let stack: Stack;
  let ada: Person;
  const envs: Record<string, string>[] = [];
  const servers: { close(): Promise<void> }[] = [];

  async function server() {
    const local = await localServer((_req, res) => res.end("ok"));
    servers.push(local);

    return local.port;
  }

  async function tokenEnv(person: Person, name: string) {
    const created = await createToken(stack, person, name);
    const env = cliEnv(stack, created.token);
    envs.push(env);

    return { id: created.id, env };
  }

  beforeAll(async () => {
    stack = await startStack({ OPERATOR_TOKEN });
    ada = await signIn(stack);
  });
  afterAll(async () => {
    for (const env of envs) await stopAll(env);

    for (const local of servers) await local.close();
    await stack.stop();
  });

  it("ends a pipe reported by its host and every pipe of its token, which opens no more", async () => {
    const reported = await tokenEnv(ada, "reported");
    const pipe = await share(stack, reported.env, await server());
    const sibling = await share(stack, reported.env, await server());
    const cookie = await viewerCookie(stack, ada, pipe.url);
    expect(await (await browserFetch(`${pipe.url}/`, { cookie })).text()).toBe("ok");

    // Only the operator: no token, or another one, changes nothing.
    const host = new URL(pipe.url).host;
    expect((await takedown(stack, { pipe: host }, "")).status).toBe(401);
    expect((await takedown(stack, { pipe: host }, `${OPERATOR_TOKEN}x`)).status).toBe(401);
    expect((await browserFetch(`${pipe.url}/`, { cookie })).status).toBe(200);

    const pids = [pidOf(reported.env, pipe.id), pidOf(reported.env, sibling.id)];
    const done = await takedown(stack, { pipe: host });
    expect(done.status).toBe(200);
    const taken = parseJson(takenDown, done.text);
    expect(taken.pipe.id).toBe(pipe.id);
    expect(taken.tokenRevoked).toBe(reported.id);
    expect(taken.endedPipes.toSorted()).toEqual([pipe.id, sibling.id].toSorted());
    expect(taken.orgBlocked).toBe(false);

    await waitFor(() => pids.every((pid) => !alive(pid)), { what: "both CLIs to exit" });
    const ended = await browserFetch(`${pipe.url}/`, { cookie });
    expect(ended.status).toBe(410);
    const again = await cli([String(await server())], reported.env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("Create a new token");

    // Without a block, the org's other tokens still work.
    const other = await tokenEnv(ada, "other");
    expect((await cli([String(await server())], other.env)).code).toBe(0);
  });

  it("blocks the org: its other tokens' pipes end and no token of it opens one", async () => {
    const reported = await tokenEnv(ada, "abuse");
    const bystander = await tokenEnv(ada, "bystander");
    const pipe = await share(stack, reported.env, await server());
    const unrelated = await share(stack, bystander.env, await server());
    const pid = pidOf(bystander.env, unrelated.id);

    const done = await takedown(stack, { pipe: `${pipe.url}/login`, blockOrg: true, note: "e2e" });
    expect(done.status).toBe(200);
    const taken = parseJson(takenDown, done.text);
    expect(taken.orgBlocked).toBe(true);
    expect(taken.endedPipes).toContain(unrelated.id);

    await waitFor(() => !alive(pid), { what: "the bystander's CLI to exit" });

    for (const env of [bystander.env, (await tokenEnv(ada, "made after")).env]) {
      const refused = await cli([String(await server())], env);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("This org is blocked from opening pipes");
    }

    // Another org is untouched.
    const bob = await tokenEnv(await signIn(stack), "bob");
    expect((await cli([String(await server())], bob.env)).code).toBe(0);
  });
});
