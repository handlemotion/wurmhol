// The hero plate: the throat (Flamm's paraboloid) at the centre, an instrument ring on each lip,
// two orbits of node globes feeding it (the agents' side above, the humans' below), and outer
// orbits that run past the frame. One accent thread crosses through the throat.
import { scene } from "../scripts/engine.mjs";
import { arc, circle, cluster, sphere, throat, ticks } from "../scripts/prims.mjs";

const H = 3;
const ORBIT = 6.4;

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 24, yaw: 15, perspective: 34, fit: 0.98, zoom: 1.55 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  const t = throat({ rs: 1.1, h: H, rings: 12, meridians: 36, beads: 11 });
  s.add(t, { hidden: "none" });
  const lip = t.radius(H);

  for (const y of [H, -H]) {
    s.add(ticks([0, y, 0], lip + 0.3, { count: 240, length: 0.32, every: 10 }), { hidden: "none" });
    s.curve(circle([0, y, 0], lip + 0.3), { closed: true, hidden: "none" });
    s.curve(circle([0, y, 0], ORBIT), { closed: true, dashed: true, hidden: "none" });
    s.curve(circle([0, y * 1.25, 0], ORBIT + 1.6), { closed: true, line: false, beads: 120 });
  }

  // Two orbits of globes, offset half a step so the plate balances left to right.
  const globes = [];
  for (const [side, y] of [
    [0, H],
    [1, -H],
  ]) {
    for (let i = 0; i < 5; i++) {
      const a = ((i + side * 0.5) / 5) * Math.PI * 2 + 0.35;
      const c = [Math.cos(a) * ORBIT, y, Math.sin(a) * ORBIT];
      const r = 0.6 + ((i * 3 + side) % 4) * 0.09;
      const g = cluster({
        c,
        r,
        n: 34 + (i % 3) * 6,
        k: 4,
        seed: o.seed + i + side * 11,
        shell: 1,
      });
      s.add(g, { hidden: "none" });
      globes.push({ g, a, y });
      const toLip = [Math.cos(a) * (lip + 0.3), y, Math.sin(a) * (lip + 0.3)];
      s.curve(arc(c, toLip, { bulge: 0.12, up: [0, Math.sign(y), 0] }), {
        line: false,
        beads: 14,
        hidden: "none",
      });
    }
  }

  // Outer orbits: larger than the frame, so the plate reads as part of a bigger system.
  s.add(sphere({ r: 10, meridians: 5, parallels: 3, tilt: [64, 25, 12], beads: 40 }), {
    hidden: "none",
    occlude: false,
  });

  // The thread: from an upper globe, down the surface through the throat, out to a lower one.
  const from = globes[1];
  const to = globes[8];
  const turn = to.a - from.a + Math.PI * 2 * (to.a < from.a ? 1 : 0);
  const on = (y, a) => [
    Math.cos(a) * (t.radius(y) + 0.004),
    y,
    Math.sin(a) * (t.radius(y) + 0.004),
  ];
  const thread = [];
  for (let k = 0; k <= 240; k++) thread.push(on(H - 2 * H * (k / 240), from.a + turn * (k / 240)));
  s.curve(thread, { accent: true, hidden: "dash", arrows: [0.3, 0.72] });
  s.dot(on(0, from.a + turn / 2), { accent: true, hidden: "solid" });
  return s;
};
