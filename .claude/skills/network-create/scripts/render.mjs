#!/usr/bin/env node
// Renders scene files to SVG (and PNG at 2x, through the pre-installed Playwright Chromium).
//
//   node render.mjs <scene.mjs ...> [--out dir] [--png] [--theme light|dark|both]
//                   [--tone strong|quiet] [--seed n] [--size WxH] [--stroke px]
//                   [--ink currentColor] [--sheet]
//
// A scene file default-exports `(o) => scene`, where `o` is
// `{ seed, theme, tone, ink, accent, paper, width, height, stroke }`. `--ink currentColor`
// writes an SVG that takes its color from CSS (for embedding in the app); `--sheet` also writes
// `index.html`, a contact sheet of everything rendered.
/* oxlint-disable no-console -- a CLI: printing is its output */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { THEMES } from "./engine.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const valued = new Set(["out", "theme", "tone", "seed", "size", "stroke", "ink"]);
const files = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]?.slice(2)));

if (!files.length) {
  console.error(
    "usage: node render.mjs <scene.mjs ...> [--out dir] [--png] [--theme light|dark|both]",
  );
  process.exit(1);
}

const out = resolve(flag("out", "network-out"));
const themes = flag("theme", "light") === "both" ? ["light", "dark"] : [flag("theme", "light")];
const tone = flag("tone", "strong");
const seed = Number(flag("seed", 1));
const [width, height] = flag("size", "1200x1200").split("x").map(Number);
mkdirSync(out, { recursive: true });

const rendered = [];
for (const file of files) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  for (const theme of themes) {
    const t = THEMES[theme];
    const o = {
      seed,
      theme,
      tone,
      width,
      height,
      ink: flag("ink", t[tone]),
      accent: t.accent,
      paper: t.paper,
      stroke: Number(flag("stroke", 1)),
    };
    const svg = mod.default(o).render();
    const name = `${basename(file, ".mjs")}${themes.length > 1 ? `-${theme}` : ""}`;
    writeFileSync(join(out, `${name}.svg`), svg);
    rendered.push({ name, svg, paper: t.paper });
    console.log(`${name}.svg  ${(svg.length / 1024).toFixed(0)} KB`);
  }
}

if (has("png") || has("sheet")) {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  for (const r of rendered) {
    await page.setContent(
      `<html><body style="margin:0;background:${r.paper}">${r.svg}</body></html>`,
    );
    await page.locator("svg").screenshot({ path: join(out, `${r.name}.png`) });
  }
  await browser.close();
}

if (has("sheet")) {
  const tiles = rendered
    .map(
      (r) =>
        `<figure><img src="${r.name}.png" style="background:${r.paper}"><figcaption>${r.name}</figcaption></figure>`,
    )
    .join("\n");
  writeFileSync(
    join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Network sheet</title><style>body{margin:24px;font:12px ui-monospace,monospace;background:#f3f3f3;display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}figure{margin:0}img{width:100%;display:block;border:1px solid #e8e8e8}figcaption{padding:6px 0}</style>${tiles}`,
  );
  console.log(`sheet: ${join(out, "index.html")}`);
}
