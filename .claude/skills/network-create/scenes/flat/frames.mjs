// Proportion as a tunnel: a golden rectangle divided into its squares, each square's quarter arc
// tracing the spiral, and projection rays from the outer corner converge on the smallest frame,
// where the pivot sits. The far end of the link is the same frame, small, linked across.
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
      // Outer golden rectangle, landscape, centred with a small offset.
      let h = H * (0.72 + rnd() * 0.1);
      let w = h * PHI;
      if (w > W * 0.86) {
        w = W * 0.86;
        h = w / PHI;
      }
      let x = (W - w) / 2 + (rnd() - 0.5) * u * 4;
      let y = (H - h) / 2;
      const outer = [x, y, w, h];
      p.frame(x, y, w, h);

      // Spiral subdivision: cut a square off the left, top, right, bottom in turn.
      const levels = 7;
      let last = null;
      for (let i = 0; i < levels; i++) {
        const side = Math.min(w, h);
        const dir = i % 4;
        let sq;
        if (dir === 0) {
          sq = [x, y, side, side];
          p.arc([x + side, y + side], side, Math.PI, Math.PI * 1.5, { dashed: true });
          x += side;
          w -= side;
        } else if (dir === 1) {
          sq = [x, y, side, side];
          p.arc([x, y + side], side, -Math.PI / 2, 0, { dashed: true });
          y += side;
          h -= side;
        } else if (dir === 2) {
          sq = [x + w - side, y, side, side];
          p.arc([x + w - side, y], side, 0, Math.PI / 2, { dashed: true });
          w -= side;
        } else {
          sq = [x, y + h - side, side, side];
          p.arc([x + side, y + h - side], side, Math.PI / 2, Math.PI, { dashed: true });
          h -= side;
        }
        p.frame(...sq);
        last = sq;
      }
      // The spiral's eye, exactly: where the outer rectangle's diagonal crosses the diagonal of
      // the remainder left after the first cut.
      const [X, Y, OW, OH] = outer;
      const eye = meet.lines([X, Y], [X + OW, Y + OH], [X + OW, Y], [X + OH, Y + OH]);
      p.line([X, Y], [X + OW, Y + OH], { dashed: true });
      // The first cut's section lines, carried edge to edge like a site plan's grid.
      p.ray([X + OH, Y], [X + OH, Y + OH], { dashed: true });
      p.ray([X, Y + OH - (OW - OH)], [X + OW, Y + OH - (OW - OH)], { dashed: true });
      p.line([X + OW, Y], [X + OH, Y + OH], { dashed: true });
      const corners = (r) => [
        [r[0], r[1]],
        [r[0] + r[2], r[1]],
        [r[0] + r[2], r[1] + r[3]],
        [r[0], r[1] + r[3]],
      ];
      const origin = [outer[0], outer[1]];
      p.fan(origin, corners(last).slice(1));
      p.node(origin, { size: u * 0.6 });
      p.node(eye, { size: u * 0.5, accent: true });

      // Nodes on the frame's divisions, a few, sized from the module.
      for (const q of corners(last)) if (rnd() < 0.5) p.node(q, { size: u * 0.3 });
      const ox = outer[0] + outer[2];
      p.line([ox, outer[1] + outer[3]], [W, outer[1] + outer[3]]);
      p.line([0, outer[1] + outer[3] / PHI], [outer[0], outer[1] + outer[3] / PHI]);
      p.node([outer[0] - u * 2.2, outer[1] + outer[3] / PHI], { size: u * 0.9 });
      p.label([outer[0] + u * 0.8, outer[1] + outer[3] - u * 1.2], "a7f3.wurmhol.dev", {
        tag: true,
      });
      return p;
    },
    { seed: o.seed, tries: 24 },
  );
