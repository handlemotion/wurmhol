// Where a pipe came from (ADR 0015): the repo, branch and commit of the directory the CLI ran in,
// the agent session that ran it, and an optional link and note. The CLI builds it and the Worker
// checks it with the same rules, so whatever the CLI sends is what the Worker accepts. Every
// field is optional and bounded; URLs are http or https only.

export interface PipeSource {
  /** The forge's host, like `github.com`. */
  repoHost: string | null;
  /** The repo's path on its forge, like `owner/name` (GitLab groups add segments). */
  repo: string | null;
  branch: string | null;
  /** The full commit hash. */
  commit: string | null;
  /** `--link`: any http(s) URL the agent wants next to the pipe, like an issue. */
  link: string | null;
  /** `--note`: one line of text. */
  note: string | null;
  /** The agent that opened the pipe, as people call it: `Claude Code`. */
  agent: string | null;
  /** A page for the agent's session, when its environment says where one is. */
  agentUrl: string | null;
}

export const SOURCE_LIMITS = {
  repoHost: 253,
  repo: 200,
  branch: 250,
  link: 2048,
  note: 280,
  agent: 40,
  agentUrl: 2048,
} as const;

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** `value` as an http(s) URL of at most `max` characters, or null. */
function httpUrl(value: string, max: number): string | null {
  if (value.length > max) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href.length > max ? null : url.href;
  } catch {
    return null;
  }
}

function line(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= max && !CONTROL.test(text) ? text : null;
}

/** Each field's check: the field's value, normalised, or null when it is not valid. */
const FIELDS: { [K in keyof PipeSource]: (value: string) => string | null } = {
  repoHost: (value) => {
    const host = value.toLowerCase();
    return host.length <= SOURCE_LIMITS.repoHost && HOST.test(host) ? host : null;
  },
  repo: (value) => {
    const segments = value.split("/");
    return value.length <= SOURCE_LIMITS.repo &&
      segments.length >= 2 &&
      segments.every((s) => REPO_SEGMENT.test(s) && s !== "." && s !== "..")
      ? value
      : null;
  },
  // Git's own ref rules are looser than this; a branch with spaces or control characters is not
  // one we need to show.
  branch: (value) =>
    value.length <= SOURCE_LIMITS.branch && /^[^\s~^:?*[\\]+$/.test(value) && !CONTROL.test(value)
      ? value
      : null,
  commit: (value) => (COMMIT.test(value) ? value : null),
  link: (value) => httpUrl(value, SOURCE_LIMITS.link),
  note: (value) => line(value, SOURCE_LIMITS.note),
  agent: (value) => line(value, SOURCE_LIMITS.agent),
  agentUrl: (value) => httpUrl(value, SOURCE_LIMITS.agentUrl),
};

export const SOURCE_FIELDS = Object.keys(FIELDS) as (keyof PipeSource)[];

/** One field's value, normalised, or null when it is not valid for that field. */
export function sourceField(field: keyof PipeSource, value: string): string | null {
  return FIELDS[field](value);
}

/** What to do about a field the Worker refuses, as the CLI prints it. */
export const SOURCE_FIXES: Record<keyof PipeSource, string> = {
  repoHost: "The repo's host is not a hostname.",
  repo: "The repo is not a path like owner/name.",
  branch: "The branch name is not one wurmhol can show.",
  commit: "The commit is not a hex hash.",
  link: `Pass an http or https URL of at most ${SOURCE_LIMITS.link} characters to --link.`,
  note: `Pass one line of at most ${SOURCE_LIMITS.note} characters to --note.`,
  agent: "The agent's name is not one line of at most 40 characters.",
  agentUrl: "The agent's session URL is not an http or https URL.",
};

export type SourceResult =
  | { ok: true; source: PipeSource | null }
  | { ok: false; field: keyof PipeSource; fix: string };

/**
 * Checks a source as it arrives from a client: an object of optional string fields. Unknown keys
 * are ignored; null or absent fields are left out; any other invalid field is refused. A source
 * with no field set is null.
 */
export function parsePipeSource(raw: unknown): SourceResult {
  if (raw === null || raw === undefined) return { ok: true, source: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field: "note", fix: "The pipe's source is not an object." };
  }
  const source = Object.fromEntries(SOURCE_FIELDS.map((f) => [f, null])) as Record<
    keyof PipeSource,
    string | null
  >;
  let any = false;
  for (const field of SOURCE_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === null || value === undefined) continue;
    const checked = typeof value === "string" ? sourceField(field, value) : null;
    if (checked === null) return { ok: false, field, fix: SOURCE_FIXES[field] };
    source[field] = checked;
    any = true;
  }
  return { ok: true, source: any ? source : null };
}

