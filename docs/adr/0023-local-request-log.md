# 0023: A request log on the agent's machine

Status: accepted. Extends ADR 0008 (privacy, the SDK's `request` events) and spec v1 section 7.

## Context

An agent shares a dev server, its human opens the link and something breaks: a blank page, a
failed checkout. The agent has no way to see what the human's browser asked for. The tunnel
already knows each request's method, path, status and duration (the SDK's `request` event), but
the CLI's daemon dropped them, and the relay keeps no per-request log by design (ADR 0008: "It is
exactly the browsing history we promise not to keep").

## Decision

- **The daemon writes each answered request to its pipe's log on this machine**,
  `~/.wurmhol/logs/<id>.log`, next to the connection events it already wrote there. A line holds
  the time, method, path, status and duration. Query names stay and their values are dropped
  (`/cb?code=&state=`), because values carry codes and tokens. Bodies, headers and cookies are
  never written. The `wurmhol mcp` server does the same for the pipes it holds.
- **Bounded.** Past 1 MiB a log moves to `<id>.log.1`, replacing the one before, so a pipe keeps
  at most about 2 MiB.
- **Read locally.** `wurmhol logs <port|id|name>` (`--follow`, `--json`) and the local MCP
  server's `recent_requests` tool read it. An ended pipe's log stays readable by its id.
- **The relay is unchanged.** Nothing new leaves the machine, and the hosted MCP server cannot
  see these logs.

## Consequences

- The log is the browsing history of whoever opened the pipe, on the computer of whoever opened
  it. That is the person who already serves every page, so it reveals nothing they could not log
  themselves. It is still kept small and free of values.
- Logs are not pruned by age; `~/.wurmhol/logs` grows by at most 2 MiB per pipe opened.
