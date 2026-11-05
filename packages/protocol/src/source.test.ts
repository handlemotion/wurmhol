import { expect, it } from "vitest";
import { agentFromEnv, parsePipeSource, repoFromRemote } from "./source.ts";

it.each([
  ["git@github.com:handlemotion/wurmhol.git", "github.com", "handlemotion/wurmhol"],
  ["https://github.com/handlemotion/wurmhol", "github.com", "handlemotion/wurmhol"],
  ["https://github.com/handlemotion/wurmhol.git/", "github.com", "handlemotion/wurmhol"],
  ["ssh://git@github.com:22/handlemotion/wurmhol.git", "github.com", "handlemotion/wurmhol"],
  ["https://gitlab.com/group/sub/app.git", "gitlab.com", "group/sub/app"],
  ["http://git.internal:8080/team/app", "git.internal:8080", "team/app"],
])("reads %s as a host and repo", (remote, repoHost, repo) => {
  expect(repoFromRemote(remote)).toEqual({ repoHost, repo });
});

it("never carries credentials from the remote URL", () => {
  // Catches: a token embedded in an https remote (CI checkouts do this) sent to the relay and
  // shown on the wall.
  const parsed = repoFromRemote("https://x-access-token:ghs_secret@github.com/acme/app.git");
  expect(parsed).toEqual({ repoHost: "github.com", repo: "acme/app" });
  expect(JSON.stringify(parsed)).not.toContain("ghs_secret");
});

it("reads a remote of many slashes in linear time", () => {
  // Catches: a backtracking regex that takes seconds on a crafted remote (CodeQL's polynomial
  // regex alert), stalling the CLI before every pipe.
  const started = performance.now();
  expect(repoFromRemote(`https://github.com/a${"/".repeat(2000)}b`)).toBeNull();
  expect(repoFromRemote(`https://github.com/${"/".repeat(100_000)}x`)).toBeNull();
  expect(performance.now() - started).toBeLessThan(100);
});

it.each([
  // Catches: a local path's directories shown as a repo, or a file URL followed.
  "/srv/git/app.git",
  "../app",
  "file:///srv/git/app.git",
  "https://github.com/only-owner",
  "https://github.com/acme/../etc",
])("reads %s as no repo", (remote) => {
  expect(repoFromRemote(remote)).toBeNull();
});

it.each([
  // Catches: a script URL rendered as a link on the wall.
  ["link", "javascript:alert(1)"],
  ["agentUrl", "data:text/html,hi"],
  ["link", `https://example.com/${"a".repeat(2048)}`],
  ["note", "x".repeat(281)],
  ["commit", "not-a-hash"],
  ["branch", "feat/\u0007bell"],
  ["repo", "owner"],
])("refuses a %s of %s", (field, value) => {
  const result = parsePipeSource({ [field]: value });
  expect(result.ok).toBe(false);
  expect(!result.ok && result.field).toBe(field);
});

it("keeps valid fields, folds a note onto one line, and drops unknown keys", () => {
  const result = parsePipeSource({
    repoHost: "GitHub.com",
    repo: "acme/app",
    branch: "feat/checkout",
    commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    note: "  try the\ncheckout  ",
    link: "https://linear.app/acme/issue/ACME-1",
    extra: "ignored",
  });
  expect(result).toEqual({
    ok: true,
    source: {
      repoHost: "github.com",
      repo: "acme/app",
      branch: "feat/checkout",
      commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      note: "try the checkout",
      link: "https://linear.app/acme/issue/ACME-1",
      agent: null,
      agentUrl: null,
    },
  });
});

it("an empty source is no source", () => {
  // Catches: every pipe opened by an older CLI getting an empty "From" row on the wall.
  expect(parsePipeSource({})).toEqual({ ok: true, source: null });
  expect(parsePipeSource(undefined)).toEqual({ ok: true, source: null });
});

it("links a Claude Code cloud session to its page, and a local one to nothing", () => {
  expect(
    agentFromEnv({ CLAUDECODE: "1", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01XPuAcVtaPrJf" }),
  ).toEqual({ agent: "Claude Code", agentUrl: "https://claude.ai/code/session_01XPuAcVtaPrJf" });
  expect(agentFromEnv({ CLAUDECODE: "1" })).toEqual({ agent: "Claude Code", agentUrl: null });
  // Catches: a crafted id turning the session link into another URL.
  expect(agentFromEnv({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_x/../../evil" })).toBeNull();
  expect(agentFromEnv({})).toBeNull();
});

it("names a verified agent, and links it to the Actions run it runs in", () => {
  const run = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_RUN_ID: "123",
  };
  expect(agentFromEnv({ ...run, CODEX_THREAD_ID: "0193" })).toEqual({
    agent: "Codex",
    agentUrl: "https://github.com/acme/app/actions/runs/123",
  });
  expect(agentFromEnv(run)).toEqual({
    agent: "GitHub Actions",
    agentUrl: "https://github.com/acme/app/actions/runs/123",
  });
  // Catches: a repository value that turns the run link into a path elsewhere on the host.
  expect(agentFromEnv({ ...run, GITHUB_REPOSITORY: "acme/app/../../x" })).toBeNull();
  expect(agentFromEnv({ CURSOR_AGENT: "1" })).toEqual({ agent: "Cursor", agentUrl: null });
});
