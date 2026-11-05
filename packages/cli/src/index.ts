// The `wurmhol` package's export: open a pipe from your own process (ADR 0008, section 3).
//
//   const pipe = await openPipe({ port: 5173, token: process.env.WURMHOL_TOKEN! });
//   pipe.url; // send it to the humans
//   pipe.on("request", ({ method, path, status, durationMs }) => {});
//   pipe.on("close", (reason) => {});
//   await pipe.close();
import { openPipe as open, type OpenPipeOptions, type Pipe } from "./pipe.ts";

export { FixError } from "./errors.ts";
export type { CloseReason, OpenPipeOptions, Pipe, PipeEvents, RequestEvent } from "./pipe.ts";

/**
 * Opens a pipe to a local port and resolves once the relay has given it its URL. Rejects with a
 * `FixError` whose message says the fix in one line, as the CLI prints it.
 */
export function openPipe(options: OpenPipeOptions): Promise<Pipe> {
  return open(options);
}
