// A technical plate: a tilted globe of beaded meridians whose pole opens into the hole, a
// hatched instrument ring around it, outer orbits past the frame, and a card over the front.
import { scene } from "../scripts/engine.mjs";
import { circle, sphere, ticks } from "../scripts/prims.mjs";

export default (o) => {
  const W = o.width;
  const H = o.height;
  const s = scene({
    width: W,
    height: H,
    camera: { pitch: 0, yaw: 0, fit: 0.98, zoom: 1.25 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper },
  });
  const tilt = [-28, 0, -14];
  s.add(sphere({ r: 3, meridians: 14, parallels: 9, tilt, hole: 26, beads: 16 }), {
    hidden: "none",
  });
  s.add(ticks([0, 0, 0], 3.18, { n: [0, 0, 1], count: 220, length: 0.28 }), { hidden: "solid" });
  s.curve(circle([0, 0, 0], 3.18, [0, 0, 1]), { closed: true, hidden: "solid" });
  // Outer orbits, past the frame, so the plate reads as part of something larger.
  s.add(sphere({ r: 5.4, meridians: 6, parallels: 4, tilt: [52, 30, 8], beads: 30 }), {
    hidden: "none",
    occlude: false,
  });
  const pw = W * 0.38;
  const ph = H * 0.2;
  s.panel(W * 0.27, H * 0.43, pw, ph);
  return s;
};
