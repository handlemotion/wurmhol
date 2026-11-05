// Many networks, one hole, seen from high above: a funnel with an instrument ring at the centre,
// a dotted polar ground, eight node globes on an orbit linked into the throat, and outer orbits
// past the frame.
import { scene } from "../scripts/engine.mjs";
import { arc, circle, cluster, line, sphere, throat, ticks } from "../scripts/prims.mjs";

export default (o) => {
  const s = scene({
    width: o.width,
    height: o.height,
    camera: { pitch: 58, yaw: 0, perspective: 30, fit: 0.98, zoom: 1.4 },
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
  });
  const t = throat({
    rs: 0.6,
    h: 2.2,
    rings: 10,
    meridians: 32,
    sheets: "upper",
    beads: 8,
    c: [0, -2.2, 0],
  });
  s.add(t, { hidden: "none" });
  const lip = t.radius(2.2);
  s.add(ticks([0, 0, 0], lip + 0.25, { count: 200, length: 0.3, every: 10 }), { hidden: "none" });
  s.curve(circle([0, 0, 0], lip + 0.25), { closed: true });

  // Polar ground: dotted rings and spokes, the quietest layer.
  for (let i = 1; i <= 6; i++)
    s.curve(circle([0, 0, 0], lip + 0.25 + i * 1.05), {
      closed: true,
      line: false,
      beadEvery: 0.32,
    });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r0 = lip + 0.9;
    s.curve(
      line([Math.cos(a) * r0, 0, Math.sin(a) * r0], [Math.cos(a) * 9.5, 0, Math.sin(a) * 9.5], 8),
      { line: false, beadEvery: 0.32 },
    );
  }

  const ORBIT = 5.6;
  s.curve(circle([0, 0, 0], ORBIT), { closed: true, dashed: true });
  const count = 8;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.2;
    const r = 0.55 + ((i * 5) % 4) * 0.1;
    const c = [Math.cos(a) * ORBIT, r, Math.sin(a) * ORBIT];
    const g = cluster({ c, r, n: 30 + (i % 3) * 6, k: 4, seed: o.seed + i, shell: 1 });
    s.add(g, { hidden: "none" });
    const toLip = [Math.cos(a) * (lip + 0.25), 0, Math.sin(a) * (lip + 0.25)];
    s.curve(arc(c, toLip, { bulge: 0.2 }), {
      beads: 10,
      accent: i === 2,
      arrows: i === 2 ? [0.6] : [],
    });
  }
  s.add(sphere({ r: 11, meridians: 6, parallels: 3, tilt: [20, 0, 70], beads: 44 }), {
    hidden: "none",
    occlude: false,
  });
  s.dot([0, -2.2, 0], { accent: true, hidden: "solid" });
  return s;
};
