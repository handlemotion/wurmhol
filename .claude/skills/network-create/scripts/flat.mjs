// The flat engine: construction drawings. Circles, lines and frames laid out by proportion,
// and nodes placed only where those shapes actually meet, computed exactly. One stroke width,
// one ink, one accent; squares for nodes, dashes for construction, mono tags for labels.
//
// Coordinates are px, origin top left, y down. Shapes may run past the frame: the SVG viewport
// crops them, which is how a plate implies a larger drawing.

import { random } from "./engine.mjs";

export const PHI = (1 + Math.sqrt(5)) / 2;
export const SQRT2 = Math.SQRT2;

/** A modular scale: `base · ratio^k` for k in [from, to]. */
export const modular = (base, ratio, from, to) => {
  const out = [];
  for (let k = from; k <= to; k++) out.push(base * ratio ** k);
  return out;
};

// ── exact intersections ─────────────────────────────────────────────────────────────────────

export const meet = {
  /** Where the infinite line through a and b crosses the circle (0, 1 or 2 points). */
  lineCircle(a, b, c, r) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const fx = a[0] - c[0];
    const fy = a[1] - c[1];
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0 || !A) return [];
    const s = Math.sqrt(disc);
    return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((t) => [a[0] + dx * t, a[1] + dy * t]);
  },
  /** Where two circles cross. */
  circles(c1, r1, c2, r2) {
    const dx = c2[0] - c1[0];
    const dy = c2[1] - c1[1];
    const d = Math.hypot(dx, dy);
    if (d > r1 + r2 || d < Math.abs(r1 - r2) || !d) return [];
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
    const mx = c1[0] + (dx * a) / d;
    const my = c1[1] + (dy * a) / d;
    return [
      [mx + (h * dy) / d, my - (h * dx) / d],
      [mx - (h * dy) / d, my + (h * dx) / d],
    ];
  },
  /** Where two infinite lines cross, or null when parallel. */
  lines(a, b, c, d) {
    const den = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / den;
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  },
  /** The two points where tangents from `p` touch the circle. */
  /**
   * Inversion in the circle (o, k): maps a circle that does not pass through o to another
   * circle. Tangency is preserved, which is how a Steiner chain is made eccentric.
   */
  invertCircle(c, r, o, k) {
    const dx = c[0] - o[0];
    const dy = c[1] - o[1];
    const d = Math.hypot(dx, dy);
    const s = (k * k) / (d * d - r * r);
    return { c: [o[0] + dx * s, o[1] + dy * s], r: Math.abs(r * s) };
  },
  invertPoint(p, o, k) {
    const dx = p[0] - o[0];
    const dy = p[1] - o[1];
    const s = (k * k) / (dx * dx + dy * dy);
    return [o[0] + dx * s, o[1] + dy * s];
  },
  tangents(p, c, r) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const d = Math.hypot(dx, dy);
    if (d <= r) return [];
    const base = Math.atan2(dy, dx);
    const off = Math.acos(r / d);
    return [base + off, base - off].map((t) => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  },
};

// ── plate ────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_STYLE = {
  ink: "#171717",
  accent: "#0d3eef",
  paper: null,
  stroke: 1,
  dash: [10, 8],
  font: "ui-monospace, 'SF Mono', Menlo, monospace",
  // The face for copy set with `text()`: the product's own.
  display: "'Inter Variable', Inter, ui-sans-serif, system-ui, sans-serif",
  text: 15,
  // Icons: strokes scale with the drawing (no non-scaling-stroke), so a 32px mark keeps its
  // proportions at 16px.
  scaleStroke: false,
  // Standalone files that can't inherit color (a favicon): { light, dark } inks, switched by the
  // viewer's color scheme inside the SVG itself.
  scheme: null,
  // A background tile: `paper` fills it, `paperRadius` rounds its corners, and `inset` shrinks
  // the drawing toward the centre so it sits inside the tile with a margin (a favicon on a tile).
  paperRadius: 0,
  inset: 0,
};

export function plate(options = {}) {
  return new Plate(options);
}

