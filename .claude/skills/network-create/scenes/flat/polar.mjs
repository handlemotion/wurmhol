// A routing instrument: a polar grid of rings on a √2 scale and spokes every 15°, a hatched
// bezel, and two routes that hop between grid crossings from the rim into the centre, the hole.
// Only crossings carry nodes; the rings and spokes are the grid they snap to.
import { best, plate, SQRT2 } from "../../scripts/flat.mjs";

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
      const c = [W / 2, H / 2];
      const Rmax = H * 0.62;
      const rings = Array.from({ length: 6 }, (_, i) => Rmax / SQRT2 ** i);
      rings.forEach((r, i) => p.circle(c, r, { dashed: i % 2 === 1 }));
      p.ticks(c, rings[1], { count: 240, length: u * 0.22, every: 10 });
      for (let k = 0; k < 24; k++) {
        const t = (k / 24) * Math.PI * 2;
        const r0 = rings[5];
        p.line(
          [c[0] + r0 * Math.cos(t), c[1] + r0 * Math.sin(t)],
          [c[0] + Rmax * 1.4 * Math.cos(t), c[1] + Rmax * 1.4 * Math.sin(t)],
          { dashed: k % 6 !== 0 },
        );
      }
      for (const [deg, text] of [
        [0, "0°"],
        [90, "90°"],
        [180, "180°"],
        [270, "270°"],
      ]) {
        const t = (deg * Math.PI) / 180;
        const r = rings[1] + u * 1.2;
        p.label([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)], text, { anchor: "middle" });
      }
      // Two routes: from the rim inward, one ring at a time, turning a seeded number of spokes.
      const at = (ring, spoke) => {
        const t = (spoke / 24) * Math.PI * 2;
        return [c[0] + rings[ring] * Math.cos(t), c[1] + rings[ring] * Math.sin(t)];
      };
      for (const start of [Math.floor(rnd() * 6) + 2, Math.floor(rnd() * 6) + 14]) {
        let spoke = start;
        const route = [at(1, spoke)];
        for (let ring = 2; ring <= 5; ring++) {
          spoke += Math.floor(rnd() * 5) - 2;
          route.push(at(ring - 1, spoke), at(ring, spoke));
        }
        route.push(c);
        p.poly(route);
        route.slice(0, -1).forEach((q, i) => p.node(q, { size: u * (i === 0 ? 0.6 : 0.3) }));
      }
      p.node(c, { shape: "dot", size: u * 0.55, accent: true });
      return p;
    },
    { seed: o.seed, tries: 16 },
  );
