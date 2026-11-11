import { defineConfig } from "tsdown";

// Two entries for npm: the CLI (`bin`) and the package's export (`openPipe`), with its types. The
// protocol and SDK packages are private to the workspace, so they are bundled in; `ws` and the proxy helpers stay dependencies.
// The plugin's skill is bundled into the CLI as text for `init --skill`. The MCP SDK and zod are
// bundled into the chunk only `wurmhol mcp` imports, so `npx wurmhol <port>` installs and loads
// nothing more for them.
export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    clean: true,
    dts: false,
    loader: { ".md": "text" },
    deps: {
      alwaysBundle: ["@wurmhol/protocol", "@wurmhol/sdk", "@modelcontextprotocol/sdk", "zod"],
    },
  },
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    clean: false,
    dts: { sourcemap: false },
    sourcemap: false,
    deps: { alwaysBundle: ["@wurmhol/protocol", "@wurmhol/sdk"] },
  },
]);
