// Renders the link preview, public/og.png (1200x630): the `og` network scene with the wordmark
// and headline in its text column, in Inter, in the site's light colors. Run it after changing
// the scene or the headline (`node apps/site/scripts/og.mjs`), then commit the PNG. It also
// writes the composite SVG to the temp directory and prints its path, for network-create's
// check.mjs.
/* oxlint-disable no-console -- a CLI: printing is its output */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import scene, { TEXT } from "../../../.claude/skills/network-create/scenes/flat/og.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// Colors from src/styles/global.css (light): foreground, primary, background.
const INK = "#171717";
const ACCENT = "#0d3eef";
const PAPER = "#ffffff";
const W = 1200;
const H = 630;

const plate = scene({
  seed: 1,
  width: W,
  height: H,
  ink: INK,
  accent: ACCENT,
  paper: PAPER,
  stroke: 1,
});
const text = [
  `<text font-family="Inter" font-size="64" font-weight="600" letter-spacing="-1.3" fill="${INK}" x="${TEXT.x}" y="${TEXT.y + 58}">Wurmhol</text>`,
  `<text font-family="Inter" font-size="32" letter-spacing="-0.4" fill="${INK}" x="${TEXT.x}" y="${TEXT.y + 128}">A private URL for your</text>`,
  `<text font-family="Inter" font-size="32" letter-spacing="-0.4" fill="${INK}" x="${TEXT.x}" y="${TEXT.y + 170}">agent's dev server.</text>`,
].join("\n");
const svg = plate.render().replace("</svg>", `${text}\n</svg>`);
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
  `<style>@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}body{margin:0}svg{display:block}</style>${svg}`,
);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log(`${out}\n${composite}`);
