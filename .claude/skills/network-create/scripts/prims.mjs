// Geometry for network graphics. Each primitive returns `{ curves, dots, mesh }` in world
// space, ready for `scene.add()`: curves are `{ points, ...curveOptions }`, dots `{ p }`, mesh
// a list of triangles that occlude. Y is up.

import {
  add,
  basis,
  cross,
  dot,
  len,
  lerp,
  mul,
  norm,
  rad,
  random,
  rotate,
  sub,
} from "./engine.mjs";

const TAU = Math.PI * 2;

/** A circle of radius `r` around `c` in the plane with normal `n`. */
export function circle(c, r, n = [0, 1, 0], segments = 192) {
  const [u, w] = basis(n);
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * TAU;
    pts.push(add(c, add(mul(u, Math.cos(t) * r), mul(w, Math.sin(t) * r))));
  }
  return pts;
}

/** Triangles for a parametric surface `fn(u, v)` over [0,1]², `nu` by `nv` cells. */
export function grid(fn, nu, nv) {
  const tris = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = fn(i / nu, j / nv);
      const b = fn((i + 1) / nu, j / nv);
      const c = fn((i + 1) / nu, (j + 1) / nv);
      const d = fn(i / nu, (j + 1) / nv);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return tris;
}

const transform = (p, { c = [0, 0, 0], tilt = [0, 0, 0] }) => {
  let q = rotate(p, [1, 0, 0], tilt[0]);
  q = rotate(q, [0, 1, 0], tilt[1]);
  q = rotate(q, [0, 0, 1], tilt[2]);
  return add(q, c);
};

/**
 * A globe: `meridians` great circles through the pole and `parallels` latitude rings, tilted
 * by `tilt` (degrees about x, y, z). `hole` (degrees) opens the north pole: parallels inside
 * that cap are dropped and meridians stop at its rim, where a ring marks the opening.
 */
export function sphere({
  c = [0, 0, 0],
  r = 1,
  meridians = 12,
  parallels = 7,
  tilt = [0, 0, 0],
  hole = 0,
  beads = 0,
  rim = true,
} = {}) {
  const at = (theta, phi) =>
    transform(
      [
        r * Math.sin(theta) * Math.cos(phi),
        r * Math.cos(theta),
        r * Math.sin(theta) * Math.sin(phi),
      ],
      { c, tilt },
    );
  const top = rad(hole);
  const curves = [];
  for (let m = 0; m < meridians; m++) {
    const phi = (m / meridians) * TAU;
    const pts = [];
    for (let k = 0; k <= 96; k++) pts.push(at(top + (Math.PI - top) * (k / 96), phi));
    curves.push({ points: pts, beads });
  }
  for (let p = 1; p <= parallels; p++) {
    const theta = (p / (parallels + 1)) * Math.PI;
    if (theta <= top + 1e-6) continue;
    const pts = [];
    for (let k = 0; k < 192; k++) pts.push(at(theta, (k / 192) * TAU));
    curves.push({ points: pts, closed: true, beads: beads ? beads * 2 : 0 });
  }
  if (hole && rim) {
    const pts = [];
    for (let k = 0; k < 192; k++) pts.push(at(top, (k / 192) * TAU));
    curves.push({ points: pts, closed: true });
  }
  const mesh = grid((u, v) => at(top + (Math.PI - top) * u, v * TAU), 48, 96);
  return { curves, dots: [], mesh };
}

/**
 * The throat: Flamm's paraboloid, the embedding diagram of a Schwarzschild wormhole. Radius
 * grows as r = rs + y²/(4·rs) away from the throat at y = 0. `sheets`: "both" | "upper" |
 * "lower". Rings are spaced evenly in y, so seen from above they crowd toward the throat like
 * a tunnel. Returns `rimTop`/`rimBottom` radii so clusters can sit on the lips.
 */
export function throat({
  c = [0, 0, 0],
  rs = 1,
  h = 3,
  rings = 9,
  meridians = 24,
  sheets = "both",
  tilt = [0, 0, 0],
  beads = 0,
} = {}) {
  const radius = (y) => rs + (y * y) / (4 * rs);
  const y0 = sheets === "upper" ? 0 : -h;
  const y1 = sheets === "lower" ? 0 : h;
  const at = (y, phi) =>
    transform([radius(y) * Math.cos(phi), y, radius(y) * Math.sin(phi)], { c, tilt });
  const curves = [];
  for (let m = 0; m < meridians; m++) {
    const phi = (m / meridians) * TAU;
    const pts = [];
    for (let k = 0; k <= 120; k++) pts.push(at(y0 + (y1 - y0) * (k / 120), phi));
    curves.push({ points: pts, beads });
  }
  for (let i = 0; i <= rings; i++) {
    const y = y0 + (y1 - y0) * (i / rings);
    const pts = [];
    for (let k = 0; k < 192; k++) pts.push(at(y, (k / 192) * TAU));
    curves.push({ points: pts, closed: true });
  }
  const mesh = grid((u, v) => at(y0 + (y1 - y0) * u, v * TAU), 72, 96);
  return { curves, dots: [], mesh, radius, at };
}

