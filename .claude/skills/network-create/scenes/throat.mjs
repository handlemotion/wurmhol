// The hero: a wormhole throat (Flamm's paraboloid) seen from above its rim. A node globe sits
// off each lip (the agent's container above, the human's browser below), and a single accent
// thread winds between them down the surface and through the throat, where the pivot sits.
import { scene } from "../scripts/engine.mjs";
import { cluster, throat } from "../scripts/prims.mjs";

const distance = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
const nearest = (nodes, p) =>
  nodes.reduce((best, q) => (distance(q, p) < distance(best, p) ? q : best));

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 16, yaw: 20, perspective: 24, fit: 0.84 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  const h = 3.2;
  const t = throat({ rs: 1, h, rings: 12, meridians: 32, beads: 13 });
  s.add(t, { hidden: "none" });

  const turn = (160 * Math.PI) / 180;
  const phi = (205 * Math.PI) / 180;
  const on = (y, a, out = 0) => [
    Math.cos(a) * (t.radius(y) + out),
    y,
    Math.sin(a) * (t.radius(y) + out),
  ];
  const a = cluster({ c: on(h + 0.9, phi, 1.3), r: 0.95, n: 44, k: 4, seed: o.seed, shell: 1 });
  const b = cluster({
    c: on(-h - 0.9, phi + turn, 1.3),
    r: 0.95,
    n: 44,
    k: 4,
    seed: o.seed + 7,
    shell: 1,
  });
  s.add(a, { hidden: "none" }).add(b, { hidden: "none" });

  const thread = [];
  for (let k = 0; k <= 240; k++) {
    const u = k / 240;
    thread.push(on(h - 2 * h * u, phi + turn * u, 0.004));
  }
  s.curve([nearest(a.nodes, thread[0]), thread[0]], { accent: true });
  s.curve(thread, { accent: true, arrows: [0.22, 0.8] });
  s.curve([thread[thread.length - 1], nearest(b.nodes, thread.at(-1))], { accent: true });
  s.dot(on(0, phi + turn / 2, 0.004), { accent: true, hidden: "solid" });
  return s;
};
