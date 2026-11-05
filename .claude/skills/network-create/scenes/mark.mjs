// The emblem: a node globe inside an instrument ring, an orbit crossing it, and the pivot at
// its heart showing through. Hairline, like every other plate.
import { scene } from "../scripts/engine.mjs";
import { circle, cluster, sphere, ticks } from "../scripts/prims.mjs";

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 0, yaw: 0, fit: 0.98, zoom: 1.5 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  s.add(cluster({ r: 3, n: 150, k: 4, seed: o.seed + 3, shell: 1 }));
  s.add(ticks([0, 0, 0], 3.3, { n: [0, 0, 1], count: 240, length: 0.26, every: 12 }), {
    hidden: "solid",
  });
  s.curve(circle([0, 0, 0], 3.3, [0, 0, 1]), { closed: true, hidden: "solid" });
  s.curve(circle([0, 0, 0], 4.1, [0.35, 1, 0.2]), {
    closed: true,
    line: false,
    beads: 90,
    hidden: "solid",
  });
  // Outer orbits past the frame, the plate's widest layer.
  s.add(sphere({ r: 6.2, meridians: 4, parallels: 2, tilt: [58, 20, 30], beads: 34 }), {
    occlude: false,
    hidden: "solid",
  });
  s.dot([0, 0, 0], { accent: true, hidden: "solid" });
  return s;
};