/** `path` without leading and trailing slashes, in one linear pass (no backtracking regex). */
function trimSlashes(path: string) {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start++;
  while (end > start && path[end - 1] === "/") end--;
  return path.slice(start, end);
}

/**
 * A git remote URL as its forge's host and the repo's path, or null for a local path. Credentials
 * in the URL (`https://user:token@host/…`) are never part of the result.
 */
export function repoFromRemote(remote: string): { repoHost: string; repo: string } | null {
  const value = remote.trim();
  if (value.length > 2048) return null;
  let host: string;
  let path: string;
  // scp-like syntax: `git@github.com:owner/name.git`.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(url.protocol)) {
      return null;
    }
    host = url.port && url.protocol.startsWith("http") ? url.host : url.hostname;
    path = decodeURIComponent(url.pathname);
  }
  const repoHost = sourceField("repoHost", host);
  const repo = sourceField(
    "repo",
    trimSlashes(path)
      .replace(/\.git$/, "")
      .replace(/^~[^/]*\//, ""),
  );
  return repoHost && repo ? { repoHost, repo } : null;
}

/**
 * Agents known from a variable they set in the shell they run commands in, first match wins. Each
 * is verified in the agent's own source or docs, or a real run (ADR 0015 has the sources).
 */
const AGENTS: [agent: string, matches: (env: Record<string, string | undefined>) => boolean][] = [
  ["Claude Code", (env) => env.CLAUDECODE === "1"],
  ["Codex", (env) => Boolean(env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI)],
  ["Cursor", (env) => Boolean(env.CURSOR_AGENT)],
  ["Gemini CLI", (env) => env.GEMINI_CLI === "1"],
  ["OpenCode", (env) => env.OPENCODE === "1"],
  ["Cline", (env) => env.CLINE_ACTIVE === "true"],
];

/** The GitHub Actions run the CLI runs in (GitHub's coding agent, or any workflow), or null. */
function actionsRun(env: Record<string, string | undefined>): string | null {
  if (env.GITHUB_ACTIONS !== "true" || !/^\d+$/.test(env.GITHUB_RUN_ID ?? "")) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) return null;
  const server = sourceField("agentUrl", env.GITHUB_SERVER_URL || "https://github.com");
  return (
    server &&
    sourceField(
      "agentUrl",
      `${server.replace(/\/$/, "")}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    )
  );
}

/**
 * The agent session the environment says the CLI runs in, and a page for it when the environment
 * says where one is. Null when no agent or run is recognised.
 */
export function agentFromEnv(
  env: Record<string, string | undefined>,
): { agent: string; agentUrl: string | null } | null {
  // Claude Code on the web: `cse_<id>` is the session `session_<id>` at claude.ai/code.
  const remote = /^cse_([A-Za-z0-9]{10,64})$/.exec(env.CLAUDE_CODE_REMOTE_SESSION_ID ?? "");
  if (remote) {
    return { agent: "Claude Code", agentUrl: `https://claude.ai/code/session_${remote[1]}` };
  }
  const run = actionsRun(env);
  const agent = AGENTS.find(([, matches]) => matches(env))?.[0];
  if (agent) return { agent, agentUrl: run };
  return run ? { agent: "GitHub Actions", agentUrl: run } : null;
}
