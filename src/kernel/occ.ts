// Acesso de baixo nível ao OpenCASCADE: exploração topológica, propriedades e gestão de memória.
import { getOC, HASH_CODE_MAX } from "replicad";
import type { OpenCascadeInstance, TopoDS_Shape, TopoDS_Face, TopoDS_Edge, NCollection_List_TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types.ts";

export type OC = OpenCascadeInstance;
export type { TopoDS_Shape, TopoDS_Face, TopoDS_Edge };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const oc = (): OC => getOC();

/**
 * Arena de objetos WASM: tudo o que é registado é libertado de uma vez com free().
 * Cada passo da reconstrução tem a sua arena, libertada quando esse passo sai da cache.
 */
export class Arena {
  private items: { delete(): void }[] = [];
  track<T extends { delete(): void }>(o: T): T {
    this.items.push(o);
    return o;
  }
  free() {
    for (const o of this.items.reverse()) {
      try { o.delete(); } catch { /* já libertado */ }
    }
    this.items = [];
  }
}

/** Arena atual (definida pelo motor durante cada passo). */
let current = new Arena();
export const setArena = (a: Arena) => { current = a; };
export const T = <T extends { delete(): void }>(o: T): T => current.track(o);

export const hash = (s: TopoDS_Shape) => oc().ReplicadShapeHasher.HashCode(s, HASH_CODE_MAX) as number;

type Kind = "face" | "edge" | "vertex" | "solid" | "wire" | "shell";

/** Subformas únicas de um tipo (IsSame), pela ordem do explorador. */
export function explore(shape: TopoDS_Shape, kind: "face"): TopoDS_Face[];
export function explore(shape: TopoDS_Shape, kind: "edge"): TopoDS_Edge[];
export function explore(shape: TopoDS_Shape, kind: Kind): TopoDS_Shape[];
export function explore(shape: TopoDS_Shape, kind: Kind): TopoDS_Shape[] {
  const o = oc();
  const E = o.TopAbs_ShapeEnum;
  const k = { face: E.TopAbs_FACE, edge: E.TopAbs_EDGE, vertex: E.TopAbs_VERTEX, solid: E.TopAbs_SOLID, wire: E.TopAbs_WIRE, shell: E.TopAbs_SHELL }[kind];
  const down = { face: o.TopoDS.Face, edge: o.TopoDS.Edge, vertex: o.TopoDS.Vertex, solid: o.TopoDS.Solid, wire: o.TopoDS.Wire, shell: o.TopoDS.Shell }[kind];
  const ex = new o.TopExp_Explorer(shape, k, E.TopAbs_SHAPE);
  const out: TopoDS_Shape[] = [];
  const byHash = new Map<number, TopoDS_Shape[]>();
  while (ex.More()) {
    const cur = ex.Current();
    const h = hash(cur);
    const bucket = byHash.get(h) ?? [];
    if (!bucket.some((s) => s.IsSame(cur))) {
      const d = T(down(cur));
      bucket.push(d);
      byHash.set(h, bucket);
      out.push(d);
    }
    ex.Next();
  }
  ex.delete();
  return out;
}

/** Converte uma lista OCC num array (sem a consumir), com downcast pelo tipo de cada forma. */
export function listToArray(l: NCollection_List_TopoDS_Shape): TopoDS_Shape[] {
  const o = oc();
  const copy = new o.NCollection_List_TopoDS_Shape(l);
  const out: TopoDS_Shape[] = [];
  while (!copy.IsEmpty()) {
    out.push(T(downcast(copy.First())));
    copy.RemoveFirst();
  }
  copy.delete();
  return out;
}

export function makeList(shapes: TopoDS_Shape[]): NCollection_List_TopoDS_Shape {
  const l = T(new (oc().NCollection_List_TopoDS_Shape)());
  for (const s of shapes) l.Append(s);
  return l;
}

/** Downcast para o tipo concreto (TopoDS_Face, TopoDS_Edge, …). */
export function downcast(s: TopoDS_Shape): TopoDS_Shape {
  const o = oc();
  const E = o.TopAbs_ShapeEnum;
  const t = s.ShapeType();
  if (t === E.TopAbs_FACE) return o.TopoDS.Face(s);
  if (t === E.TopAbs_EDGE) return o.TopoDS.Edge(s);
  if (t === E.TopAbs_SOLID) return o.TopoDS.Solid(s);
  if (t === E.TopAbs_VERTEX) return o.TopoDS.Vertex(s);
  if (t === E.TopAbs_WIRE) return o.TopoDS.Wire(s);
  if (t === E.TopAbs_SHELL) return o.TopoDS.Shell(s);
  if (t === E.TopAbs_COMPOUND) return o.TopoDS.Compound(s);
  return s;
}

export const isType = (s: TopoDS_Shape, kind: "solid" | "compound" | "face" | "edge" | "shell") => {
  const E = oc().TopAbs_ShapeEnum;
  return s.ShapeType() === { solid: E.TopAbs_SOLID, compound: E.TopAbs_COMPOUND, face: E.TopAbs_FACE, edge: E.TopAbs_EDGE, shell: E.TopAbs_SHELL }[kind];
};

// --- vetores ---------------------------------------------------------------

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  dist: (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};

export const gpPnt = (p: Vec3) => T(new (oc().gp_Pnt)(p[0], p[1], p[2]));
export const gpVec = (p: Vec3) => T(new (oc().gp_Vec)(p[0], p[1], p[2]));
export const gpDir = (p: Vec3) => T(new (oc().gp_Dir)(p[0], p[1], p[2]));
export const gpAx1 = (o: Vec3, d: Vec3) => T(new (oc().gp_Ax1)(gpPnt(o), gpDir(d)));
export const gpAx2 = (o: Vec3, n: Vec3, x: Vec3) => T(new (oc().gp_Ax2)(gpPnt(o), gpDir(n), gpDir(x)));
export const gpPln = (o: Vec3, n: Vec3) => T(new (oc().gp_Pln)(gpPnt(o), gpDir(n)));
const xyz = (p: Any): Vec3 => [p.X(), p.Y(), p.Z()];

// --- propriedades ------------------------------------------------------------

export interface FaceProps {
  center: Vec3;
  area: number;
  /** Normal exterior (faces planas). */
  normal?: Vec3;
  /** Origem de um ponto da face plana. */
  planeOrigin?: Vec3;
  type: string; // "plane" | "cylinder" | ...
  /** Eixo (cilindro/cone/toro): origem e direção. */
  axis?: { o: Vec3; d: Vec3 };
}

const SURF: Record<string, string> = {
  GeomAbs_Plane: "plane", GeomAbs_Cylinder: "cylinder", GeomAbs_Cone: "cone", GeomAbs_Sphere: "sphere",
  GeomAbs_Torus: "torus", GeomAbs_BezierSurface: "bezier", GeomAbs_BSplineSurface: "bspline",
  GeomAbs_SurfaceOfRevolution: "revolution", GeomAbs_SurfaceOfExtrusion: "extrusion", GeomAbs_OffsetSurface: "offset",
};

export function faceProps(shape: TopoDS_Shape): FaceProps {
  const o = oc();
  const f = T(o.TopoDS.Face(shape));
  const props = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(f, props, false, false);
  const center = xyz(props.CentreOfMass());
  const area = props.Mass();
  props.delete();
  const ad = new o.BRepAdaptor_Surface(f, false);
  const typeName = Object.entries(o.GeomAbs_SurfaceType).find(([, v]) => v === ad.GetType())?.[0] ?? "";
  const type = SURF[typeName] ?? "other";
  const res: FaceProps = { center, area, type };
  const reversed = f.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED;
  if (type === "plane") {
    const pl = ad.Plane();
    const ax = pl.Axis();
    let n = xyz(ax.Direction());
    if (reversed) n = v3.mul(n, -1);
    res.normal = n;
    res.planeOrigin = xyz(pl.Location());
  } else if (type === "cylinder") {
    // (o cone não tem ligação nesta compilação WASM: gp_Cone não está exposto)
    try {
      const ax = (ad.Cylinder() as Any).Axis();
      res.axis = { o: xyz(ax.Location()), d: xyz(ax.Direction()) };
    } catch { /* eixo indisponível */ }
  }
  ad.delete();
  return res;
}

export interface EdgeProps {
  mid: Vec3;
  length: number;
  type: string; // "line" | "circle" | ...
  start: Vec3;
  end: Vec3;
  /** Linha: direção. Círculo: eixo. */
  dir?: Vec3;
  center?: Vec3;
  radius?: number;
}

export function edgeProps(shape: TopoDS_Shape): EdgeProps {
  const o = oc();
  const e = T(o.TopoDS.Edge(shape));
  const ad = new o.BRepAdaptor_Curve(e);
  const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
  const at = (t: number) => { const p = ad.Value(t); const r = xyz(p); p.delete(); return r; };
  const props = new o.GProp_GProps();
  o.BRepGProp.LinearProperties(e, props, false, false);
  const length = props.Mass();
  props.delete();
  const typeName = Object.entries(o.GeomAbs_CurveType).find(([, v]) => v === ad.GetType())?.[0] ?? "";
  const type = typeName === "GeomAbs_Line" ? "line" : typeName === "GeomAbs_Circle" ? "circle" : typeName.replace("GeomAbs_", "").toLowerCase();
  const res: EdgeProps = { mid: at((t0 + t1) / 2), start: at(t0), end: at(t1), length, type };
  if (type === "line") res.dir = v3.norm(v3.sub(res.end, res.start));
  if (type === "circle") {
    const c = ad.Circle();
    const ax = c.Axis();
    res.center = xyz(ax.Location());
    res.dir = xyz(ax.Direction());
    res.radius = c.Radius();
  }
  ad.delete();
  return res;
}

export function bbox(s: TopoDS_Shape): { min: Vec3; max: Vec3 } {
  const o = oc();
  const box = new o.Bnd_Box();
  o.BRepBndLib.AddOptimal(s, box, false, false);
  if (box.IsVoid()) { box.delete(); return { min: [0, 0, 0], max: [0, 0, 0] }; }
  const mn = box.CornerMin(), mx = box.CornerMax();
  const r = { min: xyz(mn), max: xyz(mx) };
  box.delete();
  return r;
}

export function volume(s: TopoDS_Shape): { volume: number; center: Vec3 } {
  const o = oc();
  const props = new o.GProp_GProps();
  o.BRepGProp.VolumeProperties(s, props, false, false, false);
  const r = { volume: props.Mass(), center: xyz(props.CentreOfMass()) };
  props.delete();
  return r;
}

export function isValid(s: TopoDS_Shape): boolean {
  const a = new (oc().BRepCheck_Analyzer)(s, true, false);
  const ok = a.IsValid();
  a.delete();
  return ok;
}

export function makeCompound(shapes: TopoDS_Shape[]): TopoDS_Shape {
  const o = oc();
  const builder = new o.TopoDS_Builder();
  const comp = T(new o.TopoDS_Compound());
  builder.MakeCompound(comp);
  for (const s of shapes) builder.Add(comp, s);
  builder.delete();
  return comp;
}

export function vertexAt(p: Vec3): TopoDS_Shape {
  const mk = new (oc().BRepBuilderAPI_MakeVertex)(gpPnt(p));
  const v = T(mk.Vertex());
  mk.delete();
  return v;
}

/** Aresta tangente (concordância G1 ou melhor) entre duas faces: não tem canto para arredondar/chanfrar. */
export function isSmoothEdge(e: TopoDS_Shape, f1: TopoDS_Shape, f2: TopoDS_Shape): boolean {
  const o = oc();
  const edge = T(o.TopoDS.Edge(e)), a = T(o.TopoDS.Face(f1)), b = T(o.TopoDS.Face(f2));
  try {
    o.BRepLib.EncodeRegularity(edge, a, b, 1e-4);
    return o.BRep_Tool.Continuity(edge, a, b) !== o.GeomAbs_Shape.GeomAbs_C0;
  } catch {
    return false;
  }
}

/** Distância mínima entre duas formas. */
export function distance(a: TopoDS_Shape, b: TopoDS_Shape): number {
  const o = oc();
  const d = new o.BRepExtrema_DistShapeShape(a, b);
  const v = d.IsDone() ? d.Value() : Infinity;
  d.delete();
  return v;
}

/** Casca (shell) a partir de faces que partilham arestas. */
export function makeShell(faces: TopoDS_Shape[]): TopoDS_Shape {
  const o = oc();
  const builder = new o.TopoDS_Builder();
  const sh = T(new o.TopoDS_Shell());
  builder.MakeShell(sh);
  for (const f of faces) builder.Add(sh, f);
  builder.delete();
  return sh;
}

/** Normal da face (com a orientação da face) no ponto da superfície mais próximo de `p`. */
export function normalOnFace(face: TopoDS_Shape, p: Vec3): Vec3 {
  const o = oc();
  const f = T(o.TopoDS.Face(face));
  const proj = T(new o.GeomAPI_ProjectPointOnSurf(gpPnt(p), T(o.BRep_Tool.Surface(f))));
  if (!proj.IsDone() || proj.NbPoints() < 1) throw new Error("Projeção na face falhou");
  const { U, V } = proj.LowerDistanceParameters();
  const ad = T(new o.BRepAdaptor_Surface(f, true));
  const P = T(new o.gp_Pnt(0, 0, 0)), su = T(new o.gp_Vec(0, 0, 0)), sv = T(new o.gp_Vec(0, 0, 0));
  ad.D1(U, V, P, su, sv);
  let n = v3.norm([su.Y() * sv.Z() - su.Z() * sv.Y(), su.Z() * sv.X() - su.X() * sv.Z(), su.X() * sv.Y() - su.Y() * sv.X()]);
  if (f.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED) n = v3.mul(n, -1);
  return n;
}

/** Pontos (e tangentes) ao longo de uma aresta, `n` amostras incluindo as extremidades. */
export function sampleEdge(edge: TopoDS_Shape, n: number): { p: Vec3; t: Vec3 }[] {
  const o = oc();
  const c = T(new o.BRepAdaptor_Curve(T(o.TopoDS.Edge(edge))));
  const a = c.FirstParameter(), b = c.LastParameter();
  const P = T(new o.gp_Pnt(0, 0, 0)), D = T(new o.gp_Vec(0, 0, 0));
  const out: { p: Vec3; t: Vec3 }[] = [];
  for (let i = 0; i < n; i++) {
    c.D1(a + ((b - a) * i) / (n - 1), P, D);
    out.push({ p: [P.X(), P.Y(), P.Z()], t: v3.norm([D.X(), D.Y(), D.Z()]) });
  }
  return out;
}

/** Aresta B-spline interpolada (C2) que passa pelos pontos. */
export function interpolateEdge(points: Vec3[], closed = false): TopoDS_Shape {
  const o = oc();
  if (points.length < 2) throw new Error("São precisos pelo menos 2 pontos");
  const a1 = T(new o.NCollection_Array1_gp_Pnt(1, points.length));
  points.forEach((p, i) => a1.SetValue(i + 1, gpPnt(p)));
  const it = T(new o.GeomAPI_Interpolate(T(new o.NCollection_HArray1_gp_Pnt(a1)), closed, 1e-7));
  it.Perform();
  if (!it.IsDone()) throw new Error("A interpolação dos pontos falhou (pontos repetidos?)");
  return T(T(new o.BRepBuilderAPI_MakeEdge(T(it.Curve()))).Edge());
}

/** Contorno (wire) a partir de arestas encadeadas, ou null se não ligarem. */
export function makeWire(edges: TopoDS_Shape[]): TopoDS_Shape | null {
  const o = oc();
  const mk = T(new o.BRepBuilderAPI_MakeWire());
  // a versão com lista aceita as arestas por qualquer ordem, desde que liguem
  mk.Add(makeList(edges));
  return mk.IsDone() ? T(mk.Wire()) : null;
}

// --- amostragem, grelhas e geometria local (superfícies da Fase 4) ---------

/** Pontos ao longo de um contorno (wire) encadeado, por parâmetro de comprimento de arco aproximado. */
export function sampleWire(wire: TopoDS_Shape, n: number): Vec3[] {
  const o = oc();
  const c = T(new o.BRepAdaptor_CompCurve(T(o.TopoDS.Wire(wire)), true));
  const a = c.FirstParameter(), b = c.LastParameter();
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = c.EvalD0(a + ((b - a) * i) / (n - 1));
    out.push([p.X(), p.Y(), p.Z()]);
    p.delete();
  }
  return out;
}

