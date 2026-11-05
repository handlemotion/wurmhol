// @ts-check
import { defineConfig } from "astro/config";

// Static output only: the build is plain files that a Worker serves as static assets
// (wrangler.jsonc). `site` makes canonical and Open Graph URLs absolute.
export default defineConfig({
  site: "https://wurmhol.com",
});
