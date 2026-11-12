// Where a pipe comes from (ADR 0015): the git repo, branch and commit of the directory the CLI
// runs in, and the agent session its environment names. Anything it cannot tell is left out;
// none of it ever stops a pipe from opening.
import { execFile } from "node:child_process";
import { agentFromEnv, type PipeSource, repoFromRemote, sourceField } from "@wurmhol/protocol";

/** One git command's trimmed output, or null when git is missing, slow or not in a repo. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 2000, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : stdout.trim() || null),
    );
  });
}

export async function detectSource(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<Partial<PipeSource>> {
  const [branch, commit, remote] = await Promise.all([
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(cwd, ["remote", "get-url", "origin"]),
  ]);

  const repo = remote ? repoFromRemote(remote) : null;
  const agent = agentFromEnv(env);

  const source: Partial<PipeSource> = {
    repoHost: repo?.repoHost ?? null,
    repo: repo?.repo ?? null,
    branch: branch && sourceField("branch", branch),
    commit: commit && sourceField("commit", commit),
    agent: agent?.agent ?? null,
    agentUrl: agent?.agentUrl ?? null,
  };

  return source;
}
