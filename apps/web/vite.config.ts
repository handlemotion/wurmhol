import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app and its API share one origin: in production the Worker serves both, and in dev Vite
// forwards `/api` (the wall's websocket included), `/open` and `/connect` to `wrangler dev`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Intent UI imports `cn` and `twJoin` from `cn`; tailwind-variants bundles the same engine.
      { find: /^cn$/, replacement: "tailwind-variants" },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/open": { target: "http://localhost:8787" },
    },
  },
  build: { sourcemap: true },
});
