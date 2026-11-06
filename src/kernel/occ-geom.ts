// OpenCASCADE: amostragem de arestas/fios, grelhas e geometria local de superfícies (Fase 4).
import type { Vec3 } from "../doc/types.ts";
import { T, oc, v3, xyz, gpPnt, makeList, type TopoDS_Shape, type TopoDS_Face } from "./occ-core.ts";
import { distance, vertexAt } from "./occ-props.ts";

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