/**
 * A spacetime sheet: a square grid of `n` lines a side, pulled down into a well of depth
 * `depth` and width `w` at the centre. Every crossing is a node (a dot), so the grid reads as
 * a network that drains into the hole. `cut` removes crossings inside that radius (the throat).
 */
export function sheet({ size = 6, n = 25, depth = 2.5, w = 0.9, cut = 0.5, nodes = true } = {}) {
  const yAt = (x, z) => (-depth * (w * w)) / (x * x + z * z + w * w);
  const p = (x, z) => [x, yAt(x, z), z];
  const half = size / 2;
  const curves = [];
  const dots = [];
  const coord = (i) => -half + (size * i) / (n - 1);
  const pushLine = (fn) => {
    // Split each grid line where it enters the cut, so lines end at the throat's lip.
    let run = [];
    for (let k = 0; k <= 240; k++) {
      const q = fn(-half + (size * k) / 240);
      if (Math.hypot(q[0], q[2]) < cut) {
        if (run.length > 1) curves.push({ points: run });
        run = [];
      } else run.push(q);
    }
    if (run.length > 1) curves.push({ points: run });
  };
  for (let i = 0; i < n; i++) {
    const a = coord(i);
    pushLine((t) => p(a, t));
    pushLine((t) => p(t, a));
  }
  if (nodes) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = coord(i);
        const z = coord(j);
        if (Math.hypot(x, z) >= cut) dots.push({ p: p(x, z) });
      }
    }
  }
  const mesh = grid((u, v) => p(-half + size * u, -half + size * v), 96, 96).filter((t) =>
    t.every((q) => Math.hypot(q[0], q[2]) >= cut * 0.98),
  );
  return { curves, dots, mesh, y: yAt };
}

/**
 * A node cluster: `n` points scattered through a ball (kept at least `gap`·r apart), joined by
 * a minimum spanning tree plus each node's `k` nearest neighbours. `shell` in (0, 1] pushes
 * nodes toward the surface (1 = all on it, laid out evenly). `squash` flattens it along y.
 * `jitter` (radians) loosens the even layout. A shell's links run as great-circle arcs over
 * an occluding hull, so its far side hides (or dashes) like a real globe.
 */
