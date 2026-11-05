// Spacetime as a network: a grid of links whose every crossing is a node, pulled down into a
// well that ends at the throat. Hidden links drop out, so the depth reads from the sheet alone.
import { scene } from "../scripts/engine.mjs";
import { circle, sheet } from "../scripts/prims.mjs";

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 42, yaw: 30, perspective: 16, fit: 0.92 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  const sh = sheet({ size: 9, n: 29, depth: 3.2, w: 1.0, cut: 0.45 });
  s.add(sh, { hidden: "none" });
  s.curve(circle([0, sh.y(0.45, 0), 0], 0.45), { closed: true, accent: true, hidden: "none" });
  s.dot([0, sh.y(0.45, 0), 0], { accent: true, hidden: "solid" });
  return s;
};
