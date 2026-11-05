import { useEffect } from "react";

/*
 * The login backdrop's moving layer: the Steiner chain and the outer circle's bezel, drawn live.
 * The static rest of the construction is generated (`wormhole-plate.tsx`, from
 * `.claude/skills/network-create/scenes/flat/backdrop.mjs` with `--set chain=off`); these
 * constants and `steiner()` must match that scene.
 *
 * Steiner's porism: if a ring of circles closes once between two circles, it closes from any
 * starting phase. So the ring can roll around the hole forever, every circle staying tangent to
 * its neighbours, the hole and the outer circle, growing as it passes the open side. The hole
 * and the outer circle don't depend on the phase, so only this layer moves.
 *
 * Drawn for a phone's battery: one loop, at `FPS`, writes the chain as three paths (strokes,
 * dashes, filled nodes) and the dashes' march as one custom property, so each frame restyles a
 * handful of elements and React renders once. The bezel never changes shape, only its angle: it
 * is its own small `<svg>` turned by a CSS animation (`wormhole-turn` in styles.css), which the
 * compositor runs off the main thread.
 */
const HOLE = 310;
const N = 9;
const E = 0.45;
/** One ring step (2π/N) per minute: slow enough to read as drift, not as a spinner. */
const DRIFT = (Math.PI * 2) / N / 60;
/**
 * Redraws per second. The chain's edges move at most 13 px/s, so a step is under half a pixel:
 * smooth to the eye, at half a 60 Hz screen's main-thread work and a quarter of a 120 Hz one's.
 */
const FPS = 30;
/** The dashes march one dash period (6 on, 5 off) every four seconds, so they loop without a seam. */
const MARCH = 11 / 4;

type Point = [number, number];
type Circle = { c: Point; r: number };

function invert({ c, r }: Circle, o: Point): Circle {
  const dx = c[0] - o[0];
  const dy = c[1] - o[1];
  const s = 1 / (dx * dx + dy * dy - r * r);
  return { c: [o[0] + dx * s, o[1] + dy * s], r: Math.abs(r * s) };
}

/** The chain at `phase` (radians), in px around the form column's centre. */
export function steiner(phase: number) {
  const s = Math.sin(Math.PI / N);
  const R2 = (1 + s) / (1 - s);
  const rho = (1 + R2) / 2;
  const rr = (R2 - 1) / 2;
  const O: Point = [E, 0];
  const outer0 = invert({ c: [0, 0], r: 1 }, O);
  const hole0 = invert({ c: [0, 0], r: R2 }, O);
  const k = HOLE / hole0.r;
  const flip = outer0.c[0] > hole0.c[0] ? 1 : -1;
  const T = (C: Circle): Circle => ({
    c: [flip * (C.c[0] - hole0.c[0]) * k, (C.c[1] - hole0.c[1]) * k],
    r: C.r * k,
  });
  const chain = Array.from({ length: N }, (_, i) => {
    const t = Math.PI + phase + (i / N) * Math.PI * 2;
    return T(invert({ c: [rho * Math.cos(t), rho * Math.sin(t)], r: rr }, O));
  });
  return { hole: T(hole0), outer: T(outer0), chain };
}

function towards(from: Point, to: Point, d: number): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const L = Math.hypot(dx, dy) || 1;
  return [from[0] + (dx / L) * d, from[1] + (dy / L) * d];
}

/** The bezel: 240 radial ticks outside the outer circle, every 12th one long, as one path. */
function bezelPath({ c, r }: Circle) {
  let d = "";
  for (let i = 0; i < 240; i++) {
    const t = (i / 240) * Math.PI * 2;
    const l = i % 12 === 0 ? 14 : 7;
    const [x, y] = [Math.cos(t), Math.sin(t)];
    d += `M${c[0] + x * r} ${c[1] + y * r}L${c[0] + x * (r + l)} ${c[1] + y * (r + l)}`;
  }
  return d;
}

