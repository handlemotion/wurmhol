// Open shares on this machine: one JSON file per share, written by its daemon and removed when
// it exits. `wurmhol ls` and `wurmhol stop` read them.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ShareState {
  id: string;
  url: string;
  port: number;
  pid: number;
  startedAt: string;
  endsAt: string;
  /** What the pipe was opened with, so a repeat of the same command can reuse it. */
  request?: ShareRequest;
  /**
   * True while the share waits for someone to approve this computer (ADR 0026): `url` is the
   * approval link and `endsAt` the code's expiry. The pipe gets its own state once it opens.
   */
  approval?: boolean;
  /**
   * The id of the waiting share whose login this one waits on instead of starting its own: a
   * second share before anyone approved the first one's link opens once that link is approved.
   */
  follows?: string;
}

/** The options a pipe was asked for that change what it is; `--ttl` is not one of them. */
export interface ShareRequest {
  name: string | null;
  /** `--only`'s emails, trimmed, lowercased and sorted. */
  only: string[];
  link: string | null;
  note: string | null;
}

/** `WURMHOL_HOME`, or `~/.wurmhol`. */
export function home() {
  return process.env.WURMHOL_HOME || join(homedir(), ".wurmhol");
}

function sharesDir() {
  return join(home(), "shares");
}

export function logFile(name: string) {
  const dir = join(home(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.log`);
}

export function writeState(state: ShareState) {
  mkdirSync(sharesDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(sharesDir(), `${state.id}.json`), JSON.stringify(state), { mode: 0o600 });
}

export function removeState(id: string) {
  rmSync(join(sharesDir(), `${id}.json`), { force: true });
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every share whose daemon is still running; files of dead ones are cleaned up. */
export function listStates(): ShareState[] {
  let files: string[];
  try {
    files = readdirSync(sharesDir());
  } catch {
    return [];
  }
  const states: ShareState[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const state = JSON.parse(readFileSync(join(sharesDir(), file), "utf8")) as ShareState;
      if (alive(state.pid)) states.push(state);
      else removeState(state.id);
    } catch {
      rmSync(join(sharesDir(), file), { force: true });
    }
  }
  return states.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Whether `state` is the pipe `target` names: its port, its id, or a named pipe's name. */
export function matches(state: ShareState, target: string) {
  const wanted = target.trim().toLowerCase();
  return (
    state.id === target ||
    (/^\d+$/.test(wanted) && state.port === Number(wanted)) ||
    (!state.approval &&
      // A named pipe, by the name it was opened with: its URL may be a custom domain (ADR 0033),
      // whose first label is not the name. A state written before the name was kept goes by the
      // first label of its host.
      (state.request
        ? state.request.name === wanted
        : new URL(state.url).hostname.split(".")[0] === wanted))
  );
}
