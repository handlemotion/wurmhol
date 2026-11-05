// The login backdrop: the Apollonian construction set wide, so its two limit points (the
// container, the browser) stand either side of the form and the link runs through it. No
// labels; it ships quiet, in `currentColor`, through `render.mjs --tsx`.
import { best, meet, PHI, plate } from "../../scripts/flat.mjs";

export default (o) =>
  best(
    (rnd) => {
      // Built landscape; a portrait frame gets the same drawing transposed, so the limit
      // points stand above and below the form instead.
      const portrait = o.height > o.width;
      const W = portrait ? o.height : o.width;
      const H = portrait ? o.width : o.height;
      const p = plate({
        width: W,
        height: H,
        style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper },
      });
      const u = Math.min(W, H) / 24;
      const y = H / 2;
      const cx = W / 2;
      const a = W * 0.3; // the limit points sit 30% of the long side either side of centre
      const L = [cx - a, y];
      const R = [cx + a, y];
      p.ray([0, y], [W, y]);
      p.line([L[0], 0], [L[0], H], { dashed: true }).line([R[0], 0], [R[0], H], { dashed: true });

      const through = [];
      for (const [k, dashed] of [
        [a / PHI ** 2, false],
        [-a / PHI, true],
        [a * PHI, true],
        [-a * PHI ** 2, false],
      ]) {
        const c = [cx, y + k];
        const r = Math.hypot(a, k);
        p.circle(c, r, { dashed });
        through.push({ c, r });
      }
      const around = [];
      for (const side of [-1, 1]) {
        [1.04, 1.16, 1.42].forEach((m, i) => {
          const d = a * m;
          const c = [cx + side * d, y];
          const r = Math.sqrt(d * d - a * a);
          p.circle(c, r, { dashed: i === 1 });
          around.push({ c, r });
        });
      }
      for (const { c, r } of around) {
        const [q0, q1] = meet.lineCircle([0, y], [W, y], c, r);
        p.node(c[0] < cx ? q0 : q1, { size: u * 0.32 });
      }
      for (const A of through) {
        for (const B of around) {
          for (const q of meet.circles(A.c, A.r, B.c, B.r))
            if (rnd() < 0.3) p.node(q, { size: u * 0.22, shape: "dot" });
        }
      }
      p.node(L, { size: u * 0.6 });
      p.node(R, { size: u * 0.6 });
      p.node([cx, y], { shape: "dot", size: u * 0.4, accent: true });
      return portrait ? p.transpose() : p;
    },
    { seed: o.seed, tries: 24 },
  );