/** Ponto, 1.ª e 2.ª derivadas numa extremidade de um contorno (para prolongar curvas). */
export function wireEnd(wire: TopoDS_Shape, atEnd: boolean): { p: Vec3; d1: Vec3; d2: Vec3 } {
  const o = oc();
  const c = T(new o.BRepAdaptor_CompCurve(T(o.TopoDS.Wire(wire)), true));
  const r = c.EvalD2(atEnd ? c.LastParameter() : c.FirstParameter());
  const out = { p: xyz(r.Point), d1: xyz(r.D1), d2: xyz(r.D2) };
  r.Point.delete(); r.D1.delete(); r.D2.delete();
  return out;
}

/**
 * Face B-spline bicúbica (C2) que interpola uma grelha de pontos [u][v]. Usada pelas superfícies
 * construídas por amostragem (multi-secção com guias, concordância, extrapolação, varrimento circular).
 */
export function gridFace(grid: Vec3[][]): TopoDS_Face {
  const o = oc();
  const nu = grid.length, nv = grid[0].length;
  if (nu < 2 || nv < 2) throw new Error("Grelha de superfície demasiado pequena");
  const arr = T(new o.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) arr.SetValue(i + 1, j + 1, gpPnt(grid[i][j]));
  const fit = T(new o.GeomAPI_PointsToBSplineSurface());
  fit.Interpolate(arr, false);
  if (!fit.IsDone()) throw new Error("A interpolação da superfície falhou (pontos coincidentes ou dobras?)");
  const mk = T(new o.BRepBuilderAPI_MakeFace(T(fit.Surface()), 1e-7));
  if (!mk.IsDone()) throw new Error("Não foi possível criar a face");
  return T(mk.Face());
}

