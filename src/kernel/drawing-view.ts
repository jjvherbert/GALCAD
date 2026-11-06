// Desenhos: uma vista a partir da forma — HLR, marcas e linhas de centro, hachuras, cotas do modelo e PMI.
import { cast } from "replicad";
import { type SketchEntity, type Vec3 } from "../doc/types.ts";
import { IMPLICIT } from "../sketch/geometry.ts";
import { type Curve2D, type PmiInView, type ViewFrame, type ViewResult } from "./protocol.ts";
import { type TopoDS_Shape, T, edgeProps, explore, faceProps, gpPnt, oc, sampleEdge, v3 } from "./occ.ts";
import { arcThrough, curvesBBox, dist, dropCoincident } from "../drawing/geom2d.ts";
import { type P, type Source, proj } from "./drawing-common.ts";

/** Curva 2D de uma aresta HLR (já no plano da vista, z = 0). */
function hlrCurve(e: TopoDS_Shape): Curve2D {
  const p = edgeProps(e);
  const xy = (v: Vec3): P => [v[0], v[1]];
  if (p.type === "line") return { k: "l", a: xy(p.start), b: xy(p.end) };
  if (p.type === "circle" && p.center && p.radius) {
    if (v3.dist(p.start, p.end) < 1e-7) return { k: "c", c: xy(p.center), r: p.radius };
    const a = arcThrough(xy(p.start), xy(p.mid), xy(p.end));
    if (a) return a;
  }
  return { k: "p", pts: sampleEdge(e, 33).map((s) => xy(s.p)) };
}

/** Projeção de uma aresta do modelo (pontos 3D) numa vista. */
function projectEdge(f: ViewFrame, pts: Vec3[], type: string): Curve2D {
  const q = pts.map((p) => proj(f, p));
  if (type === "line" || q.length === 2) return { k: "l", a: q[0], b: q[q.length - 1] };
  if (type === "circle" && q.length >= 3) {
    // círculo de frente (eixo paralelo à direção de vista): continua circular
    const m = q[Math.floor(q.length / 2)];
    const closed = dist(q[0], q[q.length - 1]) < 1e-6;
    const arc = arcThrough(q[0], closed ? q[Math.floor(q.length / 4)] : m, closed ? m : q[q.length - 1]);
    if (arc && q.every((p) => Math.abs(dist(p, arc.k === "a" ? arc.c : [0, 0]) - (arc.k === "a" ? arc.r : 0)) < 1e-4 * Math.max(1, arc.k === "a" ? arc.r : 1))) {
      return closed && arc.k === "a" ? { k: "c", c: arc.c, r: arc.r } : arc;
    }
  }
  return { k: "p", pts: q };
}

function hlr(shape: TopoDS_Shape, f: ViewFrame): { visible: Curve2D[]; hidden: Curve2D[]; tangent: Curve2D[] } {
  const o = oc();
  const ax = T(new o.gp_Ax2(gpPnt(f.o), T(new o.gp_Dir(...f.z)), T(new o.gp_Dir(...f.x))));
  const h = T(new o.HLRBRep_Algo());
  h.Add(shape, 0);
  h.Projector(T(new o.HLRAlgo_Projector(ax)));
  h.Update();
  h.Hide();
  const s = T(new o.HLRBRep_HLRToShape(h));
  const edgesOf = (c: TopoDS_Shape) => {
    T(c);
    if (c.IsNull()) return [];
    const es = explore(c, "edge");
    for (const e of es) o.BRepLib.BuildCurves3d(e);
    return es.map(hlrCurve);
  };
  const visible = [...edgesOf(s.VCompound()), ...edgesOf(s.OutLineVCompound())];
  const tangent = edgesOf(s.Rg1LineVCompound());
  const hiddenAll = [...edgesOf(s.HCompound()), ...edgesOf(s.OutLineHCompound())];
  const size = Math.max(1, ...curvesBBox(visible).map(Math.abs));
  return { visible, hidden: dropCoincident(hiddenAll, [...visible, ...tangent], size * 1e-5), tangent };
}

