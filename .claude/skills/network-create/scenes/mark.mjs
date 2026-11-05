// The mark: the throat seen from outside (a ring tilted into an ellipse), four nodes on it, the
// two crossing links that join them through the hole, and the pivot where they meet. A heavier
// stroke so it holds at 16px.
import { scene } from "../scripts/engine.mjs";
import { circle } from "../scripts/prims.mjs";

const at = (deg) => [Math.cos((deg * Math.PI) / 180), 0, Math.sin((deg * Math.PI) / 180)];

export default (o) => {
  const s = scene({
    width: 256,
    height: 256,
    camera: { pitch: 58, yaw: 0, fit: 0.78 },
    style: { ink: o.ink, accent: o.accent, stroke: 12, dot: 18, accentDot: 18 },
  });
  s.curve(circle([0, 0, 0], 1, [0, 1, 0]), { closed: true });
  const nodes = [45, 135, 225, 315].map(at);
  s.curve([nodes[0], nodes[2]]);
  s.curve([nodes[1], nodes[3]]);
  for (const p of nodes) s.dot(p);
  s.dot([0, 0, 0], { accent: true });
  return s;
};
