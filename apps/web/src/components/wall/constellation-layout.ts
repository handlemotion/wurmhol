/*
 * Where each node of the wall's constellation sits (ADR 0011). Pure: sizes in, centres out, so
 * the frame loop in `constellation.tsx` only eases towards what this returns.
 *
 * The anchor (the copy-the-command field) is the hub. Pipes sit on an ellipse around it, each
 * nudged off its even slot by a jitter hashed from its id, so the ring reads as a drawn network
 * rather than a clock face and a pipe keeps its look across renders. An open pipe's card takes
 * the middle with the anchor just above it, and the ring grows around the pair. When the ring
 * won't fit the width (a phone), the pipes stand in a column above and below the hub instead,
 * arranged so no spoke passes behind another node (`column`). A last pass pushes apart anything
 * that still overlaps and keeps every node inside the width.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export const ANCHOR = "anchor";

/** Clear space between any two nodes, and between a node and the container's sides. */
const GAP = 16;
/** The ring's least spread around the anchor alone, so a few pipes don't huddle on it. */
const MIN_RX = 260;
const MIN_RY = 150;
/** Clear space around an open card (a pipe's, or Create pipe's): it grew, so the pipes around
 * it stand further off than they do from one another. */
const CLEAR = 72;

/** A stable number in [-1, 1) from a string (FNV-1a), for per-pipe jitter. */
export function hash(id: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 2 ** 32) * 2 - 1;
}

export function layout(input: {
  width: number;
  anchor: Size;
  /** In wall order. */
  pipes: { id: string; size: Size }[];
  /** The pipe whose card is open, if any. Its size is the card's. */
  open: { id: string; size: Size } | null;
  /** The anchor is open as the Create pipe card; its size is the card's. */
  anchorOpen?: boolean;
}): { at: Map<string, Point>; top: number; bottom: number } {
  const { width, anchor, pipes, open } = input;
  const at = new Map<string, Point>();
  const fixed = new Set<string>([ANCHOR]);
  const roomy = new Set<string>(input.anchorOpen ? [ANCHOR] : []);
  const sizes = new Map<string, Size>([[ANCHOR, anchor]]);

  // The hub: the anchor alone, or the open card with the anchor above it.
  let hub = { halfW: anchor.w / 2, halfH: anchor.h / 2, y: 0 };
  at.set(ANCHOR, { x: 0, y: 0 });
  if (open) {
    const card = open.size;
    const anchorY = -(card.h / 2 + GAP + anchor.h / 2);
    at.set(ANCHOR, { x: 0, y: anchorY });
    at.set(open.id, { x: 0, y: 0 });
    sizes.set(open.id, card);
    fixed.add(open.id);
    roomy.add(open.id);
    const top = anchorY - anchor.h / 2;
    const bottom = card.h / 2;
    hub = {
      halfW: Math.max(card.w, anchor.w) / 2,
      halfH: (bottom - top) / 2,
      y: (top + bottom) / 2,
    };
  }

  const n = pipes.length;
  if (n > 0) {
    const widest = Math.max(...pipes.map((p) => p.size.w));
    const tallest = Math.max(...pipes.map((p) => p.size.h));
    const clear = roomy.size > 0 ? CLEAR : GAP * 3;
    let rx = Math.max(open ? 0 : MIN_RX, hub.halfW + clear + widest / 2);
    let ry = Math.max(open ? 0 : MIN_RY, hub.halfH + clear + tallest / 2);
    // Room on the ring for every pipe: grow both radii until its length holds them.
    const need = n * (widest * 0.55 + tallest + GAP * 2);
    const ring = () => 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
    if (ring() < need) {
      const s = need / ring();
      rx *= s;
      ry *= s;
    }
    // Too wide for the container (a phone): a column instead of a ring.
    if (rx > Math.max(0, width / 2 - GAP - widest / 2)) {
      for (const [id, p] of column({ width, hub, clear, pipes, at, sizes })) at.set(id, p);
      for (const pipe of pipes) sizes.set(pipe.id, pipe.size);
    } else {
      const step = (Math.PI * 2) / n;
      pipes.forEach((pipe, i) => {
        // Start at the top and go clockwise; the jitter stays inside a quarter of a slot.
        const angle = -Math.PI / 2 + (i + 0.5) * step + hash(pipe.id, 1) * step * 0.25;
        // Around an open card the jitter only reaches outwards, never into its clear space.
        const jitter = hash(pipe.id, 2) * 0.14;
        const reach = 1 + (roomy.size > 0 ? Math.abs(jitter) : jitter);
        at.set(pipe.id, {
          x: Math.cos(angle) * rx * reach,
          y: hub.y + Math.sin(angle) * ry * reach,
        });
        sizes.set(pipe.id, pipe.size);
      });
    }
  }

  relax(at, sizes, fixed, roomy, width);

  let top = Infinity;
  let bottom = -Infinity;
  for (const [id, p] of at) {
    const h = sizes.get(id)!.h;
    top = Math.min(top, p.y - h / 2);
    bottom = Math.max(bottom, p.y + h / 2);
  }
  return { at, top, bottom };
}

type Slot = "left" | "right" | "centre";

/**
 * The phone layout: pipes in rows above and below the hub, each row's pill against one side or
 * in the middle. A spoke runs from the anchor's centre to its pill, so a row nearer the hub can
 * stand in its way. Which arrangement clears every spoke depends on the pills' widths, so this
 * tries a few (how many go above, the sides each row takes, the order of the pipes) and keeps the
 * one whose spokes cross the fewest other nodes; ties go to the shorter column, then the more
 * even split, then the earlier candidate (wall order first), so the choice holds still.
 */
