// One JSON line per event, which Workers Logs indexes field by field (from Omni): `time`,
// `level`, `event`, then `component`, `requestId`, `orgId`, `shareId`, `durationMs` and ids.
// Never request or response bodies, tokens, cookies or query strings.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** What web and iOS send, and what every response carries back. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The caller's request ID when it is well-formed, else a fresh one. Never echoes junk. */
export function requestIdFrom(value: string | null | undefined): string {
  return value && /^[\w-]{8,64}$/.test(value) ? value : crypto.randomUUID();
}

const sink: Record<LogLevel, (line: string) => void> = {
  // oxlint-disable-next-line no-console -- the log sink
  debug: (line) => console.debug(line),
  // oxlint-disable-next-line no-console -- the log sink
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const line = { time: new Date().toISOString(), level, event, ...base, ...fields };
    sink[level](JSON.stringify(line, replacer));
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  // Messages only, never stacks or causes: database errors can quote bound values.
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 500) };
  return value;
}
