// Where a pipe came from (ADR 0012): the real CLI, run in a real git repo, sends its repo, branch,
// commit, agent session, link and note; the Worker checks them, keeps them on the share's row,
// and shows them on the wall's card and in the org pipes API.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
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
} from "./support.ts";

let stack: Stack;
let ada: Person;
let token: string;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;
let repo: string;
let commit: string;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  token = (await createToken(stack, ada, "agent", { scope: "org" })).token;
  env = cliEnv(stack, token);
  local = await localServer((_req, res) => res.end("ok"));
  repo = mkdtempSync(join(tmpdir(), "wurmhol-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "feat/checkout");
  git("remote", "add", "origin", "https://x-access-token:ghs_e2esecret@github.com/acme/shop.git");
  git("commit", "-q", "--allow-empty", "-m", "first");
  commit = git("rev-parse", "HEAD");
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

interface Card {
  id: string;
  source: Record<string, string | null> | null;
}

async function card(id: string) {
  const wall = await api<{ shares: Card[] }>(stack, ada, "/api/shares");
  return wall.body.shares.find((share) => share.id === id);
}

it("shows the repo, branch, commit, agent session, link and note a pipe was opened with", async () => {
  const run = await cli(
    [
      String(local.port),
      "--json",
      "--link",
      "https://linear.app/acme/issue/SHOP-12",
      "--note",
      "Checkout with the new\ntax rules",
    ],
    { ...env, CLAUDECODE: "1", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01AbCdEfGhIjKlMn" },
    { cwd: repo },
  );
  expect(run.stderr).toBe("");
  const { id } = JSON.parse(run.stdout) as { id: string };
  const expected = {
    repoHost: "github.com",
    repo: "acme/shop",
    branch: "feat/checkout",
    commit,
    link: "https://linear.app/acme/issue/SHOP-12",
    note: "Checkout with the new tax rules",
    agent: "Claude Code",
    agentUrl: "https://claude.ai/code/session_01AbCdEfGhIjKlMn",
  };
  expect((await card(id))?.source).toEqual(expected);

  const listed = await browserFetch(`${stack.url}/v1/pipes`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const pipes = ((await listed.json()) as { pipes: Card[] }).pipes;
  expect(pipes.find((pipe) => pipe.id === id)?.source).toEqual(expected);

  const db = stack.db();
  try {
    const row = db
      .prepare(
        "select repo_host, repo, branch, commit_sha, link, note, agent, agent_url from shares where id = ?",
      )
      .get(id);
    expect(row).toEqual({
      repo_host: "github.com",
      repo: "acme/shop",
      branch: "feat/checkout",
      commit_sha: commit,
      link: expected.link,
      note: expected.note,
      agent: "Claude Code",
      agent_url: expected.agentUrl,
    });
    // The remote's credentials never leave the agent's machine.
    expect(JSON.stringify(db.prepare("select * from shares").all())).not.toContain("ghs_");
  } finally {
    db.close();
  }
  await stopAll(env);
});

it("a pipe opened outside a repo, by no known agent, has no source", async () => {
  const run = await cli([String(local.port), "--json"], env, {
    cwd: mkdtempSync(join(tmpdir(), "wurmhol-plain-")),
  });
  const { id } = JSON.parse(run.stdout) as { id: string };
  const shown = await card(id);
  expect(shown).toBeDefined();
  expect(shown!.source).toBeNull();
  await stopAll(env);
});

it("the CLI refuses a link that is not http(s), with the fix", async () => {
  const run = await cli([String(local.port), "--link", "javascript:alert(1)"], env, { cwd: repo });
  expect(run.code).toBe(1);
  expect(run.stderr).toBe(
    "wurmhol: Pass an http or https URL of at most 2048 characters to --link.\n",
  );
});

it("the Worker refuses a bad source from any client, before a pipe opens", async () => {
  const source = encodeURIComponent(JSON.stringify({ agentUrl: "javascript:alert(1)" }));
  const refused = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = new WebSocket(`${stack.url.replace("http", "ws")}/connect?port=${local.port}`, {
      headers: { authorization: `Bearer ${token}`, "wurmhol-source": source },
    });
    socket.once("open", () => reject(new Error("the pipe opened")));
    socket.once("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    socket.once("error", () => {});
  });
  expect(refused.status).toBe(400);
  expect(JSON.parse(refused.body)).toMatchObject({ error: "bad agentUrl" });
  expect((await api<{ shares: Card[] }>(stack, ada, "/api/shares")).body.shares).toEqual([]);
});
