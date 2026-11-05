import { defineConfig } from "tsdown";

// One file for npm: the protocol package is private, so it is bundled in; `ws` and the proxy
// helpers stay dependencies.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
  clean: true,
  dts: false,
  deps: { alwaysBundle: ["@wurmhol/protocol"] },
});