/** Geometria local de uma face num ponto: normal (com a orientação da face) e curvatura normal numa direção. */
export interface SurfaceLocal {
  p: Vec3;
  n: Vec3;
  /** Curvatura normal na direção tangente `d` (sinal relativo a `n`). */
  kn(d: Vec3): number;
}

export function surfaceAt(face: TopoDS_Shape, p: Vec3): SurfaceLocal {
  const o = oc();
  const f = T(o.TopoDS.Face(face));
  const proj = T(new o.GeomAPI_ProjectPointOnSurf(gpPnt(p), T(o.BRep_Tool.Surface(f))));
  if (!proj.IsDone() || proj.NbPoints() < 1) throw new Error("Projeção na face falhou");
  const { U, V } = proj.LowerDistanceParameters();
  const ad = T(new o.BRepAdaptor_Surface(f, true));
  const P = T(new o.gp_Pnt(0, 0, 0));
  const [su, sv, suu, svv, suv] = [0, 1, 2, 3, 4].map(() => T(new o.gp_Vec(0, 0, 0)));
  ad.D2(U, V, P, su, sv, suu, svv, suv);
  const Su = xyz(su), Sv = xyz(sv);
  let n = v3.norm(v3.cross(Su, Sv));
  const E = v3.dot(Su, Su), F = v3.dot(Su, Sv), G = v3.dot(Sv, Sv);
  const L = v3.dot(xyz(suu), n), M = v3.dot(xyz(suv), n), N = v3.dot(xyz(svv), n);
  const flip = f.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
  const kn = (d: Vec3) => {
    // d = a·Su + b·Sv (mínimos quadrados no plano tangente)
    const r1 = v3.dot(d, Su), r2 = v3.dot(d, Sv), det = E * G - F * F;
    if (Math.abs(det) < 1e-18) return 0;
    const a = (r1 * G - r2 * F) / det, b = (r2 * E - r1 * F) / det;
    const I = E * a * a + 2 * F * a * b + G * b * b;
    return I > 1e-18 ? (flip * (L * a * a + 2 * M * a * b + N * b * b)) / I : 0;
  };
  n = v3.mul(n, flip);
  return { p: xyz(P), n, kn };
}