function column(input: {
  width: number;
  hub: { halfH: number; y: number };
  clear: number;
  pipes: { id: string; size: Size }[];
  at: Map<string, Point>;
  sizes: Map<string, Size>;
}): Map<string, Point> {
  const { width, hub, clear, pipes } = input;
  const n = pipes.length;
  const anchor = input.at.get(ANCHOR)!;
  // Whatever already stands in the middle (an open card) blocks spokes too.
  const fixed = [...input.at].filter(([id]) => id !== ANCHOR);
  const byWidth = pipes.toSorted((a, b) => a.size.w - b.size.w);
  const orders = [pipes, byWidth, byWidth.toReversed()];
  let best: { score: number[]; at: Map<string, Point> } | null = null;
  for (const order of orders) {
    for (let above = 0; above <= n; above++) {
      const up = order.slice(0, above);
      const down = order.slice(above);
      for (const upSlots of patterns(up.length)) {
        for (const downSlots of patterns(down.length)) {
          const at = new Map<string, Point>();
          let top = hub.y - hub.halfH;
          let bottom = hub.y + hub.halfH;
          const place = (
            pipe: { id: string; size: Size },
            slot: Slot,
            dir: -1 | 1,
            first: boolean,
          ) => {
            const half = Math.max(0, width / 2 - GAP - pipe.size.w / 2);
            const x = slot === "left" ? -half : slot === "right" ? half : 0;
            const edge = dir < 0 ? top : bottom;
            const y = edge + dir * ((first ? clear : GAP) + pipe.size.h / 2);
            if (dir < 0) top = y - pipe.size.h / 2;
            else bottom = y + pipe.size.h / 2;
            at.set(pipe.id, { x, y });
          };
          up.forEach((pipe, i) => place(pipe, upSlots[i]!, -1, i === 0));
          down.forEach((pipe, i) => place(pipe, downSlots[i]!, 1, i === 0));
          const nodes: [string, Point, Size][] = [
            ...fixed.map(([id, p]): [string, Point, Size] => [id, p, input.sizes.get(id)!]),
            ...pipes.map((pipe): [string, Point, Size] => [pipe.id, at.get(pipe.id)!, pipe.size]),
          ];
          let crossings = 0;
          for (const pipe of pipes) {
            const end = at.get(pipe.id)!;
            for (const [id, p, size] of nodes) {
              if (id !== pipe.id && crosses(anchor, end, p, size)) crossings++;
            }
          }
          const score = [crossings, bottom - top, Math.abs(n - 2 * above)];
          if (!best || less(score, best.score)) best = { score, at };
        }
      }
    }
  }
  return best!.at;
}

/** A side's rows, outwards from the hub: they alternate sides, and the last may take the middle. */
function patterns(k: number): Slot[][] {
  const zig = (first: Slot): Slot[] =>
    Array.from({ length: k }, (_, i) =>
      i % 2 === 0 ? first : first === "left" ? "right" : "left",
    );
  const sides = [zig("left"), zig("right")];
  return k > 0 ? [...sides, ...sides.map((p) => [...p.slice(0, -1), "centre" as const])] : sides;
}

/** Lexicographic `a < b`. */
function less(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** Whether the segment `a`–`b` passes through a node's box, with a few pixels to spare. */
function crosses(a: Point, b: Point, centre: Point, size: Size, spare = 4) {
  const x0 = centre.x - size.w / 2 - spare;
  const x1 = centre.x + size.w / 2 + spare;
  const y0 = centre.y - size.h / 2 - spare;
  const y1 = centre.y + size.h / 2 + spare;
  // Liang-Barsky: clip the segment's parameter range to the box.
  let lo = 0;
  let hi = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
    }
  }
  return lo < hi;
}

/** Push overlapping nodes apart along the shallower axis; fixed nodes hold still. */
function relax(
  at: Map<string, Point>,
  sizes: Map<string, Size>,
  fixed: Set<string>,
  roomy: Set<string>,
  width: number,
) {
  const ids = [...at.keys()];
  const clampX = (id: string) => {
    const p = at.get(id)!;
    const half = Math.max(0, width / 2 - GAP - sizes.get(id)!.w / 2);
    p.x = Math.min(half, Math.max(-half, p.x));
  };
  for (let round = 0; round < 120; round++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        if (fixed.has(a) && fixed.has(b)) continue;
        const [pa, pb] = [at.get(a)!, at.get(b)!];
        const [sa, sb] = [sizes.get(a)!, sizes.get(b)!];
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const gap = roomy.has(a) || roomy.has(b) ? CLEAR : GAP;
        const ox = (sa.w + sb.w) / 2 + gap - Math.abs(dx);
        const oy = (sa.h + sb.h) / 2 + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Sideways only when there is room for it: on a narrow screen, stack instead.
        const sideways = ox < oy && width / 2 - GAP > Math.max(sa.w, sb.w);
        const [ma, mb] = fixed.has(a) ? [0, 1] : fixed.has(b) ? [1, 0] : [0.5, 0.5];
        if (sideways) {
          const d = ox * (dx < 0 ? -1 : 1);
          pa.x -= d * ma;
          pb.x += d * mb;
        } else {
          const d = oy * (dy < 0 ? -1 : 1);
          pa.y -= d * ma;
          pb.y += d * mb;
        }
      }
    }
    for (const id of ids) if (!fixed.has(id)) clampX(id);
    if (!moved) break;
  }
}
