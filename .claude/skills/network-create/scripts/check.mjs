#!/usr/bin/env node
// Holds an SVG to the network style: one stroke width, one ink plus at most one accent, at
// most two dot sizes (node and pivot), no gradients, filters, opacity or blur.
//
//   node check.mjs <file.svg ...>
/* oxlint-disable no-console -- a CLI: printing is its output */
import { readFileSync } from "node:fs";

const uniq = (xs) => [...new Set(xs)];

let failed = false;
for (const file of process.argv.slice(2)) {
  const svg = readFileSync(file, "utf8");
  const all = (re) => [...svg.matchAll(re)].map((m) => m[1]);
  const strokes = uniq(all(/\sstroke="([^"]+)"/g).filter((c) => c !== "none"));
  const widths = uniq(all(/stroke-width="([^"]+)"/g));
  const fills = uniq(all(/\sfill="([^"]+)"/g).filter((c) => c !== "none"));
  const radii = uniq(all(/<circle[^>]*\sr="([^"]+)"/g));
  const problems = [];
  if (widths.length > 1)
    problems.push(`${widths.length} stroke widths (${widths.join(", ")}); use one`);
  const inks = uniq([...strokes, ...fills]);
  // The paper rect, when present, is the one extra fill.
  const paper = svg.match(/^<rect width="[^"]+" height="[^"]+" fill="([^"]+)"\/>/m)?.[1];
  const colors = inks.filter((c) => c !== paper);
  if (colors.length > 2)
    problems.push(`${colors.length} colors (${colors.join(", ")}); ink plus one accent`);
  if (radii.length > 2)
    problems.push(`${radii.length} dot sizes (${radii.join(", ")}); node and pivot only`);
  if (/<(linearGradient|radialGradient|filter)\b|opacity=|blur\(/.test(svg)) {
    problems.push("gradients, filters or opacity: depth comes from line, dash and dot only");
  }
  const count = (re) => (svg.match(re) ?? []).length;
  console.log(
    `${file}: ${count(/<path /g)} paths, ${count(/<circle /g)} dots, colors ${colors.join(" ")}, width ${widths.join(" ")}`,
  );
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
