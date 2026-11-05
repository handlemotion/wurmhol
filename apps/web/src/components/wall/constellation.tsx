import { cn } from "cn";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ANCHOR, grow, hash, layout, type Point, type Size } from "./constellation-layout";

/*
 * The wall's moving layer (ADR 0011): every node is absolutely placed and moved by one frame
 * loop that writes transforms straight to the DOM, so React renders only when the data changes.
 * Each node, the camera and the network's centring are springs: they carry their velocity, so a
 * target that changes mid-flight (another press, a resize, a pipe arriving) bends the motion
 * instead of restarting or snapping it. Each frame adds a few pixels of drift, and the spokes
 * from the anchor are redrawn from the same positions, so lines never lag the nodes.
 *
 * The loop runs at the screen's rate only while a spring is moving. At rest only the drift
 * moves, under two pixels a second, so it ticks at `IDLE_FPS`; under reduced motion nothing
 * drifts and it stops until something changes (a layout, a scroll, a resize). A frame writes
 * only what changed, so a still node costs no style or layout work.
 *
 * An open card opens where its pill stands, growing away from the anchor (its corner nearest the
 * anchor stays on the pill's); the network leans away from it, and a camera carries the whole
 * network until the card sits in the middle of the view.
 */

/** Drift, in px: a few pixels at most, slow enough to read as floating, not as motion. */
const DRIFT = { pipe: 2.5, anchor: 1.5, open: 0 };
/** The nodes' spring: a touch under critical damping, so a pushed pill settles with a little give. */
const NODE = { stiffness: 140, damping: 21 };
/** The camera's and the centring's spring: critically damped, so the view never overshoots. */
const VIEW = { stiffness: 110, damping: 21 };
/** Integration step: small enough to keep the springs stable on a slow frame. */
const STEP = 1 / 240;
/**
 * Ticks per second while only the drift moves. The drift is under 1.75 px/s and every position
 * snaps to device pixels, so 15 steps a second is as smooth as the screen's rate.
 */
const IDLE_FPS = 15;
/** Closer than this to its goal (px) and slower than `REST_V` (px/s), a spring is at rest. */
const REST_D = 0.05;
const REST_V = 0.5;
/** Space kept above and below the network inside the canvas. */
const PAD = 48;

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Moves `body` towards `goal` by `dt` seconds of a damped spring (semi-implicit Euler). */
function spring(body: Body, goal: Point, dt: number, k: { stiffness: number; damping: number }) {
  for (let left = dt; left > 0; left -= STEP) {
    const h = Math.min(STEP, left);
    body.vx += (k.stiffness * (goal.x - body.x) - k.damping * body.vx) * h;
    body.vy += (k.stiffness * (goal.y - body.y) - k.damping * body.vy) * h;
    body.x += body.vx * h;
    body.y += body.vy * h;
  }
}

/** Puts `body` on `goal` at rest (reduced motion, or the first frame). */
function settle(body: Body, goal: Point) {
  Object.assign(body, { x: goal.x, y: goal.y, vx: 0, vy: 0 });
}