class Plate {
  /**
   * `origin` puts (0, 0) at that point of the frame instead of its top left: a plate anchored to
   * something on a page (a form field) is drawn in that thing's coordinates.
   */
  constructor({ width = 1200, height = 1200, style = {}, origin = [0, 0] } = {}) {
    this.origin = origin;
    this.holes = [];
    this.width = width;
    this.height = height;
    this.style = { ...DEFAULT_STYLE, ...style };
    this.items = [];
  }

  line(a, b, o = {}) {
    this.items.push({ kind: "line", a, b, ...o });
    return this;
  }

  /** A line that runs edge to edge through `a` and `b`. */
  ray(a, b, o = {}) {
    const W = this.width;
    const H = this.height;
    const big = 4 * (W + H);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    return this.line(
      [a[0] - (dx / L) * big, a[1] - (dy / L) * big],
      [a[0] + (dx / L) * big, a[1] + (dy / L) * big],
      o,
    );
  }

  circle(c, r, o = {}) {
    this.items.push({ kind: "circle", c, r, ...o });
    return this;
  }

  /** An arc from angle a0 to a1 (radians, clockwise on screen), with optional arrowheads. */
  arc(c, r, a0, a1, o = {}) {
    this.items.push({ kind: "arc", c, r, a0, a1, arrows: [], ...o });
    return this;
  }

  frame(x, y, w, h, o = {}) {
    this.items.push({ kind: "frame", x, y, w, h, ...o });
    return this;
  }

  /** A filled node: `shape` "square" | "dot", `size` its side or diameter in px. */
  node(p, o = {}) {
    this.items.push({ kind: "node", p, size: 16, shape: "square", ...o });
    return this;
  }

  /** A mono label; `tag: true` boxes it with a filled swatch on its left, like a readout. */
  label(p, text, o = {}) {
    this.items.push({ kind: "label", p, text, anchor: "start", tag: false, ...o });
    return this;
  }

  /** Lines from `from` to each point: projection rays. */
  fan(from, points, o = {}) {
    for (const p of points) this.line(from, p, o);
    return this;
  }

  /**
   * A hole: an opening in the construction, drawn as its rim, that every other line stops at.
   * `{ c, r }` is a circle, `{ x, y, w, h }` a frame. Text and page content sit in holes (see
   * `text`): the drawing is built outward from the rim, so nothing crosses what it holds.
   */
  hole(shape, o = {}) {
    this.holes.push({ ...shape, ...o });
    return this;
  }

  /**
   * Copy set in the display face (a wordmark, a headline): `lines` are `{ text, size, weight }`,
   * each with an optional `gap` above it that overrides the block's,
   * stacked and centred on `c` (`anchor` "middle", or "start" with `c` the block's left middle).
   * Rendering throws unless the block fits inside a hole with `pad` to spare: text never floats
   * on a bare patch of paper.
   */
  text(c, lines, o = {}) {
    this.items.push({ kind: "text", c, lines, anchor: "middle", gap: 0.3, pad: 0, ...o });
    return this;
  }

  /** A polyline; `closed` joins its ends. */
  poly(points, o = {}) {
    this.items.push({ kind: "poly", points, closed: false, ...o });
    return this;
  }

  /** An ellipse with semi-axes a, b, rotated by `angle` radians. Foci: `focusOf`. */
  ellipse(c, a, b, angle = 0, o = {}) {
    const pts = [];
    for (let i = 0; i < 256; i++) {
      const t = (i / 256) * Math.PI * 2;
      const x = a * Math.cos(t);
      const y = b * Math.sin(t);
      pts.push([
        c[0] + x * Math.cos(angle) - y * Math.sin(angle),
        c[1] + x * Math.sin(angle) + y * Math.cos(angle),
      ]);
    }
    return this.poly(pts, { closed: true, ...o });
  }

  /** Radial ticks around a circle: `count` strokes of `length`, every `every`th one longer. */
  ticks(c, r, { count = 120, length = 8, every = 0, from = 0, to = Math.PI * 2, ...o } = {}) {
    for (let i = 0; i < count; i++) {
      const t = from + ((to - from) * i) / count;
      const l = every && i % every === 0 ? length * 2 : length;
      const u = [Math.cos(t), Math.sin(t)];
      this.line(
        [c[0] + u[0] * r, c[1] + u[1] * r],
        [c[0] + u[0] * (r + l), c[1] + u[1] * (r + l)],
        o,
      );
    }
    return this;
  }

