// One JSON line per event, which Workers Logs indexes field by field (from Omni): `time`,
// `level`, `event`, then `component`, `requestId`, `orgId`, `shareId`, `durationMs` and ids.
// Never request or response bodies, tokens, cookies or query strings.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** An error reduced to what is safe to log: never its stack or cause. */
export interface LoggedError {
  readonly name: string;
  readonly message: string;
}

/** A value a log line can carry; anything else is reduced to one of these first. */
export type LogValue = string | number | boolean | null | undefined | LoggedError;

export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
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

export function createLogger(base: LogFields = {}): Logger {
  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    const line = { time: new Date().toISOString(), level, event, ...base, ...fields };
    sink[level](JSON.stringify(line));
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/**
 * A thrown value as a log field. Messages only, never stacks or causes: database errors can
 * quote bound values.
 */
export function loggedError(cause: unknown): LoggedError {
  if (cause instanceof Error) return { name: cause.name, message: cause.message.slice(0, 500) };

  return { name: "NonError", message: String(cause).slice(0, 500) };
}
