// Confocal conics: every ellipse and hyperbola sharing two foci, the two places. Ellipses are
// the paths whose summed distance to both is fixed; hyperbolas cross them at right angles. The
// net's crossings are exact (elliptic coordinates μ, ν), and the foci are measured off below.
import { best, plate } from "../../scripts/flat.mjs";

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
      const c = W * (0.16 + rnd() * 0.05);
      const O = [W / 2, H / 2];
      const angle = (rnd() - 0.5) * 0.12;
      const at = (mu, nu) => {
        const x = c * Math.cosh(mu) * Math.cos(nu);
        const y = c * Math.sinh(mu) * Math.sin(nu);
        return [
          O[0] + x * Math.cos(angle) - y * Math.sin(angle),
          O[1] + x * Math.sin(angle) + y * Math.cos(angle),
        ];
      };
      const mus = [0.35, 0.62, 0.95, 1.35, 1.8];
      const nus = Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2 + Math.PI / 12);
      mus.forEach((mu, i) =>
        p.ellipse(O, c * Math.cosh(mu), c * Math.sinh(mu), angle, { dashed: i % 2 === 1 }),
      );
      for (const nu of nus) {
        const pts = [];
        for (let k = 0; k <= 120; k++) pts.push(at((k / 120) * 2.4, nu));
        p.poly(pts, { dashed: true });
      }
      const F1 = at(0, Math.PI);
      const F2 = at(0, 0);
      p.ray(F1, F2);
      p.line(F1, F2, { accent: true });
      // Nodes on a sparse, seeded subset of the net's crossings.
      for (const mu of mus.slice(0, 4)) {
        for (const nu of nus) if (rnd() < 0.3) p.node(at(mu, nu), { size: u * 0.28 });
      }
      p.node(F1, { size: u * 0.7 });
      p.node(F2, { size: u * 0.7 });
      p.node(O, { shape: "dot", size: u * 0.45, accent: true });
      p.dimension([F1[0], F1[1] + c * 0.9], [F2[0], F2[1] + c * 0.9], "2c", { off: 0 });
      p.label([F1[0] - u * 0.6, F1[1] - u * 1.1], "container", { tag: true, anchor: "start" });
      p.label([F2[0] + u * 0.6, F2[1] + u * 1.1], "browser", { tag: true });
      return p;
    },
    { seed: o.seed, tries: 16 },
  );
