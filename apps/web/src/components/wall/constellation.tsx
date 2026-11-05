import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ANCHOR, hash, layout, type Point, type Size } from "./constellation-layout";

/*
 * The wall's moving layer (ADR 0011): every node is absolutely placed and moved by one frame
 * loop that writes transforms straight to the DOM, so React renders only when the data changes.
 * Each frame eases a node towards its target from `layout()` and adds a few pixels of drift, and
 * the spokes from the anchor are redrawn from the same positions, so lines never lag the nodes.
 *
 * An open card opens where its pill stands: the layout keeps reading the pill's size, so no other
 * node moves. The card grows away from the anchor (its corner nearest the anchor stays on the
 * pill's), and a camera eases the whole network until the card sits in the middle of the view.
 */

/** Drift, in px: a few pixels at most, slow enough to read as floating, not as motion. */
const DRIFT = { pipe: 2.5, anchor: 1.5, open: 0 };
/** How fast a node closes on its target, per second (an exponential ease-out). */
const EASE = 7;
/** How fast the camera closes on an open card: quicker than the nodes, it follows a press. */
const PAN = 12;
/** Space kept above and below the network inside the canvas. */
const PAD = 48;

function snap(px: number) {
  const dpr = devicePixelRatio || 1;
  return Math.round(px * dpr) / dpr;
}

/** -1, 0 or 1: which way a node sits from the anchor, past half its own closed size. */
function side(offset: number, half: number) {
  return Math.abs(offset) <= half ? 0 : Math.sign(offset);
}

export interface Node {
  id: string;
  render: React.ReactNode;
}

