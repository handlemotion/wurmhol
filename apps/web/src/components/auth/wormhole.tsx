import { WormholeChain } from "@/components/auth/wormhole-chain";
import { WormholePlate } from "@/components/auth/wormhole-plate";

/**
 * The login backdrop: the form sits in the hole of the brand's Steiner chain (the
 * `network-create` skill, `scenes/flat/backdrop.mjs`). The drawing is anchored at the centre of
 * the column it wraps, at true size, so the hole stays around the form at any viewport and the
 * ring opens into the page on the form's right. Nothing is drawn inside the hole, so the form
 * needs no fill or mask. It moves on its own, slowly (`WormholeChain`): the ring of circles
 * rolls around the hole, the outer bezel turns against it, and the dashed lines march along
 * their paths. All of it holds still for reduced motion.
 * Behind the page's content (`-z-10` inside the page's `isolate`), inked by
 * `text-hairline-line`. It repaints every frame, so it gets its own compositor layer
 * (`will-change-transform`): its repaints stay in that layer and never repaint the form's
 * buttons and fields drawn over it.
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
        <div
          aria-hidden
          data-wormhole
          className="pointer-events-none absolute top-1/2 left-1/2 -z-10 size-0 will-change-transform"
        >
          <WormholePlate className="text-hairline-line" />
          <WormholeChain className="text-hairline-line" />
        </div>
        {children}
      </div>
    </div>
  );
}
