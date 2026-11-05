// The link as a corridor, in one-point perspective: frames shrink by 1/φ toward a vanishing
// point, rays run from it through every corner past the frame, and floor lines and ceiling beams
// fan out on a modular step. The near frame is the browser, the far one the dev server; the pivot is the
// vanishing point itself.
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
      const vp = [W * (0.5 + (rnd() - 0.5) * 0.08), H * (0.5 + (rnd() - 0.5) * 0.12)];
      const outer = [-W * 0.04, -H * 0.06, W * 1.08, H * 1.12];
      const at = (rect, s) => [
        vp[0] + (rect[0] - vp[0]) * s,
        vp[1] + (rect[1] - vp[1]) * s,
        rect[2] * s,
        rect[3] * s,
      ];
      const corners = (r) => [
        [r[0], r[1]],
        [r[0] + r[2], r[1]],
        [r[0] + r[2], r[1] + r[3]],
        [r[0], r[1] + r[3]],
      ];

      for (const q of corners(outer)) p.line(vp, q);
      const frames = [];
      for (let k = 1; k <= 7; k++) {
        const f = at(outer, PHI ** -k);
        p.frame(...f, { dashed: k % 2 === 0 });
        frames.push(f);
      }
      // Floor lines on a modular step, from the third frame's floor out past the frame, so the
      // vanishing point stays clear.
      const floor = outer[1] + outer[3];
      const from = frames[2][1] + frames[2][3];
      const t = (from - vp[1]) / (floor - vp[1]);
      for (let i = -6; i <= 6; i++) {
        if (!i) continue;
        const q = [vp[0] + i * u * 3.2, floor];
        p.line([vp[0] + (q[0] - vp[0]) * t, from], q, { dashed: true });
      }
      // Ceiling beams: solid, on the coarser double step.
      const ceil = outer[1];
      const top = frames[2][1];
      const tc = (top - vp[1]) / (ceil - vp[1]);
      for (let i = -3; i <= 3; i++) {
        if (!i) continue;
        const q = [vp[0] + i * u * 6.4, ceil];
        p.line([vp[0] + (q[0] - vp[0]) * tc, top], q);
      }

      const near = frames[0];
      const far = frames[3];
      for (const q of corners(near)) p.node(q, { size: u * 0.6 });
      for (const q of corners(far)) p.node(q, { size: u * 0.6 * PHI ** -3 * 2 });
      p.node(vp, { shape: "dot", size: u * 0.5, accent: true });
      p.label([near[0] + u * 0.8, near[1] + u * 1.1], "a7f3.wurmhol.dev", { tag: true });
      p.label([far[0] + far[2] + u * 0.5, far[1] + far[3] / 2], "localhost:5173", { tag: true });
      return p;
    },
    { seed: o.seed, tries: 16 },
  );
