import { defineConfig } from "tsdown";

// Two entries for npm: the CLI (`bin`) and `wurmhol/sdk`, with the SDK's types. The protocol
// package is private, so it is bundled in; `ws` and the proxy helpers stay dependencies. The
// plugin's skill is bundled into the CLI as text for `init --skill`.
export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: "esm",
    platform: "node",
    target: "node20",
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    clean: true,
    dts: false,
    loader: { ".md": "text" },
    deps: { alwaysBundle: ["@wurmhol/protocol"] },
  },
  {
    entry: ["src/sdk.ts"],
    format: "esm",
    platform: "node",
    target: "node20",
    outDir: "dist",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    clean: false,
    dts: { sourcemap: false },
    sourcemap: false,
    deps: { alwaysBundle: ["@wurmhol/protocol"] },
  },
]);
