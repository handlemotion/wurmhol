// Renders the link preview, public/og.png (1200x630), from the network-create `og` scene in the
// site's light colors, with Inter loaded for the copy the scene sets. Run it after changing the
// scene (`node apps/site/scripts/og.mjs`) and commit the PNG. It also writes the SVG to the temp
// directory and prints its path, for network-create's check.mjs.
/* oxlint-disable no-console -- a CLI: printing is its output */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import scene from "../../../.claude/skills/network-create/scenes/flat/og.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const [W, H] = [1200, 630];
// Colors from src/styles/global.css (light): foreground, primary, background.
const svg = scene({
  seed: 1,
  width: W,
  height: H,
  ink: "#171717",
  accent: "#0d3eef",
  paper: "#ffffff",
  stroke: 1,
}).render();

const out = process.argv[2] ?? join(site, "public", "og.png");
const composite = join(tmpdir(), "wurmhol-og.svg");
writeFileSync(composite, svg);

const font = readFileSync(
  require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
).toString("base64");
const { chromium } = require("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(
  `<style>@font-face{font-family:"Inter Variable";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}body{margin:0}svg{display:block}</style>${svg}`,
);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log(`${out}\n${composite}`);