export function Constellation(props: {
  anchor: React.ReactNode;
  nodes: Node[];
  /** The node shown as an open card, if any. Its card carries `data-open`. */
  open: string | null;
}) {
  const { nodes, open } = props;
  const canvas = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  /** Each node's size as a pill (or the Create pipe button): what the layout places. */
  const closed = useRef(new Map<string, Size>());
  const lines = useRef(new Map<string, SVGLineElement>());
  const targets = useRef(new Map<string, Point>());
  const sim = useRef(new Map<string, Point>());
  const origin = useRef({ x: 0, y: 0 });
  const camera = useRef({ x: 0, y: 0 });

  const relayout = useCallback(() => {
    const box = canvas.current;
    if (!box) return;
    const size = (id: string): Size => {
      const el = els.current.get(id);
      const known = closed.current.get(id);
      // A node showing its card keeps the size it had as a pill.
      if (!el || (known && el.querySelector("[data-open]"))) return known ?? { w: 0, h: 0 };
      const measured = { w: el.offsetWidth, h: el.offsetHeight };
      closed.current.set(id, measured);
      return measured;
    };
    const result = layout({
      width: box.clientWidth,
      anchor: size(ANCHOR),
      pipes: nodes.map((node) => ({ id: node.id, size: size(node.id) })),
    });
    // Fill the viewport below the header, or grow past it when the network (or a card) needs it.
    const room = innerHeight - box.getBoundingClientRect().top - scrollY - PAD / 2;
    const need = result.bottom - result.top + PAD * 2;
    const card = open ? (els.current.get(open)?.offsetHeight ?? 0) + PAD * 2 : 0;
    const height = Math.max(room, need, card);
    box.style.height = `${height}px`;
    // Centred, a touch above the true middle where it looks centred (DESIGN.md, optics).
    const slack = Math.max(0, height - need);
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

  // The frame loop. Under reduced motion nodes and the camera jump to their place and hold still.
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = still ? 1 : 1 - Math.exp(-dt * EASE);
      const kPan = still ? 1 : 1 - Math.exp(-dt * PAN);
      const t = now / 1000;
      // Every read before any write, so the loop never forces a layout between its writes.
      const live = new Map<string, Size>();
      for (const [id, el] of els.current) live.set(id, { w: el.offsetWidth, h: el.offsetHeight });
      const box = canvas.current;
      const view = box?.getBoundingClientRect();

      const hubTarget = targets.current.get(ANCHOR) ?? { x: 0, y: 0 };
      const drawn = new Map<string, Point>();
      const centres = new Map<string, Point>();
      for (const [id, target] of targets.current) {
        // A new pipe comes out of the anchor.
        let p = sim.current.get(id);
        if (!p) {
          const from = sim.current.get(ANCHOR) ?? hubTarget;
          p = { ...from };
          sim.current.set(id, p);
        }
        p.x += (target.x - p.x) * k;
        p.y += (target.y - p.y) * k;
        const a = still ? 0 : id === open ? DRIFT.open : id === ANCHOR ? DRIFT.anchor : DRIFT.pipe;
        const phase = hash(id, 3) * Math.PI;
        const x = p.x + a * Math.sin(t * (0.55 + hash(id, 4) * 0.15) + phase);
        const y = p.y + a * Math.cos(t * (0.45 + hash(id, 5) * 0.15) + phase);
        drawn.set(id, { x, y });
        // A card grows outwards from its pill: the pill's corner nearest the anchor stays put.
        const pill = closed.current.get(id);
        const size = live.get(id);
        if (!pill || !size) continue;
        const sx = id === ANCHOR ? 0 : side(target.x - hubTarget.x, pill.w / 2);
        const sy = id === ANCHOR ? 0 : side(target.y - hubTarget.y, pill.h / 2);
        const dx = (sx * (size.w - pill.w)) / 2;
        const dy = (sy * (size.h - pill.h)) / 2;
        centres.set(id, { x: x + dx, y: y + dy });
        // The card scales in from where the pill was.
        els.current
          .get(id)!
          .style.setProperty("--grow-origin", `${size.w / 2 - dx}px ${size.h / 2 - dy}px`);
      }

      // The camera: an open card in the middle of what is visible of the canvas, else at rest.
      const focus = open ? centres.get(open) : undefined;
      const goal = { x: 0, y: 0 };
      if (focus && box && view) {
        const top = Math.max(0, -view.top);
        const bottom = Math.min(box.clientHeight, innerHeight - view.top);
        const card = live.get(open!)!;
        goal.x = box.clientWidth / 2 - (origin.current.x + focus.x);
        goal.y =
          Math.max((top + bottom) / 2, top + card.h / 2 + PAD / 2) - (origin.current.y + focus.y);
      }
      const cam = camera.current;
      cam.x += (goal.x - cam.x) * kPan;
      cam.y += (goal.y - cam.y) * kPan;
      const ox = origin.current.x + cam.x;
      const oy = origin.current.y + cam.y;

      for (const [id, c] of centres) {
        const el = els.current.get(id)!;
        const size = live.get(id)!;
        // Whole device pixels: a node between pixels is resampled, and its 1px edges smear
        // into a doubled, darker line.
        const left = snap(ox + c.x - size.w / 2);
        const top = snap(oy + c.y - size.h / 2);
        el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
        el.style.visibility = "visible";
      }
      const hub = drawn.get(ANCHOR);
      for (const [id, line] of lines.current) {
        const end = drawn.get(id);
        if (!hub || !end) continue;
        // On a device pixel's centre: a 1px line on a pixel boundary paints two half-lit pixels
        // and reads twice as thick.
        const mid = 0.5 / (devicePixelRatio || 1);
        line.setAttribute("x1", String(snap(ox + hub.x) + mid));
        line.setAttribute("y1", String(snap(oy + hub.y) + mid));
        line.setAttribute("x2", String(snap(ox + end.x) + mid));
        line.setAttribute("y2", String(snap(oy + end.y) + mid));
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
      {/* Hidden until the first frame places them, so nothing flashes in the corner. A node
          showing its card stands over the rest, through its close too. */}
      <div
        ref={place(ANCHOR)}
        className="invisible absolute left-0 top-0 will-change-transform has-data-open:z-10"
      >
        {props.anchor}
      </div>
      <ul className="contents">
        {nodes.map((node) => (
          <li
            key={node.id}
            ref={place(node.id)}
            className="invisible absolute left-0 top-0 will-change-transform has-data-open:z-10"
          >
            {node.render}
          </li>
        ))}
      </ul>
    </div>
  );
}
