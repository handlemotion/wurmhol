// The favicon: one construction from the plates, cut to what survives at 16px. Drawn on a 32px
// grid, a hairline stroke (`--stroke 1`) that scales with the icon (`scaleStroke`), and inks that
// follow the viewer's color scheme (`scheme`). Every candidate is named; render one with
// `--set name=<name>`, or all of them side by side with `--seeds 11` (seed n is the nth name).
import { meet, PHI, plate } from "../../scripts/flat.mjs";

const C = [16, 16];

const CANDIDATES = {
  /** Two circles through each other's centres, the pivot in their lens. */
  lens(p) {
    p.circle([11.5, 16], 9).circle([20.5, 16], 9);
    p.node(C, { shape: "dot", size: 5, accent: true });
  },
  /** The lens inside the circle that holds it, the axis through all three. */
  holding(p) {
    p.circle(C, 14.5).circle([12, 16], 8).circle([20, 16], 8);
    p.line([1.5, 16], [30.5, 16]);
    p.node(C, { shape: "dot", size: 4, accent: true });
  },
  /** The login backdrop in miniature: the hole off-centre, two ring circles closing the gap. */
  chain(p) {
    p.circle(C, 14.5).circle([11, 16], 6.5).circle([24, 9.6], 5.3).circle([24, 22.4], 5.3);
    p.node([11, 16], { shape: "dot", size: 4, accent: true });
  },
  /** A concentric Steiner chain of six: the hole ringed by six touching circles. */
  flower(p) {
    const s = Math.sin(Math.PI / 6);
    const R1 = 5;
    const R2 = (R1 * (1 + s)) / (1 - s);
    const rr = (R2 - R1) / 2;
    const rho = (R1 + R2) / 2;
    p.circle(C, R2);
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2 + Math.PI / 6;
      p.circle([16 + rho * Math.cos(t), 16 + rho * Math.sin(t)], rr);
    }
    p.node(C, { shape: "dot", size: 4, accent: true });
  },
  /** An instrument: a ring with a 12-step bezel and the axis, the pivot at its heart. */
  bezel(p) {
    p.circle(C, 10);
    p.ticks(C, 11.5, { count: 12, length: 2.5 });
    p.line([1, 16], [9, 16]).line([23, 16], [31, 16]);
    p.node(C, { shape: "dot", size: 5, accent: true });
  },
  /** A small and a large circle, their inner tangents crossing at the centre of similitude. */
  tangents(p) {
    const c1 = [5.5, 16];
    const r1 = 3.5;
    const c2 = [22, 16];
    const r2 = 9;
    p.circle(c1, r1).circle(c2, r2);
    // The inner tangents cross at I; by similar triangles each one touches the small circle at
    // I − (t − I)·r1/r2, where it touches the large one at t.
    const I = [(r2 * c1[0] + r1 * c2[0]) / (r1 + r2), 16];
    for (const t of meet.tangents(I, c2, r2)) {
      const k = r1 / r2;
      p.line([I[0] - (t[0] - I[0]) * k, I[1] - (t[1] - I[1]) * k], t);
    }
    p.node(I, { shape: "dot", size: 3.5, accent: true });
  },
  /** One-point perspective: frames shrinking by 1/φ to the vanishing point, corner rays. */
  tunnel(p) {
    const vp = [17, 16];
    for (let k = 0; k < 3; k++) {
      const s = PHI ** -k;
      const half = 13 * s;
      p.frame(vp[0] - half, vp[1] - half, half * 2, half * 2);
    }
    for (const [x, y] of [
      [4, 3],
      [30, 3],
      [30, 29],
      [4, 29],
    ])
      p.line([x, y], [vp[0] + (x - vp[0]) * 0.38, vp[1] + (y - vp[1]) * 0.38]);
    p.node(vp, { shape: "dot", size: 4, accent: true });
  },
  /** The golden spiral: a φ rectangle cut into squares, the spiral's quarter arcs, its eye. */
  spiral(p) {
    let [x, y, w, h] = [2, 7.5, 28, 28 / PHI];
    p.frame(x, y, w, h);
    for (let i = 0; i < 4; i++) {
      const side = Math.min(w, h);
      const dir = i % 4;
      if (dir === 0) {
        p.line([x + side, y], [x + side, y + h]);
        p.arc([x + side, y + side], side, Math.PI, Math.PI * 1.5);
        x += side;
        w -= side;
      } else if (dir === 1) {
        p.line([x, y + side], [x + w, y + side]);
        p.arc([x, y + side], side, -Math.PI / 2, 0);
        y += side;
        h -= side;
      } else if (dir === 2) {
        p.line([x + w - side, y], [x + w - side, y + h]);
        p.arc([x + w - side, y], side, 0, Math.PI / 2);
        w -= side;
      } else {
        p.arc([x + side, y + h - side], side, Math.PI / 2, Math.PI);
        h -= side;
      }
    }
    p.node([x + w / 2, y + h / 2], { shape: "dot", size: 3.5, accent: true });
  },
  /** A portal: a round arch on two piers, the ground line, the keystone as the pivot. */
  portal(p) {
    const ground = 27;
    const spring = 15;
    const r = 7;
    p.line([1, ground], [31, ground]);
    p.line([16 - r, ground], [16 - r, spring]).line([16 + r, ground], [16 + r, spring]);
    p.arc([16, spring], r, Math.PI, Math.PI * 2);
    p.arc([16, spring], r + 4, Math.PI, Math.PI * 2);
    p.line([16 - r - 4, ground], [16 - r - 4, spring]).line(
      [16 + r + 4, ground],
      [16 + r + 4, spring],
    );
    p.node([16, spring - r - 2], { size: 3.5, accent: true });
  },
  /** A network on a ring: four nodes, the chords that cross through the hole. */
  graph(p) {
    p.circle(C, 11);
    const at = (deg) => [
      16 + 11 * Math.cos((deg * Math.PI) / 180),
      16 + 11 * Math.sin((deg * Math.PI) / 180),
    ];
    const n = [200, 320, 20, 140].map(at);
    p.line(n[0], n[2]).line(n[1], n[3]).line(n[0], n[1]);
    for (const q of n) p.node(q, { size: 3.5 });
    p.node(meet.lines(n[0], n[2], n[1], n[3]), { shape: "dot", size: 4, accent: true });
  },
  /** A pencil of circles: three circles tangent inside one another at a point, like a funnel. */
  funnel(p) {
    for (const r of [14, 9.5, 5.5]) p.circle([2 + r, 16], r);
    p.line([2, 16], [30, 16]);
    p.node([2 + 5.5, 16], { shape: "dot", size: 3.5, accent: true });
  },
};

export const NAMES = Object.keys(CANDIDATES);
/** The favicon that ships. */
export const SHIPPED = "lens";

export default (o) => {
  const p = plate({
    width: 32,
    height: 32,
    // `--set tile=on`: black ink on a white tile with barely rounded corners, the same on every
    // tab bar. Otherwise bare, inked for the viewer's color scheme.
    style:
      o.set?.tile === "on"
        ? {
            ink: "#171717",
            accent: o.accent,
            stroke: o.stroke,
            scaleStroke: true,
            paper: "#ffffff",
            paperRadius: 3,
            inset: 3,
          }
        : {
            ink: o.ink,
            accent: o.accent,
            stroke: o.stroke,
            scaleStroke: true,
            scheme: { light: "#171717", dark: "#ededed" },
          },
  });
  const name = o.set?.name ?? NAMES[(o.seed - 1) % NAMES.length] ?? SHIPPED;
  CANDIDATES[name](p);
  return p;
};
