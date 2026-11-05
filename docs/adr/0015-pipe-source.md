# 0015: Every pipe says where it came from

Status: accepted. Extends spec v1 section 3 (the wall's cards) and section 7 (the CLI). Adds to
what ADR 0008 lists as stored.

## Context

With several agents at work, the wall shows several pills with the same title (`Vite + React`)
and the same port. Nothing says which agent, branch or task a pipe belongs to, so people open
each one to find out. Linking a pipe to a pull request (the next ADR) needs the same facts.

## Decision

- **The CLI sends a source with a new pipe**, in a `Wurmhol-Source` header on `/connect`
  (URI-encoded JSON). A reconnect sends nothing: the pipe keeps what it started with.
- **Fields**, each optional, each checked by `@wurmhol/protocol`'s `parsePipeSource` on both ends:

  | Field               | From                                                  | Bound                          |
  | ------------------- | ----------------------------------------------------- | ------------------------------ |
  | `repoHost`, `repo`  | `git remote get-url origin`, as host and `owner/name` | hostname; 200 characters       |
  | `branch`            | `git symbolic-ref --short HEAD` (none when detached)  | 250 characters, no whitespace  |
  | `commit`            | `git rev-parse HEAD`                                  | 7 to 64 hex digits             |
  | `link`              | `--link <url>`                                        | http or https, 2048 characters |
  | `note`              | `--note "<text>"`                                     | one line, 280 characters       |
  | `agent`, `agentUrl` | the environment (below)                               | 40 characters; http or https   |

  Git runs in the directory the CLI was started in, with a 2-second limit; anything it cannot
  tell is left out and never stops a pipe. Credentials in a remote URL
  (`https://x-access-token:…@github.com/…`) are never sent: only the host and the path are.
  `openPipe({ source })` takes the same fields; the SDK detects nothing on its own.

- **The Worker refuses a bad field** with 400 and a fix, before the pipe opens, whatever client
  sent it: URLs that are not http(s) (`javascript:`, `data:`) never reach the wall.
- **Stored** on the share's history row (`shares.repo_host`, `repo`, `branch`, `commit_sha`,
  `link`, `note`, `agent`, `agent_url`), pruned with it after `RETENTION_DAYS`. It is the agent's
  own description of itself, not relayed traffic, so the rule that bodies are never stored is
  unchanged. It reaches the wall's card and `GET /v1/pipes` as `source`.
- **The open card shows a From row**: `Claude Code session ↗ · feat/checkout @ a1b2c3d`, with
  the repo, branch and full commit on hover; then a Note row and a Link row when set.
- Nothing to configure: self-hosted installs get it with the migration.

### Agents, and how each was verified

Only variables confirmed in the agent's own source code or docs, or seen in a real run, are used.

| Agent           | Variable                                                                    | Session link                                 | Verified                                                                      |
| --------------- | --------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Claude Code web | `CLAUDE_CODE_REMOTE_SESSION_ID=cse_<id>`                                    | `https://claude.ai/code/session_<id>`        | A real cloud session, 2026-11-05: the variable and the session's own id agree |
| Claude Code     | `CLAUDECODE=1`                                                              | none                                         | Same run; also used by `@vercel/detect-agent` and `std-env`                   |
| Codex CLI       | `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CODEX_CI`                              | none (the thread id has no public page)      | `openai/codex` source: `shell_environment.rs`, `spawn.rs`                     |
| Cursor          | `CURSOR_AGENT`                                                              | none                                         | cursor.com/docs/agent/terminal                                                |
| Gemini CLI      | `GEMINI_CLI=1`                                                              | none                                         | `google-gemini/gemini-cli` source and docs (`docs/tools/shell.md`)            |
| OpenCode        | `OPENCODE=1`                                                                | none                                         | `sst/opencode` source (`tool/plugin/shell.ts`)                                |
| Cline           | `CLINE_ACTIVE=true`                                                         | none                                         | `cline/cline` source (`VscodeTerminalRegistry.ts`)                            |
| GitHub Actions  | `GITHUB_ACTIONS`, `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID` | the run: `<server>/<repo>/actions/runs/<id>` | GitHub's documented default variables. Copilot's coding agent runs on Actions |

An agent found inside an Actions run links to that run. Not used, because we could not verify
them: any variable for Codex cloud tasks, Cursor's background agents, Devin, Jules, Windsurf,
Aider or Amp (`AMP_THREAD_ID` appears only on third-party pages); `COPILOT_AGENT*`; and
`AI_AGENT`, which has no spec and whose values differ by agent (`claude-code_<version>_agent`,
`opencode`, `github_copilot_cloud_agent`). Add an agent here when its variable is verified.

## Consequences

- A pipe opened from a repo tells everyone in the org its branch and commit. That is the point;
  to share without it, run the CLI outside the repo, or pass `openPipe` no source.
- An older CLI sends no source; its pipes look as before (no From row).
- Detection is best effort: an agent that sets none of these variables shows only its branch.