/**
 * Direção tangente à face, perpendicular a `t`, que sai da face (para fora do seu limite) num ponto
 * de uma aresta de fronteira. Usa a distância à face de um ponto ligeiramente deslocado.
 */
export function outwardDir(face: TopoDS_Shape, p: Vec3, t: Vec3, eps: number): Vec3 {
  const n = surfaceAt(face, p).n;
  const d = v3.norm(v3.cross(n, t));
  const ahead = distance(vertexAt(v3.add(p, v3.mul(d, eps))), face);
  const back = distance(vertexAt(v3.add(p, v3.mul(d, -eps))), face);
  return ahead >= back ? d : v3.mul(d, -1);
}

/** Contorno (wire) a partir de arestas: uma aresta ou várias encadeadas. */
export function wireOf(edges: TopoDS_Shape[]): TopoDS_Shape {
  const o = oc();
  const w = edges.length === 1 ? T(T(new o.BRepBuilderAPI_MakeWire(o.TopoDS.Edge(edges[0]))).Wire()) : makeWire(edges);
  if (!w) throw new Error("As arestas não formam uma curva contínua");
  return w;
}

/**
 * Face B-spline exata a partir de "linhas de polos": rows[k][i] é o polo k (sentido v, Bézier de
 * grau rows.length − 1) da amostra i (sentido u). Cada linha é interpolada ao longo de u com os
 * mesmos parâmetros (mesmos nós), por isso a forma transversal é exatamente a Bézier pedida em
 * cada amostra — é o que garante as tangências/curvaturas impostas nos bordos (concordâncias,
 * extrapolações).
 */
