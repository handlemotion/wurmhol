// What the `wurmhol` CLI needs beyond the public API. Not covered by the SDK's versioning.
export { dial } from "./dial.ts";

export type { DialOptions } from "./dial.ts";

export { explainConnectError, explainRefusal, isTlsError } from "./errors.ts";

export { errorCode, proxyFor, send, userAgent } from "./http.ts";

export type { Answer } from "./http.ts";

export { Loopback } from "./loopback.ts";

export {
  DEFAULT_CONSOLE,
  DEFAULT_PIPE_DOMAIN,
  DEFAULT_SERVER,
  originOf,
  openPipe as openPipeWithInternals,
  pagePath,
  pageUrl,
} from "./pipe.ts";

export type { Internals } from "./pipe.ts";

export type { WsConnection } from "./transport/index.ts";

export { WS_OPEN } from "./transport/index.ts";
