// The network-graphics engine: 3D wireframe geometry in, one clean SVG out.
//
// A scene holds curves (polylines in world space), dots and occluding surfaces. `render()`
// projects everything through one camera, rasterizes the surfaces into a depth buffer, and
// splits every curve into visible and hidden runs by testing its samples against that buffer.
// Visible runs are solid, hidden runs dashed (or dropped), and dots behind a surface vanish.
// Every stroke shares one color and one width; hierarchy comes only from solid, dashed and
// dotted (beads without a line), plus a single accent for the pivot.
//
// No dependencies, deterministic for a given seed, so a graphic is reproducible from its scene
// file alone.

// ── vectors ──────────────────────────────────────────────────────────────────────────────────

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => mul(a, 1 / (len(a) || 1));
export const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const rad = (deg) => (deg * Math.PI) / 180;

/** Rotates `p` about the unit-or-not `axis` through the origin by `deg` (Rodrigues). */
export function rotate(p, axis, deg) {
  const k = norm(axis);
  const t = rad(deg);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return add(add(mul(p, c), mul(cross(k, p), s)), mul(k, dot(k, p) * (1 - c)));
}

/** Two unit vectors spanning the plane whose normal is `n`. */
export function basis(n) {
  const w = norm(n);
  const seed = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(seed, w));
  return [u, cross(w, u)];
}

/** Seeded PRNG (mulberry32): `rng()` gives [0, 1). Same seed, same graphic. */
export function random(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── themes ───────────────────────────────────────────────────────────────────────────────────

/**
 * Colors from `apps/web/src/styles.css`. `strong` inks with the foreground (diagrams, marks);
 * `quiet` with the hairline gray (backdrops behind UI). Keep these in step with the tokens.
 */
export const THEMES = {
  light: { paper: "#ffffff", strong: "#171717", quiet: "#d9d9d9", accent: "#0d3eef" },
  dark: { paper: "#000000", strong: "#ededed", quiet: "#2e2e2e", accent: "#3d66ff" },
};

// ── scene ────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_STYLE = {
  ink: THEMES.light.strong,
  accent: THEMES.light.accent,
  paper: null, // a background rect, or none (transparent)
  stroke: 1, // the one stroke width, in output px
  dot: 2.25, // bead and node radius
  accentDot: 5, // the pivot's radius
  dash: [5, 4], // hidden runs
  arrow: 7, // arrowhead length
};

export function scene(options = {}) {
  return new Scene(options);
}

class Scene {
  constructor({ width = 1200, height = 1200, camera = {}, style = {} } = {}) {
    this.width = width;
    this.height = height;
    this.camera = { yaw: 0, pitch: 0, roll: 0, perspective: 0, fit: 0.86, zoom: 1, ...camera };
    this.style = { ...DEFAULT_STYLE, ...style };
    this.curves = [];
    this.dots = [];
    this.tris = [];
    this.panels = [];
  }

  /**
   * A polyline. `line: false` draws only its beads (a dotted guide). `beads` places that many
   * dots evenly by arc length (`beadEvery` by world distance instead); beads crowd with
   * distance under perspective, which is most of the depth cue. `hidden`: "dash" | "none" |
   * "solid". `dashed: true` dashes the visible part too (a construction line). `arrows`: positions in [0, 1] along the curve that get an arrowhead.
   */
  curve(points, opts = {}) {
    this.curves.push({
      points,
      closed: false,
      line: true,
      beads: 0,
      beadEvery: 0,
      beadPhase: 0.5,
      hidden: "dash",
      dashed: false,
      accent: false,
      arrows: [],
      ...opts,
    });
    return this;
  }

  dot(p, opts = {}) {
    this.dots.push({ p, accent: false, hidden: "none", ...opts });
    return this;
  }

  /** Triangles that hide what is behind them. They are never drawn. */
  surface(tris) {
    for (const t of tris) this.tris.push(t);
    return this;
  }

  /** Adds a primitive: `{ curves: [{points, ...opts}], dots: [{p, ...}], mesh: [[a,b,c]] }`. */
  add(prim, overrides = {}) {
    for (const c of prim.curves ?? []) this.curve(c.points, { ...c, ...overrides });
    for (const d of prim.dots ?? []) this.dot(d.p, { ...d, ...pick(overrides, ["accent"]) });
    if (prim.mesh && overrides.occlude !== false) this.surface(prim.mesh);
    return this;
  }

  /**
   * A screen-space card (px, from the top left): filled with paper, outlined in ink, and
   * covering whatever lies under it, like the panel in a technical plate.
   */
  panel(x, y, w, h) {
    this.panels.push({ x, y, w, h });
    return this;
  }

  render() {
    return renderScene(this);
  }
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}

// ── projection ───────────────────────────────────────────────────────────────────────────────

