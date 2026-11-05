import { cn } from "cn";

/**
 * The login backdrop: concentric hairline rings, each a fixed fraction of the one outside it, so
 * they crowd toward the centre like looking down a tunnel. The whole set shrinks by that
 * fraction once per cycle (`animate-wormhole` in styles.css), which moves every ring exactly
 * into its inner neighbour's place, so the fall loops seamlessly. It is one transform on one
 * layer, so the compositor runs it and nothing on top repaints. A radial mask fades the rings
 * out toward the dark centre, where the form sits, and at the edges. Drawn in the foreground's
 * ink, so it follows the theme.
 */
/** Each ring's radius over the one outside it. Must match the `wormhole` keyframe's scale. */
const RATIO = 0.72;
/**
 * Enough rings that the outermost stays past the viewport's corners at the end of a cycle. The
 * SVG is drawn at 150% of the page, so even shrunk by `RATIO` it still covers every edge.
 */
const RINGS = 14;
/** The outermost ring's radius, in viewBox units; the viewBox is 2000 wide. */
const RADIUS = 2000;
const OPACITY = 0.12;

const radii = Array.from({ length: RINGS }, (_, i) => RADIUS * RATIO ** i);

export function Wormhole({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("overflow-hidden", className)}
      style={{
        maskImage:
          "radial-gradient(circle farthest-corner, transparent 10%, black 45%, black 70%, transparent 100%)",
      }}
    >
      <svg
        className="absolute -inset-1/4 size-[150%] animate-wormhole will-change-transform motion-reduce:animate-none"
        viewBox="-1000 -1000 2000 2000"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        {radii.map((r) => (
          <circle
            key={r}
            r={r}
            stroke="currentColor"
            strokeOpacity={OPACITY}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
