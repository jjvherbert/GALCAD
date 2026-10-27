// Do esboço resolvido (2D) para arestas, contornos e faces OCC no plano do esboço,
// mantendo a ligação de cada aresta à entidade do esboço que a gerou.
import { addHolesInFace, assembleWire, makeBezierCurve, makeCircle, makeFace, makeLine, makeThreePointArc, type Edge, type Face, type Wire } from "replicad";
import type { Seg, Region, Chain } from "../sketch/profiles.ts";
import { segSample } from "../sketch/profiles.ts";
import type { P2 } from "../sketch/geometry.ts";
import { type Frame, to2D, to3D } from "./frame.ts";
import { T, edgeProps, explore, type TopoDS_Edge, type TopoDS_Shape } from "./occ.ts";

export function segEdges(s: Seg, f: Frame): Edge[] {
  const P = (p: P2) => to3D(f, p);
  switch (s.kind) {
    case "line": return [makeLine(P(s.a), P(s.b))];
    case "arc": {
      // ponto intermédio no sentido do arco (from → to)
      const pts = segSample(s);
      return [makeThreePointArc(P(s.from), P(pts[Math.floor(pts.length / 2)]), P(s.to))];
    }
    case "circle": return [makeCircle(s.r, P(s.c), f.z)];
    case "spline": return s.beziers.map((b) => makeBezierCurve(b.map(P)));
  }
}

export function loopWire(segs: Seg[], f: Frame): Wire {
  const edges = segs.flatMap((s) => segEdges(s, f));
  return assembleWire(edges);
}

/** Face plana de uma região (contorno exterior + furos). */
export function regionFace(r: Region, f: Frame): Face {
  const outer = loopWire(r.outer.segs, f);
  const holes = r.holes.map((h) => loopWire(h.segs, f));
  // os furos têm de ter orientação oposta à do contorno exterior: o ShapeFix_Face corrige-a
  const face = holes.length ? addHolesInFace(T(makeFace(outer)), holes) : makeFace(outer);
  T(face);
  return face;
}

export function chainWire(c: Chain, f: Frame): Wire {
  return loopWire(c.segs, f);
}

/** Mapa aresta → entidade do esboço, por proximidade geométrica do ponto médio da aresta. */
export function mapEdgesToEntities(shape: TopoDS_Shape, segs: Seg[], f: Frame): Map<TopoDS_Edge, string> {
  const polys = segs.map((s) => ({ entity: s.entity, poly: segSample(s) }));
  const out = new Map<TopoDS_Edge, string>();
  for (const e of explore(shape, "edge")) {
    const m = to2D(f, edgeProps(e).mid);
    let best = "", bestD = Infinity;
    for (const { entity, poly } of polys) {
      for (let i = 0; i < poly.length - 1; i++) {
        const d = distToSegment(m, poly[i], poly[i + 1]);
        if (d < bestD) { bestD = d; best = entity; }
      }
    }
    if (best) out.set(e, best);
  }
  return out;
}

function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