function makeView(cam) {
  const toCam = (p) => {
    let q = rotate(p, [0, 1, 0], cam.yaw);
    q = rotate(q, [1, 0, 0], cam.pitch);
    return rotate(q, [0, 0, 1], cam.roll);
  };
  const D = cam.perspective;
  const persp = (q) => {
    const k = D ? D / (D - q[2]) : 1;
    return [q[0] * k, -q[1] * k, q[2]];
  };
  return (p) => persp(toCam(p));
}

function renderScene(s) {
  const { width: W, height: H, style } = s;
  const view = makeView(s.camera);

  // Fit: scale the projected bounds into the frame.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const grow = (p) => {
    const q = view(p);
    if (q[0] < minX) minX = q[0];
    if (q[0] > maxX) maxX = q[0];
    if (q[1] < minY) minY = q[1];
    if (q[1] > maxY) maxY = q[1];
  };
  for (const c of s.curves) for (const p of c.points) grow(p);
  for (const d of s.dots) grow(d.p);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((W * s.camera.fit) / spanX, (H * s.camera.fit) / spanY) * s.camera.zoom;
  const ox = W / 2 - ((minX + maxX) / 2) * scale + (s.camera.shiftX ?? 0) * W;
  const oy = H / 2 - ((minY + maxY) / 2) * scale + (s.camera.shiftY ?? 0) * H;
  const project = (p) => {
    const q = view(p);
    return [ox + q[0] * scale, oy + q[1] * scale, q[2]];
  };

  const depth = buildDepth(s.tris, project, W, H);
  const visible = (q) => depth.visible(q);
  const inPanel = (q) =>
    s.panels.some((r) => q[0] > r.x && q[0] < r.x + r.w && q[1] > r.y && q[1] < r.y + r.h);

  const solid = { ink: [], accent: [] };
  const dashed = { ink: [], accent: [] };
  const dots = { ink: [], accent: [] };
  const heads = { ink: [], accent: [] };

  for (const c of s.curves) {
    const key = c.accent ? "accent" : "ink";
    const pts = c.closed ? [...c.points, c.points[0]] : c.points;
    if (pts.length < 2) continue;

    if (c.line) {
      const samples = densify(pts, project, 1.5);
      const flags = samples.map((q) => !inPanel(q) && (c.hidden === "solid" || visible(q)));
      const hiddenOk = samples.map((q) => !inPanel(q));
      despeckle(flags, 3);
      const front = c.dashed ? dashed : solid;
      for (const run of runs(samples, flags, true)) front[key].push(simplify(run, 0.08));
      if (c.hidden === "dash") {
        const back = flags.map((f, i) => !f && hiddenOk[i]);
        for (const run of runs(samples, back, true)) dashed[key].push(simplify(run, 0.08));
      }
      for (const t of c.arrows) {
        const at = alongScreen(pts, project, t);
        if (at && !inPanel(at.q) && (c.hidden === "solid" || visible(at.q))) {
          heads[key].push(arrowhead(at.q, at.dir, style.arrow));
        }
      }
    }

    if (c.beads || c.beadEvery) {
      for (const p of beadsAlong(pts, c)) {
        const q = project(p);
        if (!inPanel(q) && visible(q)) dots[key].push(q);
      }
    }
  }

  for (const d of s.dots) {
    const q = project(d.p);
    if (inPanel(q) || !(d.hidden === "solid" || visible(q))) continue;
    dots[d.accent ? "accent" : "ink"].push(d.accent ? [...q, true] : q);
  }

  return toSvg(s, { solid, dashed, dots, heads });
}

// ── depth buffer ─────────────────────────────────────────────────────────────────────────────

function buildDepth(tris, project, W, H) {
  if (!tris.length) return { visible: () => true };
  const buf = new Float32Array(W * H).fill(-Infinity);
  let zMin = Infinity;
  let zMax = -Infinity;

  for (const t of tris) {
    const [a, b, c] = t.map(project);
    for (const v of [a, b, c]) {
      if (v[2] < zMin) zMin = v[2];
      if (v[2] > zMax) zMax = v[2];
    }
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const i = y * W + x;
        if (z > buf[i]) buf[i] = z;
      }
    }
  }

  // A sample on the surface itself must pass, so compare against the farthest depth in its
  // 3x3 neighbourhood (grazing angles) with a tolerance relative to the scene's depth.
  const eps = 0.006 * (zMax - zMin || 1);
  return {
    visible(q) {
      const cx = Math.round(q[0] - 0.5);
      const cy = Math.round(q[1] - 0.5);
      let far = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const z = x < 0 || y < 0 || x >= W || y >= H ? -Infinity : buf[y * W + x];
          if (z < far) far = z;
        }
      }
      return q[2] >= far - eps;
    },
  };
}

// ── curve sampling ───────────────────────────────────────────────────────────────────────────

/** Resamples a world polyline so consecutive projected samples sit at most `step` px apart. */
function densify(pts, project, step) {
  const out = [project(pts[0])];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const qa = project(a);
    const qb = project(b);
    const n = Math.max(1, Math.ceil(Math.hypot(qb[0] - qa[0], qb[1] - qa[1]) / step));
    for (let k = 1; k <= n; k++) out.push(k === n ? qb : project(lerp(a, b, k / n)));
  }
  return out;
}

