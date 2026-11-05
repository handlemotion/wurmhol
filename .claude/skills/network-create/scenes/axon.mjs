// An axonometric diagram: a dotted ground past the frame, a construction sphere in dashes, the
// equator solid with an instrument ring, and six links converging on the pivot, each ending in
// a node globe dropped to the ground by a dashed plumb line.
import { scene } from "../scripts/engine.mjs";
import { circle, cluster, field, line, ticks } from "../scripts/prims.mjs";

const FLOOR = -3.4;

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 24, yaw: -32, fit: 0.98, zoom: 1.55, shiftY: -0.04 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  s.add(field({ size: 18, n: 49, y: FLOOR }));
  for (const n of [
    [0, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
    [-1, 1, 0],
  ]) {
    s.curve(circle([0, 0, 0], 3, n), { closed: true, dashed: true });
  }
  s.curve(circle([0, 0, 0], 3), { closed: true });
  s.add(ticks([0, 0, 0], 3, { count: 180, length: 0.22, every: 15 }));
  s.curve(circle([0, 0, 0], 4.4), { closed: true, line: false, beads: 140 });
  s.curve(circle([0, 0, 0], 0.9), { closed: true, dashed: true, accent: true });
  s.curve(line([0, FLOOR, 0], [0, 6.5, 0]));

  const ends = [
    [7, 0, 0, 0.8],
    [-7, 0, 0, 0.7],
    [0, 0, 7, 0.75],
    [0, 0, -7, 0.65],
    [4.6, 2.6, -4.6, 0.55],
    [-3.4, 3.4, -5.6, 0.6],
  ];
  ends.forEach(([x, y, z, r], i) => {
    const far = [x, y, z];
    const inward = i % 2 === 0;
    s.curve(inward ? [far, [0, 0, 0]] : [[0, 0, 0], far], { arrows: [inward ? 0.4 : 0.6] });
    s.add(cluster({ c: far, r, n: 30, k: 4, seed: o.seed + i, shell: 1 }), { hidden: "none" });
    s.curve(line([x, y - r, z], [x, FLOOR, z]), { dashed: true });
    s.curve(circle([x, FLOOR, z], r), { closed: true });
  });
  s.dot([0, 0, 0], { accent: true });
  return s;
};
