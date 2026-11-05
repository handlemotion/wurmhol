/**
 * The login backdrop: concentric hairline rings that crowd together toward the centre, like
 * looking down a tunnel, and fade out as they go deeper so the middle is pure dark. The form sits
 * in that dark throat. Drawn in the foreground's ink, so it follows the theme.
 */
const RINGS = 24;
/** Larger spacing out at the edge, tighter near the centre: the tunnel's perspective. */
const DEPTH = 2.6;
/** The outermost ring's radius, in viewBox units; the viewBox is 2000 wide, so it overflows. */
const RADIUS = 1400;
const PEAK_OPACITY = 0.24;

const rings = Array.from({ length: RINGS }, (_, i) => {
  const t = (i + 1) / RINGS;
  // Rings fade into the dark centre, and ease off at the very edge so none ends abruptly.
  const edge = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
  return { r: RADIUS * t ** DEPTH, opacity: PEAK_OPACITY * t ** 1.4 * edge };
});

export function Wormhole({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="-1000 -1000 2000 2000"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
    >
      {rings.map(({ r, opacity }) => (
        <circle
          key={r}
          r={r}
          stroke="currentColor"
          strokeOpacity={opacity}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