  /** A construction cross, the drafting mark for a reference point. */
  cross(p, size = 5, o = {}) {
    return this.line([p[0] - size, p[1]], [p[0] + size, p[1]], o).line(
      [p[0], p[1] - size],
      [p[0], p[1] + size],
      o,
    );
  }

  /**
   * A dimension line, as on a drawing: offset `off` px from the measured edge a→b, extension
   * lines back to it, end ticks at 45°, and the value centred above.
   */
  dimension(a, b, text, { off = 24, ...o } = {}) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const n = [-dy / L, dx / L];
    const A = [a[0] + n[0] * off, a[1] + n[1] * off];
    const B = [b[0] + n[0] * off, b[1] + n[1] * off];
    const ext = Math.sign(off) * 6;
    this.line(a, [A[0] + n[0] * ext, A[1] + n[1] * ext], o).line(
      b,
      [B[0] + n[0] * ext, B[1] + n[1] * ext],
      o,
    );
    this.line(A, B, o);
    const k = 5;
    for (const q of [A, B]) {
      this.line(
        [q[0] - (dx / L + n[0]) * k, q[1] - (dy / L + n[1]) * k],
        [q[0] + (dx / L + n[0]) * k, q[1] + (dy / L + n[1]) * k],
        o,
      );
    }
    const mid = [(A[0] + B[0]) / 2 + n[0] * 14, (A[1] + B[1]) / 2 + n[1] * 14];
    return this.label(mid, text, { anchor: "middle", ...o });
  }

  /**
   * Mirrors the plate across its diagonal: x↔y, width↔height. Build a construction once in
   * landscape and transpose it for a portrait frame (a phone backdrop).
   */
  transpose() {
    const t = (q) => [q[1], q[0]];
    [this.width, this.height] = [this.height, this.width];
    for (const it of this.items) {
      if (it.a) [it.a, it.b] = [t(it.a), t(it.b)];
      if (it.c) it.c = t(it.c);
      if (it.p) it.p = t(it.p);
      if (it.points) it.points = it.points.map(t);
      if (it.kind === "frame") [it.x, it.y, it.w, it.h] = [it.y, it.x, it.h, it.w];
      if (it.kind === "arc") [it.a0, it.a1] = [Math.PI / 2 - it.a0, Math.PI / 2 - it.a1];
    }
    return this;
  }

  /** Every point of ink the plate will draw, for balance and coverage scores. */
  samples() {
    const pts = [];
    const push = (x, y, w = 1) => {
      const [ox, oy] = this.origin;
      if (x >= -ox && y >= -oy && x <= this.width - ox && y <= this.height - oy) {
        pts.push([x + ox, y + oy, w]);
      }
    };
    for (const it of this.items) {
      if (it.kind === "line") {
        const n = Math.ceil(Math.hypot(it.b[0] - it.a[0], it.b[1] - it.a[1]) / 6);
        for (let i = 0; i <= n; i++)
          push(it.a[0] + ((it.b[0] - it.a[0]) * i) / n, it.a[1] + ((it.b[1] - it.a[1]) * i) / n, 6);
      } else if (it.kind === "circle" || it.kind === "arc") {
        const a0 = it.kind === "arc" ? it.a0 : 0;
        const a1 = it.kind === "arc" ? it.a1 : Math.PI * 2;
        const n = Math.ceil((Math.abs(a1 - a0) * it.r) / 6);
        for (let i = 0; i <= n; i++) {
          const t = a0 + ((a1 - a0) * i) / n;
          push(it.c[0] + it.r * Math.cos(t), it.c[1] + it.r * Math.sin(t), 6);
        }
      } else if (it.kind === "poly") {
        const pts = it.closed ? [...it.points, it.points[0]] : it.points;
        for (let k = 1; k < pts.length; k++) {
          const [a, b] = [pts[k - 1], pts[k]];
          const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6);
          for (let i = 0; i <= n; i++)
            push(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, 6);
        }
      } else if (it.kind === "frame") {
        const { x, y, w, h } = it;
        for (const [a, b] of [
          [
            [x, y],
            [x + w, y],
          ],
          [
            [x + w, y],
            [x + w, y + h],
          ],
          [
            [x + w, y + h],
            [x, y + h],
          ],
          [
            [x, y + h],
            [x, y],
          ],
        ]) {
          const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6);
          for (let i = 0; i <= n; i++)
            push(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, 6);
        }
      } else if (it.kind === "node") {
        push(it.p[0], it.p[1], it.size * it.size * 0.6);
      } else if (it.kind === "label") {
        push(it.p[0], it.p[1], it.text.length * this.style.text * 2);
      } else if (it.kind === "text") {
        // Weighted per line as check.mjs weighs text, so the search balances what it checks.
        const b = textBox(it);
        let y = b.y;
        it.lines.forEach((l, i) => {
          y += l.size * (i ? 1 + (l.gap ?? it.gap) : 1);
          push(it.c[0], y, l.text.length * 20);
        });
      }
    }
    for (const h of this.holes) {
      if (h.r === undefined) continue;
      const n = Math.ceil((Math.PI * 2 * h.r) / 6);
      for (let i = 0; i <= n; i++) {
        const t = (Math.PI * 2 * i) / n;
        push(h.c[0] + h.r * Math.cos(t), h.c[1] + h.r * Math.sin(t), 6);
      }
    }
    return pts;
  }

  /** Balance (0 = ink centred) and coverage (share of the frame's width and height inked). */
  score() {
    const pts = this.samples();
    let m = 0;
    let x = 0;
    let y = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [px, py, w] of pts) {
      m += w;
      x += px * w;
      y += py * w;
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
    const off = m ? Math.hypot(x / m / this.width - 0.5, y / m / this.height - 0.5) : 1;
    return { off, cover: Math.min((x1 - x0) / this.width, (y1 - y0) / this.height) };
  }

  render() {
    return renderPlate(this);
  }
}

