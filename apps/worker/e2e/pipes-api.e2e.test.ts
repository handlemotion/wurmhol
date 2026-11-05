// Token scopes and expiry, and the org pipes API on the CLI's host (ADR 0008).
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  waitFor,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let pipesEnv: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;
let apiHost: string;

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "api.localhost" });
  apiHost = `http://api.localhost:${stack.port}`;
  ada = await signIn(stack);
  // The CLI dials the app host (it serves /connect too); the API calls go to the CLI's host.
  pipesEnv = cliEnv(stack, (await createToken(stack, ada, "agent")).token);
  local = await localServer((_req, res) => res.end("ok"));
});

afterAll(async () => {
  await stopAll(pipesEnv);
  await local.close();
  await stack.stop();
});

/** A bearer call to `/v1/pipes…` on the CLI's host. */
async function pipesApi(token: string, path = "", method = "GET") {
  const response = await browserFetch(`${apiHost}/v1/pipes${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      pipes?: { id: string }[];
      error?: string;
      fix?: string;
    },
  };
}

function shareRow(id: string) {
  const db = stack.db();
  try {
    return db.prepare("select ended_at, end_reason from shares where id = ?").get(id) as {
      ended_at: number | null;
      end_reason: string | null;
    };
  } finally {
    db.close();
  }
}

it("refuses an expired token, saying it expired", async () => {
  const { id, token } = await createToken(stack, ada, "short", { scope: "org", expiresInDays: 30 });
  const handle = stack.db();
  const path = (handle.prepare("pragma database_list").get() as { file: string }).file;
  handle.close();
  const db = new DatabaseSync(path);
  db.prepare("update tokens set expires_at = ? where id = ?").run(Date.now() - 1000, id);
  db.close();

  const run = await cli([String(local.port)], cliEnv(stack, token));
  expect(run.code).toBe(1);
  expect(run.stderr).toBe(
    `wurmhol: This token expired. Create a new one at ${stack.url} (menu → Tokens) and set WURMHOL_TOKEN.\n`,
  );
  const listed = await pipesApi(token);
  expect(listed.status).toBe(401);
  expect(listed.body.error).toBe("token expired");
});

it("an org token lists and closes a pipe another token of the org opened", async () => {
  const org = await createToken(stack, ada, "orchestrator", { scope: "org", expiresInDays: null });
  const opened = await share(stack, pipesEnv, local.port);

  const listed = await pipesApi(org.token);
  expect(listed.status).toBe(200);
  expect(listed.body.pipes!.map((p) => p.id)).toContain(opened.id);

  expect((await pipesApi(org.token, `/${opened.id}`, "DELETE")).status).toBe(200);
  await waitFor(() => shareRow(opened.id).ended_at !== null, { what: "the pipe to end" });
  expect(shareRow(opened.id).end_reason).toBe("terminated");
  const after = await pipesApi(org.token);
  expect(after.body.pipes!.map((p) => p.id)).not.toContain(opened.id);
});

it("refuses a pipes token with 403 and the fix", async () => {
  const opened = await share(stack, pipesEnv, local.port);
  const token = pipesEnv.WURMHOL_TOKEN!;
  for (const [path, method] of [
    ["", "GET"],
    [`/${opened.id}`, "DELETE"],
  ] as const) {
    const refused = await pipesApi(token, path, method);
    expect(refused.status).toBe(403);
    expect(refused.body.fix).toContain("list and close every pipe in the org");
  }
  expect(shareRow(opened.id).ended_at).toBeNull();
  await stopAll(pipesEnv);
});

it("another org's pipe is not found, and not listed", async () => {
  const opened = await share(stack, pipesEnv, local.port);
  const bob = await signIn(stack);
  const theirs = await createToken(stack, bob, "bob's orchestrator", { scope: "org" });

  const listed = await pipesApi(theirs.token);
  expect(listed.status).toBe(200);
  expect(listed.body.pipes!.map((p) => p.id)).not.toContain(opened.id);
  expect((await pipesApi(theirs.token, `/${opened.id}`, "DELETE")).status).toBe(404);
  expect(shareRow(opened.id).ended_at).toBeNull();
  await stopAll(pipesEnv);
});

it("a token made without options can only open pipes, and expires in 90 days", async () => {
  const { body } = await api<{
    tokens: { name: string; scope: string; expiresAt: string | null }[];
  }>(stack, ada, "/api/tokens");
  const agent = body.tokens.find((t) => t.name === "agent")!;
  expect(agent.scope).toBe("pipes");
  const days = (new Date(agent.expiresAt!).getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(89.9);
  expect(days).toBeLessThanOrEqual(90);
});
