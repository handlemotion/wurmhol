// The link preview (og:image) for the marketing site, 1200x630. The wordmark and headline sit in
// a void on the left; the drawing is the common-tangents construction on the right: a small
// circle (the container) and a large one (the browser), whose inner tangents cross at the
// internal centre of similitude, the pivot, tagged with a pipe host. The outer tangents run left
// to the external centre and past the text, so the plate fills its frame around the void.
// apps/site/scripts/og.mjs renders it with the text to apps/site/public/og.png.
import { best, meet, PHI, plate } from "../../scripts/flat.mjs";

// The text column, in plate coordinates: apps/site/scripts/og.mjs places the text inside it.
export const TEXT = { x: 72, y: 222, w: 360, h: 186 };

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
      const r2 = H * (0.27 + rnd() * 0.05);
      const r1 = r2 / PHI ** 2;
      const c2 = [W - r2 * (0.95 + rnd() * 0.2), y];
      const c1 = [c2[0] - r2 * (1.55 + rnd() * 0.25), y];
      p.void(TEXT.x - u, TEXT.y - u, TEXT.w + 2 * u, TEXT.h + 2 * u);

      p.ray([0, y], [W, y]);
      p.circle(c1, r1);
      p.circle(c2, r2);
      p.circle(c2, r2 / PHI);
      p.circle(c1, r1 * PHI, { dashed: true });
      p.circle(c2, r2 * PHI, { dashed: true });
      p.circle(c2, r2 * PHI ** 2, { dashed: true });

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
      // Where the browser's φ ring crosses the axis, on the container's side.
      p.node([c2[0] - r2 * PHI, y], { size: u * 0.35 });
      p.node(c1, { size: u * 0.5 });
      p.node(c2, { size: u * 0.9 });
      if (E[0] > 0 && E[0] < W) p.node(E, { size: u * 0.5 });
      p.node(I, { shape: "dot", size: u * 0.55, accent: true });
      p.label([c1[0] - r1 * PHI, y + r1 * PHI + u * 1.4], "container", { tag: true });
      p.label([c2[0] - u * 0.5, y - r2 - u * 0.9], "browser", { tag: true });
      p.label([I[0] + u * 0.6, y + u * 1.6], "k3x9p2m7qa.wurmhol.dev", {
        tag: true,
        accent: true,
      });
      return p;
    },
    { seed: o.seed, tries: 48 },
  );
