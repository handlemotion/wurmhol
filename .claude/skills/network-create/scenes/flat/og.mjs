// The link preview (og:image) for the marketing site, 1200x630. Common tangents between two
// places: a large circle on the left (the browser), which is a hole holding the wordmark and
// headline, and a small one on the right (the container). Their inner tangents cross at the
// internal centre of similitude, the pivot, tagged with a pipe host; the outer pair meets at the
// external centre on the right. Every tangent only touches the browser's rim, so the copy sits
// in the drawing with nothing crossing it. apps/site/scripts/og.mjs rasterizes it with Inter.
import { best, meet, PHI, plate } from "../../scripts/flat.mjs";

// The copy inside the browser circle.
const COPY = [
  { text: "Wurmhol", size: 30 },
  { text: "A private URL for your", size: 30 },
  { text: "agent's dev server.", size: 30 },
];

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
      const R = H * 0.375;
      const r = R / PHI ** 2;
      const big = [R + u * (2.2 + rnd() * 1.2), y];
      const small = [big[0] + R * (1.85 + rnd() * 0.35), y];

      p.hole({ c: big, r: R });
      p.text(big, COPY, { pad: u * 0.5, gap: 0.3 });

      p.ray([0, y], [W, y]);
      p.circle(small, r);
      p.circle(small, r * PHI, { dashed: true });
      p.circle(big, R * PHI, { dashed: true });
      p.circle(small, r * PHI ** 2, { dashed: true });

      const I = [(R * small[0] + r * big[0]) / (R + r), y];
      const E = [(R * small[0] - r * big[0]) / (R - r), y];
      for (const [centre, inner] of [
        [I, true],
        [E, false],
      ]) {
        for (const t of meet.tangents(centre, big, R)) {
          p.ray(centre, t, { dashed: !inner });
          p.node(t, { size: u * 0.4 });
        }
        for (const t of meet.tangents(centre, small, r)) p.node(t, { size: u * 0.3 });
      }
      p.line([I[0], 0], [I[0], H], { dashed: true });
      // The axis meets the browser's rim on both sides.
      p.node([big[0] - R, y], { size: u * 0.35 });
      p.node([big[0] + R, y], { size: u * 0.35 });
      p.node(small, { size: u * 0.6 });
      if (E[0] > 0 && E[0] < W) p.node(E, { size: u * 0.5 });
      p.node(I, { shape: "dot", size: u * 0.55, accent: true });
      p.label([big[0] + R * 0.55, y - R - u * 0.9], "browser", { tag: true });
      p.label([small[0] - r, y + r * PHI + u * 1.4], "container", { tag: true });
      p.label([I[0] + u * 0.6, y - u * 1.6], "k3x9p2m7qa.wurmhol.dev", {
        tag: true,
        accent: true,
      });
      return p;
    },
    { seed: o.seed, tries: 48 },
  );
