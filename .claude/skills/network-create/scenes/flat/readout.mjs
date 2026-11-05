// The link as a live readout: tagged nodes on a modular grid, joined by straight edges that
// cross, with construction crosses at grid points and one circle around the hub.
import { connect } from "../../scripts/prims.mjs";
import { best, plate } from "../../scripts/flat.mjs";

const TAGS = [":5173", "relay", "200 OK", "edge", "tls 1.3", "12 ms", "a7f3.wurmhol.dev", ":3000"];

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
      const cols = 16;
      const u = W / cols;
      const rows = Math.round(H / u);
      // Construction crosses on every other grid point.
      for (let i = 2; i < cols; i += 2) {
        for (let j = 2; j < rows; j += 2) {
          const x = i * u;
          const y = j * u;
          p.line([x - 4, y], [x + 4, y]).line([x, y - 4], [x, y + 4]);
        }
      }
      // Nodes snap to grid points in the middle two thirds.
      const nodes = [];
      for (let guard = 0; nodes.length < TAGS.length && guard < 5000; guard++) {
        const q = [
          u * (3 + Math.floor(rnd() * (cols - 8))),
          u * (2 + Math.floor(rnd() * (rows - 4))),
        ];
        if (nodes.every((n) => Math.hypot(n[0] - q[0], n[1] - q[1]) > u * 2.1)) nodes.push(q);
      }
      const as3 = nodes.map((n) => [n[0], n[1], 0]);
      const edges = connect(as3, 1);
      if (nodes.length === TAGS.length) edges.push([0, 3], [1, 5]);
      const hub = 2;
      for (const [i, j] of edges) p.line(nodes[i], nodes[j], { accent: i === hub || j === hub });
      p.circle(nodes[hub], u * 2.6, { dashed: true });
      p.ray([0, nodes[hub][1]], [W, nodes[hub][1]], { dashed: true });
      p.ray([nodes[hub][0], 0], [nodes[hub][0], H], { dashed: true });
      nodes.forEach((n, i) => p.label(n, TAGS[i], { tag: true, accent: i === hub }));
      return p;
    },
    { seed: o.seed, tries: 64 },
  );
