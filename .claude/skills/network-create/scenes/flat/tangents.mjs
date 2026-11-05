// Two places, two sizes: a small circle (the container) and a large one (the browser), joined
// by their four common tangents. The inner pair crosses at the internal centre of similitude,
// the exact point that maps one circle onto the other: the pivot. The outer pair meets at the
// external centre, off to the side, where the construction closes.
import { best, meet, PHI, plate } from "../../scripts/flat.mjs";

export default (o) =>
  best(
    (rnd) => {
      const W = o.width;
      const H = o.height;
      const p = plate({
        width: W,
        height: H,
        style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper },
      });
      const u = Math.min(W, H) / 24;
      const y = H / 2;
      const r2 = H * (0.26 + rnd() * 0.06);
      const r1 = r2 / PHI ** 2;
      const gap = r2 * (1.15 + rnd() * 0.3);
      const c1 = [W / 2 - gap - r1 * 0.2, y];
      const c2 = [W / 2 + gap * 0.55, y];
      p.ray([0, y], [W, y]);
      p.circle(c1, r1);
      p.circle(c2, r2);
      // Modular rings: each circle echoed at φ steps, dashed.
      p.circle(c1, r1 * PHI, { dashed: true });
      p.circle(c2, r2 * PHI, { dashed: true });
      p.circle(c2, r2 / PHI);

      const I = [(r2 * c1[0] + r1 * c2[0]) / (r1 + r2), y];
      const E = [(r1 * c2[0] - r2 * c1[0]) / (r1 - r2), y];
      for (const [centre, inner] of [
        [I, true],
        [E, false],
      ]) {
        for (const t of meet.tangents(centre, c2, r2)) {
          p.ray(centre, t, { dashed: !inner });
          p.node(t, { size: u * 0.4 });
        }
        for (const t of meet.tangents(centre, c1, r1)) p.node(t, { size: u * 0.3 });
      }
      p.line([I[0], 0], [I[0], H], { dashed: true });
      p.node(c1, { size: u * 0.5 });
      p.node(c2, { size: u * 0.9 });
      if (E[0] > 0 && E[0] < W) p.node(E, { size: u * 0.5 });
      p.node(I, { shape: "dot", size: u * 0.55, accent: true });
      p.label([c1[0] - r1, c1[1] + r1 * PHI + u * 1.2], "container", { tag: true });
      p.label([c2[0] + u * 0.9, c2[1] - u * 1.2], "browser", { tag: true });
      return p;
    },
    { seed: o.seed, tries: 32 },
  );