/**
 * Generative search: builds `tries` candidates from seeds and keeps the best balanced one that
 * fills the frame. `build(rng, seed)` returns a plate.
 */
export function best(build, { seed = 1, tries = 48 } = {}) {
  let top = null;
  for (let i = 0; i < tries; i++) {
    const s = seed * 1000 + i;
    const p = build(random(s), s);
    const { off, cover } = p.score();
    const cost = off + Math.max(0, 0.9 - cover);
    if (!top || cost < top.cost) top = { p, cost };
  }
  return top.p;
}

// ── SVG ──────────────────────────────────────────────────────────────────────────────────────

const f = (n) => (Math.round(n * 100) / 100).toString();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function arrowhead(p, angle, size) {
  const back = [p[0] - Math.cos(angle) * size, p[1] - Math.sin(angle) * size];
  const half = size * 0.42;
  const nx = -Math.sin(angle) * half;
  const ny = Math.cos(angle) * half;
  return `M${f(p[0])} ${f(p[1])}L${f(back[0] + nx)} ${f(back[1] + ny)}L${f(back[0] - nx)} ${f(back[1] - ny)}Z`;
}

// An estimate of a line's advance in the display face, generous so the fit check errs safe.
const advance = (line) => line.text.length * line.size * 0.58;

/** A text block's box: its lines stacked with `gap` (a share of each size) between them. */
function textBox(it) {
  const height = it.lines.reduce((h, l, i) => h + l.size * (i ? 1 + (l.gap ?? it.gap) : 1), 0);
  const width = Math.max(...it.lines.map(advance));
  const x = it.anchor === "middle" ? it.c[0] - width / 2 : it.c[0];
  return { x, y: it.c[1] - height / 2, w: width, h: height };
}

/** Whether box `b`, grown by `pad`, lies inside hole `h`. */
function holds(h, b, pad) {
  const [x0, y0, x1, y1] = [b.x - pad, b.y - pad, b.x + b.w + pad, b.y + b.h + pad];
  if (h.r === undefined) return x0 >= h.x && y0 >= h.y && x1 <= h.x + h.w && y1 <= h.y + h.h;
  return [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].every(([x, y]) => Math.hypot(x - h.c[0], y - h.c[1]) <= h.r);
}

