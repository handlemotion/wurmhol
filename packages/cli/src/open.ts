// `openPipe` as the CLI calls it: the SDK's, naming this app in the User-Agent the relay sees.
import { type Internals, openPipeWithInternals } from "@wurmhol/sdk/internal";
import type { OpenPipeOptions, Pipe } from "@wurmhol/sdk";
import pkg from "../package.json" with { type: "json" };

export const CLIENT = { name: "wurmhol", version: pkg.version };

export function openPipe(options: OpenPipeOptions, internals?: Internals): Promise<Pipe> {
  return openPipeWithInternals({ client: CLIENT, ...options }, internals);
}
