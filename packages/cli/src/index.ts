// The `wurmhol` package's export: open a pipe from your own process (ADR 0008, section 3).
//
//   const pipe = await openPipe({ port: 5173, token: process.env.WURMHOL_TOKEN! });
//   pipe.url; // send it to the humans
//   pipe.on("request", ({ method, path, status, durationMs }) => {});
//   pipe.on("close", (reason) => {});
//   await pipe.close();
//
// The whole SDK (sign-in, a pipe that reopens, the org's pipes) is exported from here too (ADR
// 0030); `openPipe` and its types are unchanged.
export * from "@wurmhol/sdk";
