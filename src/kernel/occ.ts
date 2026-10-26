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
