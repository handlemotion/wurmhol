// Spacetime as a network: a grid of links, every crossing a node, pulled into a well. Node
// globes rest in the fabric and dent it, an instrument ring marks the lip of the throat, and
// dashed orbits hang above. The sheet runs past the frame.
import { scene } from "../scripts/engine.mjs";
import { circle, cluster, sheet, ticks } from "../scripts/prims.mjs";

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 40, yaw: 30, perspective: 22, fit: 0.98, zoom: 1.7, shiftY: 0.16 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  const sh = sheet({ size: 16, n: 41, depth: 3.6, w: 1.25, cut: 0.55 });
  s.add(sh, { hidden: "none" });
  const lipY = sh.y(0.55, 0);
  s.add(ticks([0, lipY, 0], 0.62, { count: 120, length: 0.2, every: 10 }), { hidden: "none" });
  // A wide instrument ring where the well meets the flat sheet.
  const ringY = sh.y(3, 0) + 0.04;
  s.add(ticks([0, ringY, 0], 3, { count: 260, length: 0.3, every: 13 }), { hidden: "none" });
  s.curve(circle([0, ringY, 0], 3), { closed: true, hidden: "none" });

  const spots = [
    [4.4, 2.4, 0.9],
    [-3.4, 4.2, 0.75],
    [-4.4, -3.2, 1.0],
    [3.2, -4.6, 0.7],
    [0.6, 5.8, 0.6],
  ];
  spots.forEach(([x, z, r], i) => {
    const c = [x, sh.y(x, z) + r, z];
    s.add(cluster({ c, r, n: 34 + i * 4, k: 4, seed: o.seed + i, shell: 1 }), { hidden: "none" });
    s.curve(circle([x, sh.y(x, z) + 0.02, z], r * 1.25), {
      closed: true,
      dashed: true,
      hidden: "none",
    });
  });

  for (const [r, y] of [
    [2.2, 1.2],
    [3.6, 2.0],
    [5.2, 2.8],
  ]) {
    s.curve(circle([0, y, 0], r), { closed: true, dashed: true, hidden: "none" });
  }
  s.curve(circle([0, lipY, 0], 0.55), { closed: true, accent: true, hidden: "none" });
  s.dot([0, lipY, 0], { accent: true, hidden: "solid" });
  return s;
};
