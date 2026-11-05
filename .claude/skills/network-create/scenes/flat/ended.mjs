// The pages the Worker serves on a share host (ended, reconnecting, refused): the pipe seen
// head-on, down its length, to where it stops. A square duct in one-point perspective, centred
// on the viewport: frames grow by φ outwards from the end wall, and the duct's corner and wall
// lines run in from past the page, stopping at that wall instead of meeting in a point. The
// message sits on the end wall: 520 × 200 px (φ² wide to tall), clear of the widest message
// (448 px). Nodes sit where the wall lines cross the frames.
import { best, PHI, plate } from "../../scripts/flat.mjs";

const W = 3600;
const H = 2400;
const END = [520, 200]; // the end wall

export default (o) =>
  best(
    (rnd) => {
      const p = plate({
        width: W,
        height: H,
        origin: [W / 2, H / 2],
        style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper, dash: [6, 5] },
      });
      // A frame at scale s around the centre, as corners.
      const frame = (s) => {
        const w = (END[0] / 2) * s;
        const h = (END[1] / 2) * s;
        return { w, h };
      };
      const scales = Array.from({ length: 8 }, (_, k) => PHI ** (k / 2));
      scales.forEach((s, k) => {
        const { w, h } = frame(s);
        p.frame(-w, -h, w * 2, h * 2, { dashed: k % 2 === 1 });
      });
      const far = (pt) => [pt[0] * 9, pt[1] * 9];

      // The duct's corners, from the end wall's corners out past the page.
      const { w, h } = frame(1);
      for (const c of [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h],
      ])
        p.line(c, far(c));

      // Wall lines on a modular step along each side of the end wall: floor and ceiling dashed,
      // side walls solid on the coarser step.
      const along = [];
      for (let i = -4; i <= 4; i++) if (i) along.push([(i / 5) * w, -h], [(i / 5) * w, h]);
      for (const i of [-1, 1]) along.push([-w, (i / 2) * h], [w, (i / 2) * h]);
      along.forEach((pt) => p.line(pt, far(pt), { dashed: Math.abs(pt[1]) === h }));

      // Nodes where the wall lines cross the solid frames, sparse and seeded; every corner.
      scales.forEach((s, k) => {
        if (k % 2) return;
        for (const pt of along) if (rnd() < 0.3) p.node([pt[0] * s, pt[1] * s], { size: 6 });
        for (const c of [
          [-w, -h],
          [w, -h],
          [w, h],
          [-w, h],
        ])
          p.node([c[0] * s, c[1] * s], { size: k === 0 ? 8 : 6 });
      });
      return p;
    },
    { seed: o.seed, tries: 16 },
  );
