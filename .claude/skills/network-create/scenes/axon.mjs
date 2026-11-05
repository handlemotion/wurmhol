// An axonometric diagram: a dotted ground, a construction sphere in dashes, the equator in a
// solid line, and four links converging on the pivot, each ending in a small node cluster.
import { scene } from "../scripts/engine.mjs";
import { circle, cluster, field, line } from "../scripts/prims.mjs";

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 22, yaw: -18, fit: 0.9 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  s.add(field({ size: 12, n: 25, y: -2.4 }));
  s.curve(circle([0, 0, 0], 2.2, [0, 0, 1]), { closed: true, dashed: true });
  s.curve(circle([0, 0, 0], 2.2, [1, 0, 0.35]), { closed: true, dashed: true });
  s.curve(circle([0, 0, 0], 2.2, [0, 1, 0]), { closed: true });
  s.curve(circle([0, 0, 0], 0.7, [0, 1, 0]), { closed: true, dashed: true, accent: true });
  s.curve(line([0, -2.4, 0], [0, 3.2, 0]));
  const ends = [
    [5.4, 0, 1.6, true],
    [-5.4, 0, -1.6, false],
    [1.8, 0, -5.4, true],
    [-1.8, 0, 5.4, false],
  ];
  for (const [x, y, z, inward] of ends) {
    const far = [x, y, z];
    s.curve(inward ? [far, [0, 0, 0]] : [[0, 0, 0], far], { arrows: [inward ? 0.42 : 0.62] });
    s.add(
      cluster({
        c: [x * 1.12, y, z * 1.12],
        r: 0.55,
        n: 18,
        k: 4,
        seed: o.seed + x * 3 + z,
        shell: 1,
      }),
    );
  }
  s.dot([0, 0, 0], { accent: true });
  return s;
};