/** Marcas de centro (círculos e arcos ≥ 180°) e linhas de centro (cilindros vistos de lado). */
function centers(shape: TopoDS_Shape, f: ViewFrame, visible: Curve2D[], hidden: Curve2D[]) {
  const marks: { c: P; r: number }[] = [];
  for (const c of [...visible, ...hidden]) {
    if (c.k === "c" || (c.k === "a" && ((c.a1 - c.a0 + 4 * Math.PI) % (2 * Math.PI)) >= Math.PI - 1e-6)) {
      if (!marks.some((m) => dist(m.c, c.c) < 1e-6 && Math.abs(m.r - c.r) < 1e-6)) marks.push({ c: c.c, r: c.r });
    }
  }
  const lines: [P, P][] = [];
  for (const face of explore(shape, "face")) {
    const p = faceProps(face);
    if (p.type !== "cylinder" || !p.axis || Math.abs(v3.dot(p.axis.d, f.z)) > 1e-6) continue;
    let t0 = Infinity, t1 = -Infinity;
    // só furos e veios (superfície de pelo menos meia volta), não filetes
    const ux = v3.norm(Math.abs(p.axis.d[0]) < 0.9 ? v3.cross(p.axis.d, [1, 0, 0]) : v3.cross(p.axis.d, [0, 1, 0]));
    const uy = v3.cross(p.axis.d, ux);
    const angs: number[] = [];
    for (const e of explore(face, "edge")) for (const s of sampleEdge(e, 9)) {
      const r = v3.sub(s.p, p.axis.o);
      const t = v3.dot(r, p.axis.d);
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      angs.push(Math.atan2(v3.dot(r, uy), v3.dot(r, ux)));
    }
    if (!(t1 > t0)) continue;
    angs.sort((a, b) => a - b);
    let gap = angs.length ? angs[0] + 2 * Math.PI - angs[angs.length - 1] : 2 * Math.PI;
    for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
    if (gap > Math.PI + 1e-6) continue;
    const a = proj(f, v3.add(p.axis.o, v3.mul(p.axis.d, t0))), b = proj(f, v3.add(p.axis.o, v3.mul(p.axis.d, t1)));
    if (!lines.some(([x, y]) => (dist(x, a) < 1e-6 && dist(y, b) < 1e-6) || (dist(x, b) < 1e-6 && dist(y, a) < 1e-6))) lines.push([a, b]);
  }
  return { marks, lines };
}

/** Triângulos das faces de um sólido cortado que estão no plano de corte. */
function sectionTriangles(shape: TopoDS_Shape, f: ViewFrame, planePt: Vec3): number[] {
  const tris: number[] = [];
  for (const face of explore(shape, "face")) {
    const p = faceProps(face);
    if (p.type !== "plane" || !p.normal || Math.abs(Math.abs(v3.dot(p.normal, f.z)) - 1) > 1e-6) continue;
    if (Math.abs(v3.dot(v3.sub(p.center, planePt), f.z)) > 1e-6) continue;
    const m = cast(face).mesh({ tolerance: 0.05, angularTolerance: 0.2 });
    for (const t of m.triangles) { const q = proj(f, [m.vertices[t * 3], m.vertices[t * 3 + 1], m.vertices[t * 3 + 2]]); tris.push(q[0], q[1]); }
  }
  return tris;
}

/** Cotas dos esboços paralelos ao plano da vista. */
function modelDims(src: Source, f: ViewFrame): ViewResult["modelDims"] {
  const out: ViewResult["modelDims"] = [];
  for (const { id, s, constraints } of src.sketches) {
    if (Math.abs(Math.abs(v3.dot(s.frame.z, f.z)) - 1) > 1e-6) continue;
    const ents: Record<string, SketchEntity> = { ...IMPLICIT, ...s.entities };
    const pt = (pid: string): [number, number] | null => { const e = ents[pid]; return e?.type === "point" ? [e.x, e.y] : null; };
    const to = (q: [number, number]) => proj(f, v3.add(s.frame.o, v3.add(v3.mul(s.frame.x, q[0]), v3.mul(s.frame.y, q[1]))));
    const hx = Math.abs(v3.dot(s.frame.x, f.x)) > 0.999; // x do esboço = x da vista
    for (const c of constraints) {
      const [r0, r1] = c.refs;
      const e0 = ents[r0];
      let a: [number, number] | null = null, b: [number, number] | null = null;
      let type: ViewResult["modelDims"][number]["type"] = "aligned";
      if (c.type === "radius" || c.type === "diameter") {
        if (e0?.type !== "circle" && e0?.type !== "arc") continue;
        const cc = pt(e0.c);
        if (!cc) continue;
        a = cc; b = [cc[0] + e0.r * Math.SQRT1_2, cc[1] + e0.r * Math.SQRT1_2];
        type = c.type;
      } else if (c.type === "distance" || c.type === "distanceX" || c.type === "distanceY") {
        if (e0?.type === "line" && !r1) { a = pt(e0.p1); b = pt(e0.p2); }
        else { a = pt(r0); b = r1 ? pt(r1) : null; }
        if (c.type === "distanceX") type = hx ? "horizontal" : "vertical";
        if (c.type === "distanceY") type = hx ? "vertical" : "horizontal";
      } else continue;
      if (!a || !b) continue;
      const A = to(a), B = to(b);
      const value = type === "radius" ? dist(A, B) : type === "diameter" ? 2 * dist(A, B)
        : type === "horizontal" ? Math.abs(B[0] - A[0]) : type === "vertical" ? Math.abs(B[1] - A[1]) : dist(A, B);
      if (value < 1e-9) continue;
      out.push({ feature: id, constraint: c.id, type, a: A, b: B, value });
    }
  }
  return out;
}

