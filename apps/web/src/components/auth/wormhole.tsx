import { WormholeChain } from "@/components/auth/wormhole-chain";
import { WormholePlate } from "@/components/auth/wormhole-plate";

/**
 * The login backdrop: the form sits in the hole of the brand's Steiner chain (the
 * `network-create` skill, `scenes/flat/backdrop.mjs`). The drawing is anchored at the centre of
 * the column it wraps, at true size, so the hole stays around the form at any viewport and the
 * ring opens into the page on the form's right. Nothing is drawn inside the hole, so the form
 * needs no fill or mask. The ring of circles around the hole is drawn live (`WormholeChain`):
 * it drifts around the hole and rolls with the cursor, and holds still for reduced motion.
 * Behind the page's content (`-z-10` inside the page's `isolate`), inked by
 * `text-hairline-line`.
 */
export function Wormhole({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 -z-10 size-0">
          <WormholePlate className="text-hairline-line" />
          <WormholeChain className="text-hairline-line" />
        </div>
        {children}
      </div>
    </div>
  );
}
