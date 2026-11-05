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
  text: 15,
};

export function plate(options = {}) {
  return new Plate(options);
}

class Plate {
  constructor({ width = 1200, height = 1200, style = {} } = {}) {
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
      if (x >= 0 && y >= 0 && x <= this.width && y <= this.height) pts.push([x, y, w]);
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

function renderPlate(pl) {
  const { width: W, height: H, style: st } = pl;
  const color = (it) => (it.accent ? st.accent : st.ink);
  const dash = (it) => (it.dashed ? ` stroke-dasharray="${st.dash.join(" ")}"` : "");
  const strokeAttrs = (it) =>
    `fill="none" stroke="${color(it)}" stroke-width="${st.stroke}" vector-effect="non-scaling-stroke"${dash(it)}`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
  ];
  if (st.paper) out.push(`<rect width="${W}" height="${H}" fill="${st.paper}"/>`);

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
  out.push("</svg>");
  return out.join("\n");
}
