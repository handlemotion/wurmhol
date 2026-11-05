// The hole, flat: Apollonian circles. Two limit points on one axis are the two ends of the
// link (the agent's container, the human's browser). One family of circles passes through
// both points; the other closes around each. The families cross at right angles everywhere,
// and every node sits on one of those exact crossings.
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
      const u = Math.min(W, H) / 24; // the module: node sizes and gaps come from it
      const y = H / 2;
      const cx = W / 2 + (rnd() - 0.5) * W * 0.1;
      const a = H / 2 / PHI; // half the distance between the limit points
      const L = [cx - a, y];
      const R = [cx + a, y];

      p.ray([0, y], [W, y]);
      p.line([L[0], 0], [L[0], H], { dashed: true });
      p.line([R[0], 0], [R[0], H], { dashed: true });

      // Through both points: centres on the perpendicular bisector at heights from a φ scale.
      const through = [];
      for (const [k, dashed] of [
        [a / PHI, false],
        [-a * PHI, true],
        [a * PHI ** 2, true],
      ]) {
        const c = [cx, y + k * (rnd() < 0.5 ? 1 : -1)];
        const r = Math.hypot(a, k);
        p.circle(c, r, { dashed });
        through.push({ c, r });
      }
      // Around each point: centre at distance d from the midpoint, r = √(d² − a²).
      const around = [];
      for (const side of [-1, 1]) {
        const steps = [1.08, 1.4, 2.2].slice(0, 2 + Math.floor(rnd() * 2));
        steps.forEach((m, i) => {
          const d = a * m;
          const c = [cx + side * d, y];
          const r = Math.sqrt(d * d - a * a);
          p.circle(c, r, { dashed: i === steps.length - 1 && side === 1 });
          around.push({ c, r });
        });
      }

      // Nodes where the axis leaves each closing circle on its outer side.
      for (const { c, r } of around) {
        const [q0, q1] = meet.lineCircle([0, y], [W, y], c, r);
        p.node(c[0] < cx ? q0 : q1, { size: u * 0.5 });
      }
      // And a few of the right-angle crossings between the families.
      for (const A of through) {
        for (const B of around) {
          for (const q of meet.circles(A.c, A.r, B.c, B.r))
            if (rnd() < 0.22) p.node(q, { size: u * 0.4, shape: "dot" });
        }
      }
      p.node(L, { size: u * 1.1 });
      p.node(R, { size: u * 0.7, accent: true });
      p.label([L[0] + u * 0.9, L[1] - u * 1.3], "container :5173", { tag: true });
      p.label([R[0] + u * 0.7, R[1] + u * 1.3], "browser", { tag: true, accent: true });
      return p;
    },
    { seed: o.seed },
  );
