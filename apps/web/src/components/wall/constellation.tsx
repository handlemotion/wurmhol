import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ANCHOR, hash, layout, type Point, type Size } from "./constellation-layout";

/*
 * The wall's moving layer (ADR 0011): every node is absolutely placed and moved by one frame
 * loop that writes transforms straight to the DOM, so React renders only when the data changes.
 * Each frame eases a node towards its target from `layout()` and adds a few pixels of drift, and
 * the spokes from the anchor are redrawn from the same positions, so lines never lag the nodes.
 */

/** Drift, in px: a few pixels at most, slow enough to read as floating, not as motion. */
const DRIFT = { pipe: 2.5, anchor: 1.5, open: 0 };
/** How fast a node closes on its target, per second (an exponential ease-out). */
const EASE = 7;
/** Space kept above and below the network inside the canvas. */
const PAD = 48;

function snap(px: number) {
  const dpr = devicePixelRatio || 1;
  return Math.round(px * dpr) / dpr;
}

export interface Node {
  id: string;
  render: React.ReactNode;
}

export function Constellation(props: {
  anchor: React.ReactNode;
  nodes: Node[];
  /** The node shown as an open card, if any. */
  open: string | null;
}) {
  const { nodes, open } = props;
  const canvas = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const sizes = useRef(new Map<string, Size>());
  const lines = useRef(new Map<string, SVGLineElement>());
  const targets = useRef(new Map<string, Point>());
  const sim = useRef(new Map<string, Point>());
  const origin = useRef({ x: 0, y: 0 });

  const relayout = useCallback(() => {
    const box = canvas.current;
    if (!box) return;
    const size = (id: string): Size => {
      const el = els.current.get(id);
      const measured = { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
      sizes.current.set(id, measured);
      return measured;
    };
    const ids = nodes.map((node) => node.id);
    const result = layout({
      width: box.clientWidth,
      anchor: size(ANCHOR),
      pipes: ids.filter((id) => id !== open).map((id) => ({ id, size: size(id) })),
      open: open && ids.includes(open) ? { id: open, size: size(open) } : null,
      anchorOpen: open === ANCHOR,
    });
    // Fill the viewport below the header, or grow past it when the network needs more.
    const room = innerHeight - box.getBoundingClientRect().top - scrollY - PAD / 2;
    const need = result.bottom - result.top + PAD * 2;
    const height = Math.max(room, need);
    box.style.height = `${height}px`;
    // Centred, a touch above the true middle where it looks centred (DESIGN.md, optics).
    const slack = height - need;
    origin.current = {
      x: box.clientWidth / 2,
      y: PAD + slack / 2 - Math.min(24, slack / 4) - result.top,
    };
    targets.current = result.at;
  }, [nodes, open]);

  useLayoutEffect(relayout);

  // Sizes change without a render: fonts arrive, a title loads, the window narrows.
  useEffect(() => {
    const observer = new ResizeObserver(() => relayout());
    if (canvas.current) observer.observe(canvas.current);
    for (const el of els.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [relayout]);

  // The frame loop. Under reduced motion nodes jump to their place and hold still.
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = still ? 1 : 1 - Math.exp(-dt * EASE);
      const t = now / 1000;
      const drawn = new Map<string, Point>();
      for (const [id, target] of targets.current) {
        // A new pipe comes out of the anchor.
        let p = sim.current.get(id);
        if (!p) {
          const from = sim.current.get(ANCHOR) ?? targets.current.get(ANCHOR) ?? target;
          p = { ...from };
          sim.current.set(id, p);
        }
        p.x += (target.x - p.x) * k;
        p.y += (target.y - p.y) * k;
        // With a card open, the anchor holds still with it, so the spoke between them stays a
        // straight 1px line instead of a slanted, thicker-looking one.
        const a = still
          ? 0
          : id === open || (open && id === ANCHOR)
            ? DRIFT.open
            : id === ANCHOR
              ? DRIFT.anchor
              : DRIFT.pipe;
        const phase = hash(id, 3) * Math.PI;
        const x = p.x + a * Math.sin(t * (0.55 + hash(id, 4) * 0.15) + phase);
        const y = p.y + a * Math.cos(t * (0.45 + hash(id, 5) * 0.15) + phase);
        drawn.set(id, { x, y });
        const el = els.current.get(id);
        const size = sizes.current.get(id);
        if (el && size) {
          // Whole device pixels: a node between pixels is resampled, and its 1px edges smear
          // into a doubled, darker line.
          const left = snap(origin.current.x + x - size.w / 2);
          const top = snap(origin.current.y + y - size.h / 2);
          el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
          el.style.visibility = "visible";
        }
      }
      const hub = drawn.get(ANCHOR);
      for (const [id, line] of lines.current) {
        const end = drawn.get(id);
        if (!hub || !end) continue;
        // On a device pixel's centre: a 1px line on a pixel boundary paints two half-lit pixels
        // and reads twice as thick (worst on the straight spoke to an open card).
        const mid = 0.5 / (devicePixelRatio || 1);
        line.setAttribute("x1", String(snap(origin.current.x + hub.x) + mid));
        line.setAttribute("y1", String(snap(origin.current.y + hub.y) + mid));
        line.setAttribute("x2", String(snap(origin.current.x + end.x) + mid));
        line.setAttribute("y2", String(snap(origin.current.y + end.y) + mid));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Forget the ones that left, so a pipe that comes back flies out of the anchor again.
  const live = new Set([ANCHOR, ...nodes.map((node) => node.id)]);
  for (const id of sim.current.keys()) if (!live.has(id)) sim.current.delete(id);

  const place = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  };

  return (
    <div ref={canvas} className="relative w-full overflow-hidden">
      <svg aria-hidden className="absolute inset-0 size-full text-hairline-line">
        {nodes.map((node) => (
          <line
            key={node.id}
            ref={(el) => {
              if (el) lines.current.set(node.id, el);
              else lines.current.delete(node.id);
            }}
            stroke="currentColor"
            strokeWidth={1}
          />
        ))}
      </svg>
      {/* Hidden until the first frame places them, so nothing flashes in the corner. */}
      <div ref={place(ANCHOR)} className="invisible absolute left-0 top-0 will-change-transform">
        {props.anchor}
      </div>
      <ul className="contents">
        {nodes.map((node) => (
          <li
            key={node.id}
            ref={place(node.id)}
            className="invisible absolute left-0 top-0 will-change-transform"
          >
            {node.render}
          </li>
        ))}
      </ul>
    </div>
  );
}
