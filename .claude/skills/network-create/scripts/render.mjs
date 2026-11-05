#!/usr/bin/env node
// Renders scene files to SVG (and PNG at 2x, through the pre-installed Playwright Chromium).
//
//   node render.mjs <scene.mjs ...> [--out dir] [--png] [--theme light|dark|both]
//                   [--tone strong|quiet] [--seed n] [--size WxH] [--stroke px]
//                   [--ink color] [--accent color] [--paper color|none] [--seeds n]
//                   [--tsx ComponentName] [--sheet]
//
// A scene file default-exports `(o) => scene`, where `o` is
// `{ seed, theme, tone, ink, accent, paper, width, height, stroke }`. `--ink currentColor`
// writes an SVG that takes its color from CSS (for embedding in the app); `--sheet` also writes
// `index.html`, a contact sheet of everything rendered. `--seeds n` renders seeds 1..n of each
// scene (`<name>-s<seed>`), to compare variants side by side. `--tsx Name` also writes
// `<name>.tsx`, a React component with the SVG as JSX that passes `className` through, for
// shipping a plate into apps/web (use with `--ink currentColor --paper none`).
/* oxlint-disable no-console -- a CLI: printing is its output */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { THEMES } from "./engine.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const valued = new Set([
  "out",
  "theme",
  "tone",
  "seed",
  "seeds",
  "size",
  "stroke",
  "ink",
  "accent",
  "paper",
  "tsx",
]);
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

const seeds = has("seeds")
  ? Array.from({ length: Number(flag("seeds")) }, (_, i) => i + 1)
  : [seed];

/**
 * SVG markup to a React component: attributes to camelCase, `className` on the root. A plate
 * with an `origin` (a viewBox that doesn't start at 0 0) is anchored: it renders at true size,
 * offset so its (0, 0) lands on the top left of its positioned parent. Any other plate scales
 * to cover its box.
 */
function toTsx(name, svg, scene) {
  const [x, y, w, h] = svg
    .match(/viewBox="([^"]+)"/)[1]
    .split(" ")
    .map(Number);
  const anchored = x !== 0 || y !== 0;
  const root = anchored
    ? `<svg $1 className={className} aria-hidden="true" style={{ position: "absolute", left: ${x}, top: ${y}, width: ${w}, height: ${h}, maxWidth: "none" }}>`
    : '<svg $1 className={className} aria-hidden="true" preserveAspectRatio="xMidYMid slice">';
  const jsx = svg
    .replace(/<svg ([^>]*?) width="[^"]+" height="[^"]+">/, root)
    .replace(
      / ([a-z]+)-([a-z]+)(?:-([a-z]+))?=/g,
      (_, a, b, c) =>
        ` ${a}${b[0].toUpperCase()}${b.slice(1)}${c ? c[0].toUpperCase() + c.slice(1) : ""}=`,
    )
    .replace("ariaHidden=", "aria-hidden=");
  return `// Generated from ${scene} by .claude/skills/network-create/scripts/render.mjs --tsx.
// Edit the scene and regenerate; don't edit this file.
export function ${name}({ className }: { className?: string }) {
  return (
    ${jsx.replace(/\n/g, "\n    ")}
  );
}
`;
}

const rendered = [];
for (const file of files) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  for (const theme of themes)
    for (const seed of seeds) {
      const t = THEMES[theme];
      const paper = flag("paper", t.paper);
      const o = {
        seed,
        theme,
        tone,
        width,
        height,
        ink: flag("ink", t[tone]),
        accent: flag("accent", t.accent),
        paper: paper === "none" ? null : paper,
        stroke: Number(flag("stroke", 1)),
      };
      const svg = mod.default(o).render();
      const name = `${basename(file, ".mjs")}${themes.length > 1 ? `-${theme}` : ""}${seeds.length > 1 ? `-s${seed}` : ""}`;
      writeFileSync(join(out, `${name}.svg`), svg);
      if (has("tsx"))
        writeFileSync(
          join(out, `${name}.tsx`),
          toTsx(flag("tsx"), svg, relative(process.cwd(), resolve(file))),
        );
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
