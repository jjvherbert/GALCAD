// OpenCASCADE: propriedades e medições de faces, arestas e formas (área, volume, caixa, distância, validade).
import type { Vec3 } from "../doc/types.ts";
import { T, oc, v3, xyz, gpPnt, type Any, type TopoDS_Shape } from "./occ-core.ts";

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
