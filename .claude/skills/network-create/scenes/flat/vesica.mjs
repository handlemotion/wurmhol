// A vesica chain: four equal circles on one axis, each through its neighbour's centre, so
// every lens stands √3·r tall. The middle lens is the link; its chord carries the accent, and
// nodes mark every centre and every lens tip.
import { best, meet, plate } from "../../scripts/flat.mjs";

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
      const r = H * (0.3 + rnd() * 0.04);
      const cx = W / 2;
      const centres = [-1.5, -0.5, 0.5, 1.5].map((k) => [cx + k * r, y]);
      p.ray([0, y], [W, y]);
      centres.forEach((c, i) => p.circle(c, r, { dashed: i === 0 || i === 3 }));
      p.circle([cx, y], r * 2, { dashed: true });
      p.circle([cx, y], (r * Math.sqrt(3)) / 2);

      for (let i = 0; i < 3; i++) {
        const tips = meet.circles(centres[i], r, centres[i + 1], r);
        const middle = i === 1;
        p.line([tips[0][0], 0], [tips[0][0], H], { dashed: !middle });
        p.line(tips[0], tips[1], { accent: middle });
        for (const q of tips) p.node(q, { size: u * (middle ? 0.5 : 0.35) });
      }
      // The diamond of the middle lens: centres to tips.
      const [t0, t1] = meet.circles(centres[1], r, centres[2], r);
      for (const c of [centres[1], centres[2]]) p.line(c, t0).line(c, t1);
      centres.forEach((c, i) => p.node(c, { size: u * (i === 1 || i === 2 ? 0.7 : 0.45) }));
      p.node([cx, y], { shape: "dot", size: u * 0.55, accent: true });
      p.label([centres[0][0] - r * 0.5, y + r * 0.62], "agent", { tag: true });
      p.label([centres[3][0] + r * 0.12, y - r * 0.62], "human", { tag: true });
      return p;
    },
    { seed: o.seed, tries: 8 },
  );
