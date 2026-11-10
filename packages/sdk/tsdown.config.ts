import { defineConfig } from "tsdown";

// The SDK's npm build: ESM for Node 22+ and Bun, with types. The protocol package is private to
// the workspace, so it is bundled in; `ws` and the proxy helpers stay dependencies.
export default defineConfig({
  entry: ["src/index.ts", "src/internal.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  clean: true,
  dts: { sourcemap: false },
  sourcemap: false,
  deps: { alwaysBundle: ["@wurmhol/protocol"] },
});
