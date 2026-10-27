// Desenhos 2D no núcleo: projeções com remoção de linhas ocultas (HLR do OpenCASCADE), cortes,
// pormenores, vistas auxiliares, marcas e linhas de centro, e as cotas dos esboços (importar cotas
// do modelo). As coordenadas das vistas estão em mm do modelo; a escala aplica-se ao desenhar a folha.
import { cast } from "replicad";
import type { CadProject, DrawingDoc, DrawingView, StdView } from "../doc/project.ts";
import type { SketchEntity, Vec3 } from "../doc/types.ts";
import { IMPLICIT } from "../sketch/geometry.ts";
import { applyPose } from "../assembly/solver.ts";
import type { Curve2D, DrawingResponse, ViewFrame, ViewResult } from "./protocol.ts";
import type { KernelService } from "./service.ts";
import { solveAssembly, type PartBuild } from "./assembly.ts";
import { namedEdges } from "./naming.ts";
import { T, type TopoDS_Shape, edgeProps, explore, faceProps, gpPnt, makeCompound, oc, sampleEdge, setArena, v3, volume } from "./occ.ts";
import type { SketchResult } from "./context.ts";
import { arcThrough, clipCurvesCircle, curvePoints, curvesBBox, dist, dropCoincident } from "../drawing/geom2d.ts";

type P = [number, number];

/** Fonte de uma vista: forma em coordenadas da montagem/peça e arestas nomeadas (pontos 3D). */
interface Source {
  shape: TopoDS_Shape;
  edges: { name: string; pts: Vec3[]; type: string; component?: string }[];
  sketches: { id: string; s: SketchResult; constraints: { id: string; type: string; refs: string[] }[] }[];
  volume: number;
  material?: string;
}

const STD_VIEWS: Record<Exclude<StdView, "iso">, ViewFrame> = {
  front: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  back: { o: [0, 0, 0], x: [-1, 0, 0], y: [0, 0, 1], z: [0, 1, 0] },
  top: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  bottom: { o: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
  right: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
  left: { o: [0, 0, 0], x: [0, -1, 0], y: [0, 0, 1], z: [-1, 0, 0] },
};

export function stdFrame(v: StdView): ViewFrame {
  if (v !== "iso") return STD_VIEWS[v];
  const z = v3.norm([1, -1, 1]);
  const y = v3.norm(v3.sub([0, 0, 1], v3.mul(z, v3.dot([0, 0, 1], z))));
  return { o: [0, 0, 0], x: v3.cross(y, z), y, z };
}

/**
 * Vista projetada: o lado em que fica na folha e o método de projeção dizem de onde se olha.
 * 1.º diedro (ISO): a vista colocada à direita é a vista da esquerda; em cima, a vista de baixo.
 */
export function projectedFrame(P: ViewFrame, side: "right" | "left" | "above" | "below", method: "first" | "third"): ViewFrame {
  const from = method === "third" ? side : ({ right: "left", left: "right", above: "below", below: "above" } as const)[side];
  const n = (a: Vec3) => v3.mul(a, -1);
  switch (from) {
    case "right": return { o: P.o, x: n(P.z), y: P.y, z: P.x };
    case "left": return { o: P.o, x: P.z, y: P.y, z: n(P.x) };
    case "above": return { o: P.o, x: P.x, y: n(P.z), z: P.y };
    case "below": return { o: P.o, x: P.x, y: P.z, z: n(P.y) };
  }
}

const proj = (f: ViewFrame, p: Vec3): P => { const d = v3.sub(p, f.o); return [v3.dot(d, f.x), v3.dot(d, f.y)]; };
const unproj = (f: ViewFrame, q: P): Vec3 => v3.add(f.o, v3.add(v3.mul(f.x, q[0]), v3.mul(f.y, q[1])));

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

async function sourceOf(svc: KernelService, project: CadProject, src: { kind: "part" | "assembly"; id: string }): Promise<Source> {
  const builds = new Map<string, PartBuild>();
  const get = async (pid: string) => { let b = builds.get(pid); if (!b) { b = await svc.partBuild(project, pid); builds.set(pid, b); } return b; };
  const sample = (e: TopoDS_Shape) => {
    const p = edgeProps(e);
    return { pts: p.type === "line" ? [p.start, p.end] : sampleEdge(e, 25).map((s) => s.p), type: p.type };
  };
  if (src.kind === "part") {
    const b = await get(src.id);
    setArena(svc.drawingArena);
    const body = b.ctx.body;
    if (!body) throw new Error("A peça não tem corpo sólido");
    const doc = project.parts.find((p) => p.id === src.id)!;
    const sketches = [...b.ctx.sketches].map(([id, s]) => {
      const f = doc.features.find((x) => x.id === id);
      return { id, s, constraints: f?.type === "sketch" && !f.suppressed ? f.constraints.filter((c) => !c.driven) : [] };
    });
    return { shape: body.shape, edges: namedEdges(body).map((e) => ({ name: e.name, ...sample(e.edge) })), sketches, volume: b.volume, material: doc.properties?.material };
  }
  const asm = await solveAssembly(project, src.id, get);
  for (const i of asm.instances) await get(i.part);
  setArena(svc.drawingArena);
  const o = oc();
  const shapes: TopoDS_Shape[] = [];
  const edges: Source["edges"] = [];
  let vol = 0;
  for (const i of asm.instances) {
    const b = builds.get(i.part)!;
    const body = b.ctx.body;
    if (!body) continue;
    vol += b.volume;
    const t = T(new o.gp_Trsf());
    const R = i.pose.R, p = i.pose.t;
    t.SetValues(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2]);
    shapes.push(T(T(new o.BRepBuilderAPI_Transform(body.shape, t, true, false)).Shape()));
    for (const e of namedEdges(body)) {
      const s = sample(e.edge);
      edges.push({ name: `${i.path.join("/")}|${e.name}`, pts: s.pts.map((q) => applyPose(i.pose, q)), type: s.type, component: i.path[0] });
    }
  }
  if (!shapes.length) throw new Error("A montagem não tem peças com corpo");
  return { shape: makeCompound(shapes), edges, sketches: [], volume: vol };
}

