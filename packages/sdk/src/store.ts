// Where a token is kept between runs. The SDK holds no token on its own: an app passes one, or a
// store that loads it. Two stores ship: in memory, and a file (mode 0600, replaced atomically).
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** The token a device login granted, with the server it belongs to. */
export interface StoredToken {
  server: string;
  token: string;
  org: string | null;
  /** The computer's name the token was granted for. */
  name: string;
}

/**
 * Keeps one token. A token is only ever used against the server it was saved with, so a token
 * for one install is never sent to another: `load` returns null for another server.
 */
export interface TokenStore {
  load(server: string): StoredToken | null | Promise<StoredToken | null>;
  save(token: StoredToken): void | Promise<void>;
  clear(): void | Promise<void>;
}

export function memoryTokenStore(initial?: StoredToken): TokenStore {
  let held = initial ?? null;
  return {
    load: (server) => (held && held.server === server ? held : null),
    save: (token) => void (held = token),
    clear: () => void (held = null),
  };
}

/** The token in the file at `path`, or null when there is none or it is not one. */
export function readTokenFile(path: string): StoredToken | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<StoredToken>;
    if (typeof parsed.server !== "string" || typeof parsed.token !== "string") return null;
    return {
      server: parsed.server,
      token: parsed.token,
      org: parsed.org ?? null,
      name: parsed.name ?? "",
    };
  } catch {
    return null;
  }
}

/** Writes the token to `path` with mode 0600, creating its directory (0700) and replacing it. */
export function writeTokenFile(path: string, token: StoredToken) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Written to a sibling and renamed over the target, so a crash leaves the old token or the new
  // one, never half of one. `mode` applies only when a file is created, so the descriptor is
  // tightened too: no window where the token sits in a wider file.
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(token, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** Deletes the token file. False when there was none. */
export function removeTokenFile(path: string) {
  const existed = readTokenFile(path) !== null;
  rmSync(path, { force: true });
  return existed;
}

export function fileTokenStore(path: string): TokenStore {
  return {
    load: (server) => {
      const stored = readTokenFile(path);
      return stored && stored.server === server ? stored : null;
    },
    save: (token) => writeTokenFile(path, token),
    clear: () => void removeTokenFile(path),
  };
}