export function poleRowsFace(rows: Vec3[][]): TopoDS_Face {
  const o = oc();
  const n = rows[0].length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + v3.dist(rows[0][i - 1], rows[0][i]) + 1e-9);
  const params = T(new o.NCollection_Array1_double(1, n));
  s.forEach((x, i) => params.SetValue(i + 1, x / s[n - 1]));
  const hp = T(new o.NCollection_HArray1_double(params));
  const curves = rows.map((row) => {
    const a1 = T(new o.NCollection_Array1_gp_Pnt(1, n));
    row.forEach((p, i) => a1.SetValue(i + 1, gpPnt(p)));
    const it = T(new o.GeomAPI_Interpolate(T(new o.NCollection_HArray1_gp_Pnt(a1)), hp, false, 1e-9));
    it.Perform();
    if (!it.IsDone()) throw new Error("A interpolação das linhas de polos falhou");
    return T(it.Curve());
  });
  const c0 = curves[0];
  const np = c0.NbPoles(), nk = c0.NbKnots(), deg = c0.Degree();
  const poles = T(new o.NCollection_Array2_gp_Pnt(1, np, 1, rows.length));
  curves.forEach((c, k) => { for (let i = 1; i <= np; i++) poles.SetValue(i, k + 1, T(c.Pole(i))); });
  const uk = T(new o.NCollection_Array1_double(1, nk)), um = T(new o.NCollection_Array1_int(1, nk));
  for (let i = 1; i <= nk; i++) { uk.SetValue(i, c0.Knot(i)); um.SetValue(i, c0.Multiplicity(i)); }
  const vk = T(new o.NCollection_Array1_double(1, 2)), vm = T(new o.NCollection_Array1_int(1, 2));
  vk.SetValue(1, 0); vk.SetValue(2, 1); vm.SetValue(1, rows.length); vm.SetValue(2, rows.length);
  const surf = T(new o.Geom_BSplineSurface(poles, uk, vk, um, vm, deg, rows.length - 1, false, false));
  const mk = T(new o.BRepBuilderAPI_MakeFace(surf, 1e-7));
  if (!mk.IsDone()) throw new Error("Não foi possível criar a face");
  return T(mk.Face());
}