export function cluster({
  c = [0, 0, 0],
  r = 1,
  n = 24,
  k = 2,
  seed = 1,
  shell = 0.5,
  squash = 1,
  gap = 0.28,
  jitter = 0.25,
} = {}) {
  const rnd = random(seed);
  const nodes = [];
  if (shell >= 1) {
    // On the surface: a Fibonacci lattice (evenly spread, so links form a clean near-
    // triangulation), randomly oriented and lightly jittered so no two globes look alike.
    const axis = norm([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
    const spin = rnd() * 360;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const ring = Math.sqrt(1 - y * y);
      const t = i * golden + (rnd() - 0.5) * jitter;
      const d = rotate(
        norm([Math.cos(t) * ring, y + (rnd() - 0.5) * jitter * 0.2, Math.sin(t) * ring]),
        axis,
        spin,
      );
      nodes.push(add(c, [d[0] * r, d[1] * r * squash, d[2] * r]));
    }
  }
  let guard = 0;
  while (nodes.length < n && guard++ < n * 400) {
    const d = norm([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
    const radial = shell + (1 - shell) * Math.cbrt(rnd());
    const p = add(c, [d[0] * r * radial, d[1] * r * radial * squash, d[2] * r * radial]);
    if (nodes.every((q) => len(sub(p, q)) > gap * r)) nodes.push(p);
  }
  const edges = connect(nodes, k);
  const onShell = shell >= 1 && squash === 1;
  const path = ([i, j]) => {
    if (!onShell) return [nodes[i], nodes[j]];
    const a = norm(sub(nodes[i], c));
    const b = norm(sub(nodes[j], c));
    const pts = [];
    for (let s = 0; s <= 24; s++) pts.push(add(c, mul(norm(lerp(a, b, s / 24)), r)));
    return pts;
  };
  return {
    nodes,
    curves: edges.map((e) => ({ points: path(e) })),
    dots: nodes.map((p) => ({ p })),
    mesh: onShell ? sphere({ c, r: r * 0.985, meridians: 0, parallels: 0 }).mesh : undefined,
  };
}

/** Edges for a point set: a minimum spanning tree (always connected) plus k-nearest links. */
export function connect(nodes, k = 2) {
  const n = nodes.length;
  const seen = new Set();
  const edges = [];
  const link = (i, j) => {
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (i === j || seen.has(key)) return;
    seen.add(key);
    edges.push([i, j]);
  };
  // Prim's MST.
  const inTree = new Uint8Array(n);
  const best = Array.from({ length: n }, () => Infinity);
  const from = Array.from({ length: n }, () => -1);
  best[0] = 0;
  for (let step = 0; step < n; step++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u === -1 || best[i] < best[u])) u = i;
    inTree[u] = 1;
    if (from[u] >= 0) link(u, from[u]);
    for (let v = 0; v < n; v++) {
      const d = len(sub(nodes[u], nodes[v]));
      if (!inTree[v] && d < best[v]) {
        best[v] = d;
        from[v] = u;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const near = nodes
      .map((p, j) => [j, len(sub(p, nodes[i]))])
      .filter(([j]) => j !== i)
      .toSorted((a, b) => a[1] - b[1])
      .slice(0, k);
    for (const [j] of near) link(i, j);
  }
  return edges;
}

/** A curved link from `a` to `b`, bowed by `bulge` toward `up` (a quadratic Bézier). */
export function arc(a, b, { bulge = 0.25, up = [0, 1, 0], segments = 64 } = {}) {
  const mid = lerp(a, b, 0.5);
  const span = len(sub(b, a));
  const ctrl = add(mid, mul(norm(up), span * bulge));
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pts.push(add(add(mul(a, (1 - t) * (1 - t)), mul(ctrl, 2 * t * (1 - t))), mul(b, t * t)));
  }
  return pts;
}

/** Radial hatching around a circle: `count` strokes of length `length`, outward from `r`. */
export function ticks(c, r, { n = [0, 1, 0], count = 180, length = 0.08, every = 0 } = {}) {
  const [u, w] = basis(n);
  const curves = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * TAU;
    const dir = add(mul(u, Math.cos(t)), mul(w, Math.sin(t)));
    const long = every && i % every === 0 ? 1.8 : 1;
    curves.push({ points: [add(c, mul(dir, r)), add(c, mul(dir, r + length * long))] });
  }
  return { curves, dots: [] };
}

/** A flat lattice of dots (no lines) in the plane y = `y`: the quietest possible ground. */
export function field({ size = 8, n = 17, y = 0, c = [0, 0, 0] } = {}) {
  const dots = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -size / 2 + (size * i) / (n - 1);
      const z = -size / 2 + (size * j) / (n - 1);
      dots.push({ p: add(c, [x, y, z]) });
    }
  }
  return { curves: [], dots };
}

/** A torus around the y axis: `rings` tube sections and `loops` circles along the tube. */
export function torus({
  c = [0, 0, 0],
  R = 2,
  r = 0.6,
  rings = 32,
  loops = 6,
  tilt = [0, 0, 0],
} = {}) {
  const at = (a, b) =>
    transform(
      [(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)],
      { c, tilt },
    );
  const curves = [];
  for (let i = 0; i < rings; i++) {
    const a = (i / rings) * TAU;
    const pts = [];
    for (let k = 0; k < 64; k++) pts.push(at(a, (k / 64) * TAU));
    curves.push({ points: pts, closed: true });
  }
  for (let j = 0; j < loops; j++) {
    const b = (j / loops) * TAU;
    const pts = [];
    for (let k = 0; k < 192; k++) pts.push(at((k / 192) * TAU, b));
    curves.push({ points: pts, closed: true });
  }
  return { curves, dots: [], mesh: grid((u, v) => at(u * TAU, v * TAU), 96, 32), at };
}

/** Points along a straight segment, for axes and guides that should carry beads. */
export function line(a, b, segments = 1) {
  const pts = [];
  for (let i = 0; i <= segments; i++) pts.push(lerp(a, b, i / segments));
  return pts;
}

/** Projects `p` onto the plane through `o` with normal `n` (for shadows and floor marks). */
export function flatten(p, o = [0, 0, 0], n = [0, 1, 0]) {
  const k = norm(n);
  return sub(p, mul(k, dot(sub(p, o), k)));
}

export { cross };
