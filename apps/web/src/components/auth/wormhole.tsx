import { useEffect, useRef } from "react";

/**
 * The login backdrop: concentric hairline rings that crowd together toward the centre, like
 * looking down a tunnel, and fade out as they go deeper so the middle is pure dark. The rings
 * drift slowly inward, each one taking the place of the next, so the tunnel loops seamlessly.
 * The form sits in the dark throat. Drawn in the foreground's ink, so it follows the theme.
 */
const RINGS = 10;
/** Larger spacing out at the edge, tighter near the centre: the tunnel's perspective. */
const DEPTH = 2.6;
/** The outermost ring's radius, in viewBox units; the viewBox is 2000 wide, so it overflows. */
const RADIUS = 1400;
const PEAK_OPACITY = 0.12;
/** How long one ring takes to move into the next one's place. */
const PERIOD_MS = 6000;

/** A ring at depth `t` (0 is the centre, 1 the outermost ring). */
function ring(t: number) {
  // Rings fade into the dark centre, and ease off at the very edge so none ends abruptly.
  const edge = t > 0.85 ? Math.max(0, 1 - (t - 0.85) / 0.15) : 1;
  return { r: RADIUS * t ** DEPTH, opacity: PEAK_OPACITY * t ** 1.4 * edge };
}

/** Ring `i` at `phase` (0 to 1 of the way to its inner neighbour's place). */
const depth = (i: number, phase: number) => (i + 1 - phase) / RINGS;

export function Wormhole({ className }: { className?: string }) {
  const circles = useRef<(SVGCircleElement | null)[]>([]);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const phase = ((now - start) % PERIOD_MS) / PERIOD_MS;
      circles.current.forEach((circle, i) => {
        if (!circle) return;
        const { r, opacity } = ring(depth(i, phase));
        circle.setAttribute("r", String(r));
        circle.setAttribute("stroke-opacity", String(opacity));
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg
      aria-hidden
      className={className}
      viewBox="-1000 -1000 2000 2000"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
    >
      {Array.from({ length: RINGS }, (_, i) => {
        const { r, opacity } = ring(depth(i, 0));
        return (
          <circle
            key={i}
            ref={(el) => {
              circles.current[i] = el;
            }}
            r={r}
            stroke="currentColor"
            strokeOpacity={opacity}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}
