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
