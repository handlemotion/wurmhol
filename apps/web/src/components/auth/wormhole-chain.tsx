import { useEffect, useMemo, useState } from "react";

/*
 * The login backdrop's Steiner chain, drawn live. The static rest of the construction is
 * generated (`wormhole-plate.tsx`, from `.claude/skills/network-create/scenes/flat/backdrop.mjs`
 * with `--set chain=off`); these constants and `steiner()` must match that scene.
 *
 * Steiner's porism: if a ring of circles closes once between two circles, it closes from any
 * starting phase. So the ring can roll around the hole forever, every circle staying tangent to
 * its neighbours, the hole and the outer circle, growing as it passes the open side. The hole
 * and the outer circle don't depend on the phase, so only this layer moves.
 */
const HOLE = 310;
const N = 9;
const E = 0.45;
/** One ring step (2π/N) per 90 s: a drift you notice only when you look for it. */
const DRIFT = (Math.PI * 2) / N / 90;
/** Sweeping the cursor across the page rolls the ring half a step: felt, not chased. */
const PULL = ((Math.PI * 2) / N) * 0.5;

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

/**
 * The phase: drifts on its own and eases toward where the cursor pulls it. Stays at 0 for
 * reduced motion. Animation frames stop while the tab is hidden.
 */
function usePhase() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let target = 0;
    let pull = 0;
    let frame = 0;
    const start = performance.now();
    const onMove = (event: PointerEvent) => {
      target = (event.clientX / innerWidth - 0.5) * PULL;
    };
    const tick = (now: number) => {
      pull += (target - pull) * 0.04;
      setPhase(((now - start) / 1000) * DRIFT + pull);
      frame = requestAnimationFrame(tick);
    };
    addEventListener("pointermove", onMove, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("pointermove", onMove);
    };
  }, []);
  return phase;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1,
  vectorEffect: "non-scaling-stroke",
} as const;
const DASH = { ...STROKE, strokeDasharray: "6 5" } as const;

/** Squares for nodes, as in the generated plate: side `size`, centred on the point. */
function Node({ p, size }: { p: Point; size: number }) {
  return (
    <rect fill="currentColor" x={p[0] - size / 2} y={p[1] - size / 2} width={size} height={size} />
  );
}

/** The live chain, laid over the generated plate in the same coordinates. */
export function WormholeChain({ className }: { className?: string }) {
  const phase = usePhase();
  const { hole, outer, chain } = useMemo(() => steiner(phase), [phase]);
  return (
    <svg
      viewBox="-1000 -1000 3600 2000"
      className={className}
      aria-hidden="true"
      style={{
        position: "absolute",
        left: -1000,
        top: -1000,
        width: 3600,
        height: 2000,
        maxWidth: "none",
      }}
    >
      <path {...DASH} d={`M${chain.map((C) => `${C.c[0]} ${C.c[1]}`).join("L")}Z`} />
      {chain.map((C, i) => {
        const next = chain[(i + 1) % N]!;
        const rim = towards(hole.c, C.c, hole.r);
        return (
          <g key={i}>
            <circle {...STROKE} cx={C.c[0]} cy={C.c[1]} r={C.r} />
            <path {...DASH} d={`M${rim[0]} ${rim[1]}L${C.c[0]} ${C.c[1]}`} />
            <Node p={towards(C.c, next.c, C.r)} size={8} />
            <Node p={rim} size={6} />
            <Node p={towards(outer.c, C.c, outer.r)} size={6} />
            <circle fill="currentColor" cx={C.c[0]} cy={C.c[1]} r={2.5} />
          </g>
        );
      })}
    </svg>
  );
}