/** Settles `body` once it is close enough to rest; returns whether it still moves. */
function moving(body: Body, goal: Point) {
  const near = Math.abs(goal.x - body.x) < REST_D && Math.abs(goal.y - body.y) < REST_D;
  if (near && Math.abs(body.vx) < REST_V && Math.abs(body.vy) < REST_V) {
    settle(body, goal);
    return false;
  }
  return true;
}

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
  /** The node shown as an open card, if any. Its card carries `data-open`. */
  open: string | null;
  /** A drawing behind the network, its (0, 0) held on the anchor's place (without its drift). */
  backdrop?: React.ReactNode;
}) {
  const { nodes, open } = props;
  const canvas = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  /** Each node's size as a pill (or the Create pipe button): what the layout places. */
  const closed = useRef(new Map<string, Size>());
  const lines = useRef(new Map<string, SVGLineElement>());
  const backdrop = useRef<HTMLDivElement>(null);
  const targets = useRef(new Map<string, Point>());
  const sim = useRef(new Map<string, Body>());
  /** Where the network's (0, 0) sits in the canvas: its goal, and the spring that follows it. */
  const origin = useRef<Point | null>(null);
  const seat = useRef<Body | null>(null);
  const camera = useRef<Body>({ x: 0, y: 0, vx: 0, vy: 0 });
  /** Restarts the frame loop at the screen's rate: a layout, a scroll or a resize moved a goal. */
  const wake = useRef(() => {});

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
    // The open card, once it is showing (its pill leaves first).
    const card = open ? els.current.get(open) : undefined;
    const input = {
      width: box.clientWidth,
      anchor: size(ANCHOR),
      pipes: nodes.map((node) => ({ id: node.id, size: size(node.id) })),
    };
    // The network at rest places it in the canvas; an open card only moves nodes within that
    // frame (and the camera), so opening one never shifts the whole network at once.
    const rest = layout(input);
    const result = layout({
      ...input,
      open:
        open && card?.querySelector("[data-open]")
          ? { id: open, size: { w: card.offsetWidth, h: card.offsetHeight } }
          : null,
    });
    // Fill the viewport below the header, or grow past it when the network (or a card) needs it.
    const room = innerHeight - box.getBoundingClientRect().top - scrollY - PAD / 2;
    const need = rest.bottom - rest.top + PAD * 2;
    // Centred, a touch above the true middle where it looks centred (DESIGN.md, optics).
    const slack = Math.max(0, room - need);
    const y = PAD + slack / 2 - Math.min(24, slack / 4) - rest.top;
    const height = Math.max(
      room,
      need,
      y + result.bottom + PAD,
      card ? card.offsetHeight + PAD * 2 : 0,
    );
    box.style.height = `${height}px`;
    origin.current = { x: box.clientWidth / 2, y };
    targets.current = result.at;
    wake.current();
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
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    let still = query.matches;
    let frame = 0;
    let idle = 0;
    // 0 after a pause: the next tick steps one frame, so a goal that moved while the loop slept
    // starts its spring from rest instead of leaping a long step at once.
    let last = 0;
    /** What each element was last given, so an unchanged value is never written again. */
    const written = new Map<string, string>();
    const put = (key: string, value: string, write: () => void) => {
      if (written.get(key) === value) return;
      written.set(key, value);
      write();
    };
    const tick = (now: number) => {
      frame = 0;
      // A long gap (a background tab) is cut short, so nothing leaps when the page comes back.
      const dt = last ? Math.min(0.064, (now - last) / 1000) : 1 / 60;
      last = now;
      let busy = false;
      const move = (body: Body, goal: Point, k: typeof NODE) => {
        if (still) settle(body, goal);
        else spring(body, goal, dt, k);
        busy = moving(body, goal) || busy;
      };
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
          p = { x: from.x, y: from.y, vx: 0, vy: 0 };
          sim.current.set(id, p);
        }
        move(p, target, NODE);
        const a = still ? 0 : id === open ? DRIFT.open : id === ANCHOR ? DRIFT.anchor : DRIFT.pipe;
        const phase = hash(id, 3) * Math.PI;
        const x = p.x + a * Math.sin(t * (0.55 + hash(id, 4) * 0.15) + phase);
        const y = p.y + a * Math.cos(t * (0.45 + hash(id, 5) * 0.15) + phase);
        drawn.set(id, { x, y });
        // A card grows outwards from its pill: the pill's corner nearest the anchor stays put.
        const pill = closed.current.get(id);
        const size = live.get(id);
        if (!pill || !size) continue;
        const { x: dx, y: dy } = grow(id, target, hubTarget, pill, size);
        centres.set(id, { x: x + dx, y: y + dy });
        // Where the pill stands inside the card's box: the card unfolds from that rect (`Swap`).
        const style = els.current.get(id)!.style;
        const pillAt = `${size.w / 2 - dx}px ${size.h / 2 - dy}px ${pill.w}px ${pill.h}px`;
        put(`${id} pill`, pillAt, () => {
          style.setProperty("--pill-x", `${size.w / 2 - dx}px`);
          style.setProperty("--pill-y", `${size.h / 2 - dy}px`);
          style.setProperty("--pill-w", `${pill.w}px`);
          style.setProperty("--pill-h", `${pill.h}px`);
        });
      }

      // The camera: an open pipe's card in the middle of what is visible of the canvas, else at
      // rest. Create pipe's card opens where its button stands, centred on it: the camera moves
      // only as far as it takes to keep the card in view (a short window).
      const focus = open ? centres.get(open) : undefined;
      const goal = { x: 0, y: 0 };
      if (!origin.current) return void (frame = requestAnimationFrame(tick));
      if (!seat.current) seat.current = { ...origin.current, vx: 0, vy: 0 };
      if (focus && box && view) {
        const top = Math.max(0, -view.top);
        const bottom = Math.min(box.clientHeight, innerHeight - view.top);
        const card = live.get(open!)!;
        const x = seat.current.x + focus.x;
        const y = seat.current.y + focus.y;
        if (open === ANCHOR) {
          const room = (bottom - top - card.h) / 2;
          const clear = Math.min(PAD / 2, Math.max(0, room));
          goal.y =
            Math.max(0, top + clear - (y - card.h / 2)) -
            Math.max(0, y + card.h / 2 - (bottom - clear));
        } else {
          goal.x = box.clientWidth / 2 - x;
          goal.y = Math.max((top + bottom) / 2, top + card.h / 2 + PAD / 2) - y;
        }
      }
      const cam = camera.current;
      move(cam, goal, VIEW);
      move(seat.current, origin.current, VIEW);
      const ox = seat.current.x + cam.x;
      const oy = seat.current.y + cam.y;

      for (const [id, c] of centres) {
        const el = els.current.get(id)!;
        const size = live.get(id)!;
        // Whole device pixels: a node between pixels is resampled, and its 1px edges smear
        // into a doubled, darker line.
        const left = snap(ox + c.x - size.w / 2);
        const top = snap(oy + c.y - size.h / 2);
        put(id, `${left} ${top}`, () => {
          el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
          el.style.visibility = "visible";
        });
      }
      // The backdrop holds still on the anchor's resting place: it ignores the camera's pan and the
      // Create pipe card's offset, so opening the card only scales it up where it stands. Nor does
      // it follow the anchor's drift: a whole drawing swaying would read as the page moving.
      const hubAt = sim.current.get(ANCHOR);
      if (backdrop.current && hubAt) {
        const x = snap(seat.current.x + hubAt.x);
        const y = snap(seat.current.y + hubAt.y);
        const style = backdrop.current.style;
        put("backdrop", `${x} ${y}`, () => {
          style.transform = `translate3d(${x}px, ${y}px, 0)`;
          style.visibility = "visible";
        });
      }
      const hub = drawn.get(ANCHOR);
      for (const [id, line] of lines.current) {
        const end = drawn.get(id);
        if (!hub || !end) continue;
        // On a device pixel's centre: a 1px line on a pixel boundary paints two half-lit pixels
        // and reads twice as thick.
        const mid = 0.5 / (devicePixelRatio || 1);
        const [x1, y1] = [snap(ox + hub.x) + mid, snap(oy + hub.y) + mid];
        const [x2, y2] = [snap(ox + end.x) + mid, snap(oy + end.y) + mid];
        put(`${id} line`, `${x1} ${y1} ${x2} ${y2}`, () => {
          line.setAttribute("x1", String(x1));
          line.setAttribute("y1", String(y1));
          line.setAttribute("x2", String(x2));
          line.setAttribute("y2", String(y2));
        });
      }
      if (busy) frame = requestAnimationFrame(tick);
      else if (!still) {
        idle = window.setTimeout(() => {
          idle = 0;
          last = 0;
          frame = requestAnimationFrame(tick);
        }, 1000 / IDLE_FPS);
      } else last = 0;
    };
    const wakeUp = () => {
      if (frame) return;
      clearTimeout(idle);
      idle = 0;
      frame = requestAnimationFrame(tick);
    };
    const onMotion = () => {
      still = query.matches;
      wakeUp();
    };
    wake.current = wakeUp;
    query.addEventListener("change", onMotion);
    // The camera keeps an open card in view, so its goal moves with the page.
    addEventListener("scroll", wakeUp, { passive: true });
    addEventListener("resize", wakeUp);
    wakeUp();
    return () => {
      wake.current = () => {};
      query.removeEventListener("change", onMotion);
      removeEventListener("scroll", wakeUp);
      removeEventListener("resize", wakeUp);
      cancelAnimationFrame(frame);
      clearTimeout(idle);
    };
  }, [open]);

  // Forget the ones that left, so a pipe that comes back flies out of the anchor again.
  const live = new Set([ANCHOR, ...nodes.map((node) => node.id)]);
  for (const id of sim.current.keys()) if (!live.has(id)) sim.current.delete(id);

  const place = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  };

  return (
    <div ref={canvas} className="relative w-full">
      {props.backdrop && (
        <div
          ref={backdrop}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 size-0 will-change-transform"
        >
          {/* Opening Create pipe leans into the drawing: it grows a little about the anchor,
              while its lines stay 1px (non-scaling strokes). */}
          <div
            className={cn(
              "transition-transform duration-700 ease-out motion-reduce:transition-none",
              open === ANCHOR && "scale-105",
            )}
          >
            {props.backdrop}
          </div>
        </div>
      )}
      <svg aria-hidden className="absolute inset-0 size-full overflow-visible text-hairline-line">
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