/** Resultado de uma vista a partir da fonte e do referencial. */
function viewFromShape(shape: TopoDS_Shape, src: Source, f: ViewFrame, scale: number, opts: { hatchPlane?: Vec3; allEdges?: boolean } = {}): ViewResult {
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
    centerMarks: marks, centerLines: lines, edges, modelDims: modelDims(src, f),
    edgeComponent: Object.keys(edgeComponent).length ? edgeComponent : undefined,
  };
}

const sheetScale = (d: DrawingDoc) => d.sheet.scale[0] / d.sheet.scale[1];

export async function buildDrawing(svc: KernelService, project: CadProject, id: string, _force: boolean): Promise<DrawingResponse> {
  const t0 = performance.now();
  const d = project.drawings.find((x) => x.id === id);
  if (!d) throw new Error(`Desenho ${id} inexistente`);
  const arena = svc.drawingArena;
  arena.free();
  const sources = new Map<string, Source>();
  const srcKey = (s: { kind: string; id: string }) => `${s.kind}:${s.id}`;
  const out: Record<string, ViewResult> = {};
  const srcInfo: DrawingResponse["sources"] = {};
  // primeiro reconstruir as fontes (cada peça usa a arena do seu motor), depois as vistas na arena do desenho
  for (const v of d.views) {
    if (v.kind !== "model") continue;
    const k = srcKey(v.source);
    if (sources.has(k)) continue;
    try {
      const s = await sourceOf(svc, project, v.source);
      sources.set(k, s);
      srcInfo[v.source.id] = { volume: s.volume, material: s.material };
    } catch (e) {
      out[v.id] = failed((e as Error).message);
    }
  }
  setArena(arena);
  const byId = new Map(d.views.map((v) => [v.id, v]));
  const rootSource = (v: DrawingView, seen = new Set<string>()): Source | null => {
    if (v.kind === "model") return sources.get(srcKey(v.source)) ?? null;
    if (seen.has(v.id)) return null;
    seen.add(v.id);
    const p = byId.get(v.parent);
    return p ? rootSource(p, seen) : null;
  };
  const compute = (v: DrawingView): ViewResult => {
    if (out[v.id]) return out[v.id];
    let r: ViewResult;
    try {
      const src = rootSource(v);
      if (!src) throw new Error("Vista sem modelo (a vista-mãe foi apagada?)");
      if (v.kind === "model") r = viewFromShape(src.shape, src, stdFrame(v.orientation), v.scale ?? sheetScale(d));
      else {
        const parentView = byId.get(v.parent)!;
        const P = compute(parentView);
        if (!P.ok) throw new Error("A vista-mãe tem erros");
        const scale = v.scale ?? P.scale;
        if (v.kind === "projected") r = viewFromShape(src.shape, src, projectedFrame(P.frame, v.side, d.sheet.projection), scale);
        else if (v.kind === "section") r = sectionView(src, P.frame, v, scale);
        else if (v.kind === "detail") r = detailView(P, v, v.scale ?? P.scale * 2);
        else r = auxiliaryView(src, P, v, scale);
      }
    } catch (e) {
      r = failed((e as Error).message);
    }
    out[v.id] = r;
    return r;
  };
  for (const v of d.views) compute(v);
  // volumes das peças das tabelas de BOM (massas)
  const partVolumes: Record<string, number> = {};
  const used = new Set<string>();
  const walk = (asmId: string, depth = 0) => {
    const a = project.assemblies.find((x) => x.id === asmId);
    for (const c of a?.components ?? []) { if (c.ref.kind === "part") used.add(c.ref.id); else if (depth < 32) walk(c.ref.id, depth + 1); }
  };
  for (const x of d.annotations) if (x.kind === "bom") walk(x.source);
  for (const pid of used) { try { partVolumes[pid] = (await svc.partBuild(project, pid)).volume; } catch { /* peça com erro: sem massa */ } }
  setArena(arena);
  return { views: out, sources: srcInfo, partVolumes, ms: Math.round(performance.now() - t0) };
}

function failed(error: string): ViewResult {
  return { ok: false, error, frame: STD_VIEWS.front, scale: 1, bbox: [0, 0, 0, 0], visible: [], hidden: [], tangent: [], hatch: [], centerMarks: [], centerLines: [], edges: {}, modelDims: [] };
}

/** Corte: a linha a→b da vista-mãe e a direção de vista da mãe definem o plano de corte. */
function sectionView(src: Source, P: ViewFrame, v: Extract<DrawingView, { kind: "section" }>, scale: number): ViewResult {
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
function detailView(P: ViewResult, v: Extract<DrawingView, { kind: "detail" }>, scale: number): ViewResult {
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
  };
}

/** Vista auxiliar: olha perpendicularmente a uma aresta reta da vista-mãe, dentro do plano da mãe. */
function auxiliaryView(src: Source, P: ViewResult, v: Extract<DrawingView, { kind: "auxiliary" }>, scale: number): ViewResult {
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