/** A circle as a path: two half arcs from its leftmost point. */
const ring = ({ c: [x, y], r }: Circle) =>
  `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

/** Squares for nodes, as in the generated plate: side `size`, centred on the point. */
const square = ([x, y]: Point, size: number) =>
  `M${x - size / 2} ${y - size / 2}h${size}v${size}h${-size}Z`;

/**
 * The chain at `phase` as three paths' `d`: its circles (stroked), the polygon through their
 * centres and the spokes to the hole (dashed; the dash restarts with each subpath), and its
 * nodes (filled): where neighbours touch, where it meets the hole and the outer circle, and
 * each circle's centre.
 */
function chainPaths(phase: number) {
  const { hole, outer, chain } = steiner(phase);
  let circles = "";
  let dashes = `M${chain.map((C) => `${C.c[0]} ${C.c[1]}`).join("L")}Z`;
  let nodes = "";
  chain.forEach((C, i) => {
    const next = chain[(i + 1) % N]!;
    const rim = towards(hole.c, C.c, hole.r);
    circles += ring(C);
    dashes += `M${rim[0]} ${rim[1]}L${C.c[0]} ${C.c[1]}`;
    nodes += square(towards(C.c, next.c, C.r), 8);
    nodes += square(rim, 6);
    nodes += square(towards(outer.c, C.c, outer.r), 6);
    nodes += ring({ c: C.c, r: 2.5 });
  });
  return { circles, dashes, nodes };
}

/** The chain at rest: the first frame, and the only one under reduced motion. */
const REST = steiner(0);
const REST_PATHS = chainPaths(0);
const BEZEL = bezelPath(REST.outer);
/**
 * The bezel's own box: a square around the outer circle and its longest ticks, on whole pixels
 * so its ticks rasterize exactly as they would in the plate's coordinates.
 */
const BEZEL_BOX = (() => {
  const [cx, cy] = REST.outer.c;
  const r = REST.outer.r + 15;
  const x = Math.floor(cx - r);
  const y = Math.floor(cy - r);
  const size = Math.ceil(cx + r) - x;
  return { x, y, size, origin: `${cx - x}px ${cy - y}px` };
})();

/**
 * Runs the backdrop's frame loop while motion is allowed: it starts and stops with the
 * reduced-motion setting, and frames pause while the tab is hidden. `root` holds the generated
 * plate and the chain; its dashed lines read `--march`.
 */
export function useWormholeMotion(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    const [circles, dashes, nodes] = el?.querySelectorAll("[data-chain] path") ?? [];
    if (!el || !circles || !dashes || !nodes) return;
    const draw = (seconds: number) => {
      const d = chainPaths(seconds * DRIFT);
      circles.setAttribute("d", d.circles);
      dashes.setAttribute("d", d.dashes);
      nodes.setAttribute("d", d.nodes);
      el.style.setProperty("--march", `${-((seconds * MARCH) % 11)}px`);
    };
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = 0;
    let drawn = -Infinity;
    const tick = (now: number) => {
      start ||= now;
      // Skips frames on a faster screen: a redraw at most every 1/FPS s (less a millisecond,
      // so a 60 Hz screen's frames, which arrive a hair early or late, keep every other one).
      if (now - drawn >= 1000 / FPS - 1) {
        drawn = now;
        draw((now - start) / 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      // Motion (re)starts from rest, as the bezel's CSS animation does.
      start = 0;
      if (query.matches) draw(0);
      else frame = requestAnimationFrame(tick);
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
      cancelAnimationFrame(frame);
    };
  }, [root]);
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1,
  vectorEffect: "non-scaling-stroke",
} as const;
const DASH = { ...STROKE, strokeDasharray: "6 5" } as const;

/** The chain and the bezel, laid over the generated plate in the same coordinates. */
export function WormholeChain({ className }: { className?: string }) {
  const { x, y, size, origin } = BEZEL_BOX;
  return (
    <>
      <svg
        viewBox={`${x} ${y} ${size} ${size}`}
        className={className}
        aria-hidden="true"
        data-bezel
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: size,
          height: size,
          maxWidth: "none",
          // It turns about the outer circle's centre.
          transformOrigin: origin,
        }}
      >
        <path {...STROKE} d={BEZEL} />
      </svg>
      <svg
        viewBox="-1000 -1000 3600 2000"
        className={className}
        aria-hidden="true"
        data-chain
        style={{
          position: "absolute",
          left: -1000,
          top: -1000,
          width: 3600,
          height: 2000,
          maxWidth: "none",
        }}
      >
        <path {...STROKE} d={REST_PATHS.circles} />
        <path {...DASH} d={REST_PATHS.dashes} />
        <path fill="currentColor" d={REST_PATHS.nodes} />
      </svg>
    </>
  );
}