function renderText(pl, it) {
  const b = textBox(it);
  if (!pl.holes.some((h) => holds(h, b, it.pad))) {
    throw new Error(
      `text "${it.lines[0].text}" sits outside every hole: set copy inside a hole() of the construction, never on bare paper`,
    );
  }
  const st = pl.style;
  const out = [];
  let y = b.y;
  it.lines.forEach((l, i) => {
    y += l.size * (i ? 1 + (l.gap ?? it.gap) : 1);
    // Baseline about 0.2 of the size above the line box's bottom; x and y last, for check.mjs.
    out.push(
      `<text fill="${l.accent ? st.accent : st.ink}" font-family="${st.display}" font-size="${l.size}" font-weight="${l.weight ?? 400}" letter-spacing="${f(-l.size * 0.02)}" text-anchor="${it.anchor}" x="${f(it.c[0])}" y="${f(y - l.size * 0.2)}">${esc(l.text)}</text>`,
    );
  });
  return out;
}

function renderPlate(pl) {
  const { width: W, height: H, style: st } = pl;
  const ink = st.scheme ? "currentColor" : st.ink;
  const color = (it) => (it.accent ? st.accent : ink);
  const dash = (it) => (it.dashed ? ` stroke-dasharray="${st.dash.join(" ")}"` : "");
  const zoom = st.inset ? (Math.min(W, H) - 2 * st.inset) / Math.min(W, H) : 1;
  const strokeAttrs = (it) =>
    `fill="none" stroke="${color(it)}" stroke-width="${f(st.stroke / zoom)}"${st.scaleStroke ? "" : ' vector-effect="non-scaling-stroke"'}${dash(it)}`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pl.origin[0]} ${-pl.origin[1]} ${W} ${H}" width="${W}" height="${H}">`,
  ];
  if (st.scheme) {
    out.push(
      `<style>svg{color:${st.scheme.light}}@media (prefers-color-scheme:dark){svg{color:${st.scheme.dark}}}</style>`,
    );
  }
  if (st.paper) {
    out.push(
      `<rect x="${-pl.origin[0]}" y="${-pl.origin[1]}" width="${W}" height="${H}"${st.paperRadius ? ` rx="${st.paperRadius}"` : ""} fill="${st.paper}"/>`,
    );
  }
  if (st.inset) {
    // Keep the drawing's stroke at `stroke` after the scale-down.
    out.push(
      `<g transform="translate(${f(W / 2)} ${f(H / 2)}) scale(${f(zoom)}) translate(${f(-W / 2)} ${f(-H / 2)})">`,
    );
  }
  // Holes: a luminance mask, white everywhere but inside the holes, so lines stop at each rim;
  // the rims themselves are drawn after it, unmasked.
  const masked = pl.holes.length > 0;
  if (masked) {
    const cut = pl.holes
      .map((h) =>
        h.r === undefined
          ? `<rect x="${f(h.x)}" y="${f(h.y)}" width="${f(h.w)}" height="${f(h.h)}" fill="black"/>`
          : `<circle cx="${f(h.c[0])}" cy="${f(h.c[1])}" r="${f(h.r)}" fill="black"/>`,
      )
      .join("");
    out.push(
      `<mask id="hole" maskUnits="userSpaceOnUse" x="${-pl.origin[0]}" y="${-pl.origin[1]}" width="${W}" height="${H}"><rect x="${-pl.origin[0]}" y="${-pl.origin[1]}" width="${W}" height="${H}" fill="white"/>${cut}</mask>`,
      `<g mask="url(#hole)">`,
    );
  }

  // Strokes first, then nodes and labels on top, so a node always sits on its lines.
  for (const it of pl.items) {
    if (it.kind === "line") {
      out.push(
        `<path ${strokeAttrs(it)} d="M${f(it.a[0])} ${f(it.a[1])}L${f(it.b[0])} ${f(it.b[1])}"/>`,
      );
    } else if (it.kind === "circle") {
      out.push(`<circle ${strokeAttrs(it)} cx="${f(it.c[0])}" cy="${f(it.c[1])}" r="${f(it.r)}"/>`);
    } else if (it.kind === "arc") {
      const p0 = [it.c[0] + it.r * Math.cos(it.a0), it.c[1] + it.r * Math.sin(it.a0)];
      const p1 = [it.c[0] + it.r * Math.cos(it.a1), it.c[1] + it.r * Math.sin(it.a1)];
      const large = Math.abs(it.a1 - it.a0) > Math.PI ? 1 : 0;
      const sweep = it.a1 > it.a0 ? 1 : 0;
      out.push(
        `<path ${strokeAttrs(it)} d="M${f(p0[0])} ${f(p0[1])}A${f(it.r)} ${f(it.r)} 0 ${large} ${sweep} ${f(p1[0])} ${f(p1[1])}"/>`,
      );
    } else if (it.kind === "poly") {
      const d =
        "M" + it.points.map((q) => `${f(q[0])} ${f(q[1])}`).join("L") + (it.closed ? "Z" : "");
      out.push(`<path ${strokeAttrs(it)} d="${d}"/>`);
    } else if (it.kind === "frame") {
      out.push(
        `<rect ${strokeAttrs(it)} x="${f(it.x)}" y="${f(it.y)}" width="${f(it.w)}" height="${f(it.h)}"/>`,
      );
    }
  }
  for (const it of pl.items) {
    if (it.kind === "arc" && it.arrows.length) {
      const dir = it.a1 > it.a0 ? 1 : -1;
      for (const t of it.arrows) {
        const a = it.a0 + (it.a1 - it.a0) * t;
        const p = [it.c[0] + it.r * Math.cos(a), it.c[1] + it.r * Math.sin(a)];
        out.push(`<path fill="${color(it)}" d="${arrowhead(p, a + (dir * Math.PI) / 2, 9)}"/>`);
      }
    } else if (it.kind === "line" && it.arrow) {
      const ang = Math.atan2(it.b[1] - it.a[1], it.b[0] - it.a[0]);
      const p = [
        it.a[0] + (it.b[0] - it.a[0]) * it.arrow,
        it.a[1] + (it.b[1] - it.a[1]) * it.arrow,
      ];
      out.push(`<path fill="${color(it)}" d="${arrowhead(p, ang, 9)}"/>`);
    } else if (it.kind === "node") {
      const s = it.size;
      if (it.shape === "dot") {
        out.push(
          `<circle fill="${color(it)}" cx="${f(it.p[0])}" cy="${f(it.p[1])}" r="${f(s / 2)}"/>`,
        );
      } else {
        out.push(
          `<rect fill="${color(it)}" x="${f(it.p[0] - s / 2)}" y="${f(it.p[1] - s / 2)}" width="${f(s)}" height="${f(s)}"/>`,
        );
      }
    } else if (it.kind === "label") {
      const fs = st.text;
      const tw = it.text.length * fs * 0.6;
      if (it.tag) {
        // A readout: swatch, then the value, boxed. The box's left edge sits on the point.
        const h = fs * 1.9;
        const sw = h * 0.62;
        const pad = fs * 0.6;
        const x = it.p[0];
        const y = it.p[1] - h / 2;
        out.push(
          `<rect fill="${st.paper ?? "none"}" stroke="${color(it)}" stroke-width="${st.stroke}" x="${f(x)}" y="${f(y)}" width="${f(sw + pad * 2 + tw)}" height="${f(h)}"/>`,
          `<rect fill="${color(it)}" x="${f(x)}" y="${f(y)}" width="${f(sw)}" height="${f(h)}"/>`,
          `<text fill="${st.ink}" font-family="${st.font}" font-size="${fs}" x="${f(x + sw + pad)}" y="${f(it.p[1] + fs * 0.35)}">${esc(it.text)}</text>`,
        );
      } else {
        out.push(
          `<text fill="${color(it)}" font-family="${st.font}" font-size="${fs}" text-anchor="${it.anchor}" x="${f(it.p[0])}" y="${f(it.p[1] + fs * 0.35)}">${esc(it.text)}</text>`,
        );
      }
    }
  }
  if (masked) {
    out.push("</g>");
    for (const h of pl.holes) {
      out.push(
        h.r === undefined
          ? `<rect ${strokeAttrs(h)} x="${f(h.x)}" y="${f(h.y)}" width="${f(h.w)}" height="${f(h.h)}"/>`
          : `<circle ${strokeAttrs(h)} cx="${f(h.c[0])}" cy="${f(h.c[1])}" r="${f(h.r)}"/>`,
      );
    }
  }
  for (const it of pl.items) if (it.kind === "text") out.push(...renderText(pl, it));
  if (st.inset) out.push("</g>");
  out.push("</svg>");
  return out.join("\n");
}
