// A pipe's log on this machine (ADR 0023): `~/.wurmhol/logs/<id>.log`, one JSON object a line.
// The daemon writes its connection's events there and, per viewer request the dev server
// answered, the method, the path with its query values dropped, the status and the duration:
// never bodies, headers, cookies or query values. It stays here; the relay keeps none of it.
// Each file is capped: past MAX_BYTES it moves to `<id>.log.1`, replacing the one before.
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  appendFileSync,
} from "node:fs";
import {
  isFiniteNumber,
  isJsonObject,
  isString,
  type JsonObject,
  parseJson,
} from "@wurmhol/protocol";
import type { LogFields, RequestEvent } from "@wurmhol/sdk";
import { logFile } from "./state.ts";

/** Where a log moves on; at most twice this is kept per pipe. */
const MAX_BYTES = 1024 * 1024;

export interface LogRecord extends JsonObject {
  time: string;
  event: string;
}

/** A logged request: what `wurmhol logs` and `recent_requests` show. */
export interface RequestRecord {
  time: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/** Bytes written to each log by this process, so a size check needs no `stat` per line. */
const sizes = new Map<string, number>();

function sizeOf(file: string) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Appends one record to `name`'s log, moving it to `.1` once it is full. Never throws. */
export function appendLog(name: string, event: string, fields: LogFields = {}) {
  try {
    const file = logFile(name);
    const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`;
    let size = sizes.get(file) ?? sizeOf(file);

    if (size > 0 && size + line.length > MAX_BYTES) {
      renameSync(file, `${file}.1`);
      size = 0;
    }

    appendFileSync(file, line, { mode: 0o600 });
    sizes.set(file, size + Buffer.byteLength(line));
  } catch {
    // Logging must never take the pipe down.
  }
}

/**
 * The path as logged: query names kept, their values dropped (`/cb?code=&state=`), since values
 * carry codes and tokens. The fragment never reaches the server.
 */
export function loggedPath(path: string) {
  const at = path.indexOf("?");

  if (at === -1) return path;

  const names = path
    .slice(at + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => `${pair.split("=")[0]}=`);

  return `${path.slice(0, at)}?${names.join("&")}`;
}

/** Logs a request the dev server answered, metadata only. */
export function appendRequest(name: string, request: RequestEvent, fields: LogFields) {
  const { method, path, status, durationMs } = request;
  appendLog(name, "request", { ...fields, method, path: loggedPath(path), status, durationMs });
}

function parse(text: string): LogRecord[] {
  const records: LogRecord[] = [];

  for (const line of text.split("\n")) {
    if (!line) continue;

    try {
      const record = parseJson(line);

      if (isJsonObject(record) && isString(record.time) && isString(record.event)) {
        records.push({ ...record, time: record.time, event: record.event });
      }
    } catch {
      // A line cut short by a crash.
    }
  }

  return records;
}

function readIfExists(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every record in `name`'s log, oldest first, or null when it has none. */
export function readLog(name: string): LogRecord[] | null {
  const file = logFile(name);
  const older = readIfExists(`${file}.1`);
  const current = readIfExists(file);

  if (older === null && current === null) return null;

  return parse(`${older ?? ""}${current ?? ""}`);
}

/** The request a record logs, or null when it is another event. */
export function requestOf(record: LogRecord): RequestRecord | null {
  const { time, event, method, path, status, durationMs } = record;

  if (event !== "request" || !isString(method) || !isString(path)) return null;

  if (!isFiniteNumber(status) || !isFiniteNumber(durationMs)) return null;

  return { time, method, path, status, durationMs };
}

/** The last `limit` requests in `name`'s log, oldest first; null when it has no log. */
export function recentRequests(name: string, limit: number): RequestRecord[] | null {
  const records = readLog(name);

  return (
    records &&
    records
      .flatMap((record) => {
        const request = requestOf(record);

        return request ? [request] : [];
      })
      .slice(-limit)
  );
}

/**
 * Calls `onRecord` for each record appended to `name`'s log from now on, until `signal` aborts.
 * Polls, so it follows the file across rotation.
 */
export function followLog(
  name: string,
  onRecord: (record: LogRecord) => void,
  signal: AbortSignal,
) {
  const file = logFile(name);
  let offset = sizeOf(file);
  let partial = "";

  const timer = setInterval(() => {
    const size = sizeOf(file);

    // Moved to `.1` and started again: read the new file from its start.
    if (size < offset) offset = 0;

    if (size === offset) return;
    const buffer = Buffer.alloc(size - offset);
    let fd: number;

    try {
      fd = openSync(file, "r");
    } catch {
      return;
    }

    try {
      readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      closeSync(fd);
    }

    offset = size;
    const text = partial + buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    partial = text.slice(end + 1);

    for (const record of parse(text.slice(0, end + 1))) onRecord(record);
  }, 250);

  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