/** Flips runs shorter than `min` samples, so occlusion edges don't leave specks of line. */
function despeckle(flags, min) {
  let i = 0;
  while (i < flags.length) {
    let j = i;
    while (j < flags.length && flags[j] === flags[i]) j++;
    if (j - i < min && i > 0 && j < flags.length) for (let k = i; k < j; k++) flags[k] = !flags[k];
    i = j;
  }
}

function runs(samples, flags, want) {
  const out = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    if (flags[i] === want) {
      if (!cur) cur = i > 0 ? [samples[i - 1]] : [];
      cur.push(samples[i]);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.length > 1);
}

/** Ramer–Douglas–Peucker in screen space. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy);
    let best = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      // A closed loop's ends coincide: measure from the shared point instead of a line.
      const d =
        L < 1e-6
          ? Math.hypot(pts[k][0] - ax, pts[k][1] - ay)
          : Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L;
      if (d > best) {
        best = d;
        at = k;
      }
    }
    if (best > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

function cumulative(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + len(sub(pts[i], pts[i - 1])));
  return acc;
}

function pointAt(pts, acc, d) {
  let i = 1;
  while (i < acc.length - 1 && acc[i] < d) i++;
  const seg = acc[i] - acc[i - 1] || 1;
  return lerp(pts[i - 1], pts[i], (d - acc[i - 1]) / seg);
}

function beadsAlong(pts, c) {
  const acc = cumulative(pts);
  const total = acc[acc.length - 1];
  if (!total) return [];
  const n = c.beadEvery ? Math.max(1, Math.round(total / c.beadEvery)) : c.beads;
  const out = [];
  // Closed curves space n beads around the loop; open ones put n beads end to end, offset by
  // `beadPhase` of a gap (0.5 keeps them off the endpoints, 0 starts at the first point).
  const open = !c.closed;
  for (let k = 0; k < n; k++) {
    const t = open && c.beadPhase === 0 && n > 1 ? k / (n - 1) : (k + c.beadPhase) / n;
    out.push(pointAt(pts, acc, t * total));
  }
  return out;
}

function alongScreen(pts, project, t) {
  const acc = cumulative(pts);
  const total = acc[acc.length - 1];
  const p = pointAt(pts, acc, t * total);
  const p2 = pointAt(pts, acc, Math.min(total, t * total + total * 0.002 + 1e-6));
  const p1 = pointAt(pts, acc, Math.max(0, t * total - total * 0.002 - 1e-6));
  const q = project(p);
  const a = project(p1);
  const b = project(p2);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  return L ? { q, dir: [dx / L, dy / L] } : null;
}

function arrowhead(q, dir, size) {
  const [ux, uy] = dir;
  const half = size * 0.36;
  const tip = [q[0] + ux * size * 0.5, q[1] + uy * size * 0.5];
  const back = [q[0] - ux * size * 0.5, q[1] - uy * size * 0.5];
  return [
    tip,
    [back[0] - uy * half, back[1] + ux * half],
    [back[0] + uy * half, back[1] - ux * half],
  ];
}

// ── SVG ──────────────────────────────────────────────────────────────────────────────────────

const f = (n) => (Math.round(n * 100) / 100).toString();

function pathData(runsList) {
  return runsList.map((r) => "M" + r.map((q) => `${f(q[0])} ${f(q[1])}`).join("L")).join("");
}

function toSvg(s, { solid, dashed, dots, heads }) {
  const { width: W, height: H, style } = s;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
  ];
  if (style.paper) out.push(`<rect width="${W}" height="${H}" fill="${style.paper}"/>`);

  const strokeAttrs = `fill="none" stroke-width="${style.stroke}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"`;
  for (const key of ["ink", "accent"]) {
    const color = key === "ink" ? style.ink : style.accent;
    const g = [];
    if (solid[key].length) g.push(`<path d="${pathData(solid[key])}"/>`);
    if (dashed[key].length) {
      g.push(
        `<path stroke-dasharray="${style.dash.join(" ")}" stroke-linecap="butt" d="${pathData(dashed[key])}"/>`,
      );
    }
    if (g.length) out.push(`<g stroke="${color}" ${strokeAttrs}>${g.join("")}</g>`);

    const fills = [];
    for (const q of dots[key]) {
      const r = q[3] ? style.accentDot : style.dot;
      fills.push(`<circle cx="${f(q[0])}" cy="${f(q[1])}" r="${r}"/>`);
    }
    for (const t of heads[key]) {
      fills.push(`<path d="M${t.map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}Z"/>`);
    }
    if (fills.length) out.push(`<g fill="${color}">${fills.join("")}</g>`);
  }

  for (const r of s.panels) {
    out.push(
      `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="${style.paper ?? "#ffffff"}" stroke="${style.ink}" stroke-width="${style.stroke}" vector-effect="non-scaling-stroke"/>`,
    );
  }
  out.push("</svg>");
  return out.join("\n");
}
