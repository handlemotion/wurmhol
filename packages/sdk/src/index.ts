// @wurmhol/sdk: embed Wurmhol pipes in your own app (ADR 0030). ESM, Node 22+ and Bun (a compiled
// Bun binary included).
//
//   import { Wurmhol, fileTokenStore } from "@wurmhol/sdk";
//
//   const wurmhol = new Wurmhol({ tokenStore: fileTokenStore("/path/to/token.json") });
//   if (!(await wurmhol.auth.status())) {
//     await wurmhol.auth.login({ name: "My App", prompt: (c) => open(c.verification_uri_complete) });
//   }
//   const pipe = wurmhol.pipes.keepOpen({ port: 4748, name: "my-app", accessKey });
//   await pipe.ready();
//   pipe.url; // stable for a named pipe
export { Wurmhol } from "./client.ts";
export type { KeepOpenOptions, PipeInfo, PipeOptions, WurmholOptions } from "./client.ts";

export { openPipe } from "./pipe.ts";
export type {
  CloseReason,
  OpenPipeOptions,
  Pipe,
  PipeEvents,
  PipeSource,
  PipeState,
  RequestEvent,
} from "./pipe.ts";

export { keepOpen } from "./managed.ts";
export type {
  ManagedCloseReason,
  ManagedPipe,
  ManagedPipeEvents,
  ManagedPipeOptions,
  ManagedState,
  ReopenPolicy,
} from "./managed.ts";

export { awaitLogin, login, redeem, startLogin } from "./auth.ts";
export type { DeviceCode, Granted, LoginOptions, RedeemOptions } from "./auth.ts";

export {
  fileTokenStore,
  memoryTokenStore,
  readTokenFile,
  removeTokenFile,
  writeTokenFile,
} from "./store.ts";
export type { StoredToken, TokenStore } from "./store.ts";

export { grantHeaders, WurmholEmbed } from "./embed.ts";
export type {
  EmbedConnector,
  EmbedCounts,
  EmbedGrant,
  EmbedGrantEvent,
  EmbedSubject,
  EmbedTenant,
  EmbedTunnel,
  EmbedTunnelState,
  EmbedUsage,
  GrantKind,
  SubjectKind,
  WurmholEmbedOptions,
} from "./embed.ts";

export { GRANT_CLOSE_CODES, GRANT_PROTOCOL, grantProtocols, tunnelSocket } from "./browser.ts";
export type { SocketLike, TunnelSocket, TunnelSocketOptions } from "./browser.ts";

export { FixError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

export type { DomainState, PipeDomain } from "./domains.ts";

export { runtime, selectTransport } from "./transport/index.ts";
export type { Runtime, TransportChoice } from "./transport/index.ts";
