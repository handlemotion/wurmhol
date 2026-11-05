// Many networks, one hole: node globes on an orbit, each linked by a beaded arc to a ring
// (the throat seen edge-on) that holds the pivot.
import { scene } from "../scripts/engine.mjs";
import { arc, circle, cluster } from "../scripts/prims.mjs";

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 24, yaw: 8, perspective: 22, fit: 0.88 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  for (let i = 0; i < 4; i++) s.curve(circle([0, 0, 0], 0.5 + i * 0.22), { closed: true });
  s.curve(circle([0, 0, 0], 4.6), { closed: true, dashed: true });
  const count = 7;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.3;
    const c = [Math.cos(a) * 4.6, 0, Math.sin(a) * 4.6];
    const r = 0.55 + ((i * 37) % 5) * 0.08;
    const g = cluster({ c, r, n: 26 + (i % 3) * 6, k: 4, seed: o.seed + i, shell: 1 });
    s.add(g);
    const lip = [Math.cos(a) * 1.16, 0, Math.sin(a) * 1.16];
    s.curve(arc(g.nodes[0], lip, { bulge: 0.18 }), {
      beads: 9,
      line: i % 2 === 0,
      arrows: i % 2 ? [] : [0.55],
    });
  }
  s.dot([0, 0, 0], { accent: true });
  return s;
};
