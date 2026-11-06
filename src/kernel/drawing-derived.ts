// Desenhos: vistas derivadas da vista-mãe — corte, pormenor e vista auxiliar.
import { cast } from "replicad";
import { type DrawingView } from "../doc/project.ts";
import { type Vec3 } from "../doc/types.ts";
import { type Curve2D, type ViewFrame, type ViewResult } from "./protocol.ts";
import { T, explore, gpPnt, oc, v3, volume } from "./occ.ts";
import { clipCurvesCircle, curvePoints, dist } from "../drawing/geom2d.ts";
import { type P, type Source, unproj } from "./drawing-common.ts";
import { viewFromShape } from "./drawing-view.ts";

/** Corte: a linha a→b da vista-mãe e a direção de vista da mãe definem o plano de corte. */
export function sectionView(src: Source, P: ViewFrame, v: Extract<DrawingView, { kind: "section" }>, scale: number): ViewResult {
  const A = unproj(P, v.a), B = unproj(P, v.b);
  const u = v3.norm(v3.sub(B, A));
  if (v3.dist(A, B) < 1e-9) throw new Error("Linha de corte degenerada");
  let z = v3.norm(v3.cross(u, P.z)); // normal do plano de corte: perpendicular à linha e à direção de vista
  if (v.flip) z = v3.mul(z, -1);
  const x = v.flip ? v3.mul(u, -1) : u;
  const f: ViewFrame = { o: P.o, x, y: v3.cross(z, x), z };
  // fica a parte do lado oposto ao observador
  const o = oc();
  const bb = cast(src.shape).boundingBox;
  const far = Math.max(1000, v3.dist(bb.bounds[0] as Vec3, bb.bounds[1] as Vec3) * 4);
  const planeFace = T(T(new o.BRepBuilderAPI_MakeFace(T(new o.gp_Pln(gpPnt(A), T(new o.gp_Dir(...z)))), -far, far, -far, far)).Face());
  const half = T(T(new o.BRepPrimAPI_MakeHalfSpace(o.TopoDS.Face(planeFace), gpPnt(v3.sub(A, v3.mul(z, far / 2))))).Solid());
  const c = T(new o.BRepAlgoAPI_Common(src.shape, half));
  c.Build();
  if (!c.IsDone() || c.HasErrors()) throw new Error("O corte falhou");
  const kept = T(c.Shape());
  if (!explore(kept, "solid").length || volume(kept).volume <= 0) throw new Error("A linha de corte não atravessa o modelo");
  return viewFromShape(kept, src, f, scale, { hatchPlane: A });
}

/** Pormenor: a geometria da vista-mãe recortada pelo círculo e ampliada. */
export function detailView(P: ViewResult, v: Extract<DrawingView, { kind: "detail" }>, scale: number): ViewResult {
  const clip = (cs: Curve2D[]) => clipCurvesCircle(cs, v.center, v.radius);
  const edges: Record<string, Curve2D> = {};
  for (const [k, c] of Object.entries(P.edges)) {
    const parts = clip([c]);
    if (parts.length) edges[k] = parts.length === 1 ? parts[0] : { k: "p", pts: parts.flatMap((x) => curvePoints(x)) };
  }
  const hatch: number[] = [];
  for (let i = 0; i < P.hatch.length; i += 6) {
    const cx = (P.hatch[i] + P.hatch[i + 2] + P.hatch[i + 4]) / 3, cy = (P.hatch[i + 1] + P.hatch[i + 3] + P.hatch[i + 5]) / 3;
    if (dist([cx, cy], v.center) <= v.radius) hatch.push(...P.hatch.slice(i, i + 6));
  }
  const r = v.radius;
  return {
    ...P, scale, bbox: [v.center[0] - r, v.center[1] - r, v.center[0] + r, v.center[1] + r],
    visible: clip(P.visible), hidden: clip(P.hidden), tangent: clip(P.tangent), hatch,
    centerMarks: P.centerMarks.filter((m) => dist(m.c, v.center) <= r),
    centerLines: P.centerLines.flatMap(([a, b]) => clipCurvesCircle([{ k: "l", a, b }], v.center, r).map((c) => curvePoints(c)).map((q) => [q[0], q[q.length - 1]] as [P, P])),
    edges, modelDims: P.modelDims.filter((m) => dist(m.a, v.center) <= r && dist(m.b, v.center) <= r),
    pmi: P.pmi?.filter((m) => (m.kind === "dim" ? dist(m.a, v.center) <= r && dist(m.b, v.center) <= r : dist(m.at, v.center) <= r)),
  };
}

/** Vista auxiliar: olha perpendicularmente a uma aresta reta da vista-mãe, dentro do plano da mãe. */
export function auxiliaryView(src: Source, P: ViewResult, v: Extract<DrawingView, { kind: "auxiliary" }>, scale: number): ViewResult {
  const e = src.edges.find((x) => x.name === v.edge);
  if (!e || e.type !== "line") throw new Error("Escolha uma aresta reta na vista-mãe");
  const F = P.frame;
  // direção da aresta no plano da vista-mãe
  const d3 = v3.sub(e.pts[e.pts.length - 1], e.pts[0]);
  const ed = v3.norm(v3.sub(d3, v3.mul(F.z, v3.dot(d3, F.z))));
  if (v3.len(ed) < 1e-9) throw new Error("A aresta é vista de topo na vista-mãe");
  let z = v3.norm(v3.cross(F.z, ed));
  if (v.flip) z = v3.mul(z, -1);
  const x = ed;
  return viewFromShape(src.shape, src, { o: F.o, x, y: v3.cross(z, x), z }, scale);
}
