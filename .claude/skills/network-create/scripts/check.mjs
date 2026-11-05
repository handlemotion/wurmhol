#!/usr/bin/env node
/* oxlint-disable no-console -- a CLI: printing is its output */
// Holds an SVG to the network style. Fails a plate that is:
// - thick or mixed: more than one stroke width, or a width outside 0.75–1.5px;
// - off-palette: more than ink plus one accent, gradients, filters or opacity;
// - incomplete: ink covering under 85% of the frame's width or height;
// - unbalanced: the ink's centre of mass more than 7% of the frame from its centre.
// Mass is stroke length (paths, stroked circles and rects) plus the area of dots and text.
//
//   node check.mjs <file.svg ...> [--frame x,y,w,h]
//
// `--frame` judges the plate through a window of its viewBox instead of the whole of it: for an
// anchored backdrop, the part one viewport shows (the login at 1440x900, form centre at
// 536,450: `--frame -536,-450,1440,900`).
import { readFileSync } from "node:fs";

const uniq = (xs) => [...new Set(xs)];

const argv = process.argv.slice(2);
const fi = argv.indexOf("--frame");
const frame = fi === -1 ? null : argv.splice(fi, 2)[1].split(",").map(Number);

let failed = false;
for (const file of argv) {
  // A hole mask's black and white are luminance, not ink.
  const svg = readFileSync(file, "utf8").replace(/<mask[\s\S]*?<\/mask>/g, "");
  const all = (re) => [...svg.matchAll(re)].map((m) => m[1]);
  const [X0, Y0, W, H] =
    frame ??
    svg
      .match(/viewBox="([^"]+)"/)[1]
      .split(/\s+/)
      .map(Number);
  const strokes = uniq(all(/\sstroke="([^"]+)"/g).filter((c) => c !== "none"));
  const widths = uniq(all(/stroke-width="([^"]+)"/g));
  const fills = uniq(all(/\sfill="([^"]+)"/g).filter((c) => c !== "none"));
  const radii = uniq(all(/<circle (?![^>]*fill="none")[^>]*\sr="([^"]+)"/g));
  const paper = svg.match(
    /^<rect (?:x="[^"]+" y="[^"]+" )?width="[^"]+" height="[^"]+" fill="([^"]+)"\/>/m,
  )?.[1];
  const colors = uniq([...strokes, ...fills]).filter((c) => c !== paper);

  // Ink geometry.
  let mass = 0;
  let mx = 0;
  let my = 0;
  let marks = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const see = (x, y) => {
    if (x < X0 || y < Y0 || x > X0 + W || y > Y0 + H) return;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  };
  // A segment counts only for the part inside the frame (Liang–Barsky clip), so a ray drawn
  // edge to edge weighs what you see of it.
  const segment = (ax, ay, bx, by) => {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    for (const [pp, q] of [
      [-dx, ax - X0],
      [dx, X0 + W - ax],
      [-dy, ay - Y0],
      [dy, Y0 + H - ay],
    ]) {
      if (pp === 0) {
        if (q < 0) return;
      } else {
        const t = q / pp;
        if (pp < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (t0 > t1) return;
    const [cx0, cy0, cx1, cy1] = [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
    see(cx0, cy0);
    see(cx1, cy1);
    const l = Math.hypot(cx1 - cx0, cy1 - cy0);
    mass += l;
    mx += ((cx0 + cx1) / 2) * l;
    my += ((cy0 + cy1) / 2) * l;
  };
  for (const d of all(/<path[^>]*\sd="([^"]+)"/g)) {
    if (/A/.test(d)) continue; // arcs: counted as their circle would be, skipped here
    for (const sub of d.split("M").filter(Boolean)) {
      const pts = sub
        .replace("Z", "")
        .split("L")
        .map((p) => p.trim().split(/\s+/).map(Number));
      marks += pts.length;
      for (let i = 1; i < pts.length; i++) segment(...pts[i - 1], ...pts[i]);
      if (pts.length === 1) see(...pts[0]);
    }
  }
  const edge = (pts) => {
    for (let i = 1; i < pts.length; i++) segment(...pts[i - 1], ...pts[i]);
  };
  const num = (tag, k) => Number(tag.match(new RegExp(`\\s${k}="([^"]+)"`))?.[1] ?? 0);
  for (const [tag] of svg.matchAll(/<circle [^>]*fill="none"[^>]*>/g)) {
    const [cx, cy, r] = [num(tag, "cx"), num(tag, "cy"), num(tag, "r")];
    marks++;
    const pts = [];
    for (let i = 0; i <= 128; i++)
      pts.push([
        cx + r * Math.cos((i / 128) * Math.PI * 2),
        cy + r * Math.sin((i / 128) * Math.PI * 2),
      ]);
    edge(pts);
  }
  for (const [tag] of svg.matchAll(/<rect [^>]*fill="none"[^>]*>/g)) {
    const [x, y, w, h] = [num(tag, "x"), num(tag, "y"), num(tag, "width"), num(tag, "height")];
    marks++;
    edge([
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ]);
  }
  for (const m of svg.matchAll(/<text [^>]*x="([^"]+)" y="([^"]+)">([^<]*)</g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), m[3].length * 20];
    marks++;
    see(x, y);
    // Like a dot: a label outside the frame weighs nothing there.
    if (x < X0 || y < Y0 || x > X0 + W || y > Y0 + H) continue;
    mass += w;
    mx += x * w;
    my += y * w;
  }
  for (const m of svg.matchAll(
    /<circle (?![^>]*fill="none")[^>]*cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g,
  )) {
    const [x, y, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
    marks++;
    see(x, y);
    if (x < X0 || y < Y0 || x > X0 + W || y > Y0 + H) continue;
    const w = Math.PI * r * 2;
    mass += w;
    mx += x * w;
    my += y * w;
  }
  const off = mass ? Math.hypot((mx / mass - X0) / W - 0.5, (my / mass - Y0) / H - 0.5) : 1;
  const cover = [(x1 - x0) / W, (y1 - y0) / H];

  const problems = [];
  if (widths.length > 1)
    problems.push(`${widths.length} stroke widths (${widths.join(", ")}); use one`);
  for (const w of widths)
    if (+w < 0.75 || +w > 1.5) problems.push(`stroke ${w}px; hairlines only (0.75–1.5)`);
  if (colors.length > 2)
    problems.push(`${colors.length} colors (${colors.join(", ")}); ink plus one accent`);
  if (radii.length > 2)
    problems.push(`${radii.length} dot sizes (${radii.join(", ")}); node and pivot only`);
  if (/<(linearGradient|radialGradient|filter)\b|opacity=|blur\(/.test(svg)) {
    problems.push("gradients, filters or opacity: depth comes from line, dash and dot only");
  }
  if (cover[0] < 0.85 || cover[1] < 0.85) {
    problems.push(
      `ink covers ${(cover[0] * 100).toFixed(0)}% × ${(cover[1] * 100).toFixed(0)}% of the frame; a plate fills it (85%+), with outer layers running past the edge`,
    );
  }
  if (off > 0.07)
    problems.push(`ink centre ${(off * 100).toFixed(1)}% off the frame centre; rebalance (≤7%)`);

  console.log(
    `${file}: ${marks} marks, cover ${(cover[0] * 100).toFixed(0)}×${(cover[1] * 100).toFixed(0)}%, centre off ${(off * 100).toFixed(1)}%, colors ${colors.join(" ")}, width ${widths.join(" ")}`,
  );
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
