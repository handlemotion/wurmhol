// A system diagram: two places drawn as circles inside a larger one that runs off the frame,
// the request's loop as the accent arc with arrowheads, and plain mono labels for each step,
// linked by thin arrows. The pivot is where the loop crosses the axis between the places.
import { best, PHI, plate } from "../../scripts/flat.mjs";

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
      const c = [W * (0.5 + (rnd() - 0.5) * 0.08), H / 2];
      const R = H * 0.62;
      p.circle(c, R);
      p.circle([c[0] + R * 0.18, c[1]], R * PHI * 0.8, { dashed: true });
      const r = R / PHI / 1.15;
      const A = [c[0] - r * 0.95, c[1]];
      const B = [c[0] + r * 0.95, c[1]];
      p.circle(A, r * 0.82);
      p.circle(B, r * 0.82);
      p.line([c[0], 0], [c[0], H], { dashed: true });

      const loop = R * 0.8;
      p.arc(c, loop, -Math.PI * 0.42, Math.PI * 1.32, { accent: true, arrows: [0.18, 0.5, 0.82] });
      p.node([c[0], c[1] + loop], { shape: "dot", size: u * 0.5, accent: true });

      const steps = [
        ["agent", [A[0] - r * 0.3, A[1] - r * 0.35]],
        ["dev server :5173", [A[0] - r * 0.3, A[1] + r * 0.15]],
        ["wurmhol", [A[0] + r * 0.25, A[1] + r * 0.5]],
        ["relay", [c[0] + u * 0.4, c[1] - r * 0.05]],
        ["browser", [B[0] + r * 0.1, B[1] - r * 0.3]],
        ["human", [B[0] + r * 0.1, B[1] + r * 0.3]],
      ];
      for (let i = 1; i < steps.length; i++) p.line(steps[i - 1][1], steps[i][1], { arrow: 0.94 });
      for (const [text, q] of steps) {
        p.node(q, { size: u * 0.28 });
        p.label([q[0] + u * 0.4, q[1] - u * 0.45], text);
      }
      p.label([A[0] - r * 0.45, A[1] - r * 0.95], "container");
      p.label([B[0] - r * 0.1, B[1] - r * 0.95], "browser tab");
      return p;
    },
    { seed: o.seed, tries: 8 },
  );
