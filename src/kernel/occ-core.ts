// Acesso de baixo nível ao OpenCASCADE (núcleo): tipos, arena de memória, exploração topológica, vetores e construtores gp.
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
/** Arena atual (para a repor depois de um passo que reconstrói outra peça a meio). */
export const getArena = () => current;

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
export const xyz = (p: Any): Vec3 => [p.X(), p.Y(), p.Z()];