/**
 * PMI da peça nesta vista: cotas onde a grandeza está no plano da vista (as outras ficam para vistas
 * onde se veem em verdadeira grandeza) e rótulos com o ponto de ancoragem e a direção da normal.
 */
function pmiInView(src: Source, f: ViewFrame): PmiInView[] {
  const out: PmiInView[] = [];
  const dir2 = (n: Vec3): [number, number] => { const q: [number, number] = [v3.dot(n, f.x), v3.dot(n, f.y)]; const l = Math.hypot(q[0], q[1]); return l > 1e-9 ? [q[0] / l, q[1] / l] : [Math.SQRT1_2, Math.SQRT1_2]; };
  for (const { item, state } of src.pmi ?? []) {
    const g = state.geom;
    if (item.kind === "dimension" && g && state.nominal !== undefined) {
      const tol = item.tol;
      if (g.kind === "distance") {
        if (Math.abs(v3.dot(g.n, f.z)) > 1e-6) continue; // distância ao longo da vista: noutra vista
        const A = proj(f, g.p), B = proj(f, v3.add(g.p, v3.mul(g.n, g.d)));
        const type = Math.abs(B[1] - A[1]) < 1e-9 ? "horizontal" : Math.abs(B[0] - A[0]) < 1e-9 ? "vertical" : "aligned";
        out.push({ item: item.id, kind: "dim", type, a: A, b: B, value: state.nominal, tol });
      } else {
        const along = Math.abs(v3.dot(g.d, f.z));
        if (along > 1 - 1e-6) {
          // eixo ao longo da vista: o cilindro vê-se como círculo
          const C = proj(f, g.o);
          out.push({ item: item.id, kind: "dim", type: item.type === "radius" ? "radius" : "diameter", a: C, b: [C[0] + g.r * Math.SQRT1_2, C[1] + g.r * Math.SQRT1_2], value: state.nominal, tol });
        } else if (along < 1e-6 && item.type === "diameter") {
          // eixo no plano da vista: cota linear entre as duas geratrizes da silhueta, com ⌀
          const w = v3.norm(v3.cross(f.z, g.d)) as Vec3;
          out.push({ item: item.id, kind: "dim", type: "aligned", a: proj(f, v3.add(g.o, v3.mul(w, g.r))), b: proj(f, v3.add(g.o, v3.mul(w, -g.r))), value: state.nominal, prefix: "⌀", tol });
        }
      }
      continue;
    }
    out.push({ item: item.id, kind: "label", at: proj(f, state.anchor), dir: dir2(state.normal), score: Math.abs(v3.dot(state.normal, f.z)), data: item, text: state.text });
  }
  return out;
}

/** Resultado de uma vista a partir da fonte e do referencial. */
export function viewFromShape(shape: TopoDS_Shape, src: Source, f: ViewFrame, scale: number, opts: { hatchPlane?: Vec3; allEdges?: boolean } = {}): ViewResult {
  const { visible, hidden, tangent } = hlr(shape, f);
  const { marks, lines } = centers(shape, f, visible, hidden);
  const edges: Record<string, Curve2D> = {};
  const edgeComponent: Record<string, string> = {};
  for (const e of src.edges) {
    edges[e.name] = projectEdge(f, e.pts, e.type);
    if (e.component) edgeComponent[e.name] = e.component;
  }
  return {
    ok: true, frame: f, scale, bbox: curvesBBox([...visible, ...tangent]), visible, hidden, tangent,
    hatch: opts.hatchPlane ? sectionTriangles(shape, f, opts.hatchPlane) : [],
    centerMarks: marks, centerLines: lines, edges, modelDims: modelDims(src, f), pmi: pmiInView(src, f),
    edgeComponent: Object.keys(edgeComponent).length ? edgeComponent : undefined,
  };
}
