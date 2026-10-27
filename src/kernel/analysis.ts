// Análises de superfície no núcleo: curvatura exata em cada vértice da malha de visualização.
// Para cada vértice: projeção na superfície da face → (u, v) → derivadas até à 2.ª ordem →
// formas fundamentais → curvatura gaussiana K = (LN − M²)/(EG − F²) e média H = (EN − 2FM + GL)/(2(EG − F²)).
import type { CombsResponse, ContinuityResponse, CurvatureKind, CurvatureResponse, DeviationResponse } from "./protocol.ts";
import type { Vec3 } from "../doc/types.ts";
import type { MeshData } from "./mesh.ts";
import { type NamedBody, namedEdges } from "./naming.ts";
import { type NamedEdge } from "./naming.ts";
import { T, type TopoDS_Shape, bbox, distance, faceProps, normalOnFace, oc, sampleEdge, surfaceAt, v3, vertexAt } from "./occ.ts";

type V = { X(): number; Y(): number; Z(): number };
const dot = (a: V, b: V) => a.X() * b.X() + a.Y() * b.Y() + a.Z() * b.Z();

export function curvature(scene: NamedBody, mesh: MeshData, kind: CurvatureKind): CurvatureResponse {
  const o = oc();
  const values = new Float32Array(mesh.vertices.length / 3);
  const byName = new Map(scene.faces.map((f) => [f.name, f.face]));
  const P = T(new o.gp_Pnt(0, 0, 0));
  const vs = [0, 1, 2, 3, 4].map(() => T(new o.gp_Vec(0, 0, 0)));
  for (const g of mesh.faces) {
    const face = byName.get(g.name);
    if (!face || faceProps(face).type === "plane") continue;
    let lo = Infinity, hi = -1;
    for (let k = g.start; k < g.start + g.count; k++) { const v = mesh.triangles[k]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi < 0) continue;
    const surf = T(o.BRep_Tool.Surface(face));
    const ad = T(new o.BRepAdaptor_Surface(face, true));
    const Q = T(new o.gp_Pnt(0, 0, 0));
    const at = (i: number) => { Q.SetCoord(mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]); return Q; };
    const proj = T(new o.GeomAPI_ProjectPointOnSurf(at(lo), surf));
    for (let i = lo; i <= hi; i++) {
      if (i > lo) proj.Perform(at(i));
      if (!proj.IsDone() || proj.NbPoints() < 1) continue;
      const { U, V: Vp } = proj.LowerDistanceParameters();
      const [su, sv, suu, svv, suv] = vs;
      ad.D2(U, Vp, P, su, sv, suu, svv, suv);
      const E = dot(su, su), F = dot(su, sv), G = dot(sv, sv);
      const n = su.Crossed(sv);
      const len = Math.sqrt(dot(n, n));
      const den = E * G - F * F;
      if (len < 1e-12 || den < 1e-18) { n.delete(); continue; }
      const L = dot(suu, n) / len, M = dot(suv, n) / len, N = dot(svv, n) / len;
      n.delete();
      values[i] = kind === "gauss" ? (L * N - M * M) / den : (E * N - 2 * F * M + G * L) / (2 * den);
    }
  }
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  return { kind, values, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
}

/** Ângulo máximo (graus) entre as normais de duas faces ao longo de uma aresta (9 amostras interiores). */
export function maxNormalDeviation(edge: TopoDS_Shape, a: TopoDS_Shape, b: TopoDS_Shape): number {
  let max = 0;
  const pts = sampleEdge(edge, 11).slice(1, -1);
  for (const { p } of pts) {
    try {
      const n1 = normalOnFace(a, p), n2 = normalOnFace(b, p);
      const c = Math.min(1, Math.abs(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
      max = Math.max(max, (Math.acos(c) * 180) / Math.PI);
    } catch { /* ponto fora da superfície: ignorar */ }
  }
  return max;
}

/** Desvio de tangência de cada aresta entre duas faces da cena (análise de desvio). */
export function deviation(scene: NamedBody): DeviationResponse {
  const edges = namedEdges(scene)
    .filter((e) => e.faces.length === 2 && e.faces[0] !== e.faces[1])
    .map((e) => {
      const fa = scene.faces.find((f) => f.name === e.faces[0])!.face, fb = scene.faces.find((f) => f.name === e.faces[1])!.face;
      return { name: e.name, deg: Math.round(maxNormalDeviation(e.edge, fa, fb) * 1000) / 1000 };
    });
  return { edges };
}

/** Limites das classes de continuidade (classe A). */
export const CONTINUITY_LIMITS = { gap: 0.01, deg: 0.1, dk: 0.05, dk3: 0.1 };

/** Direção transversal à aresta que entra na face (tangente à face). */
function inward(face: TopoDS_Shape, p: Vec3, n: Vec3, t: Vec3, eps: number): Vec3 {
  const d = v3.norm(v3.cross(n, t));
  const a = distance(vertexAt(v3.add(p, v3.mul(d, eps))), face), b = distance(vertexAt(v3.add(p, v3.mul(d, -eps))), face);
  return a <= b ? d : v3.mul(d, -1);
}

/**
 * Continuidade nas arestas entre duas faces: folga, ângulo, salto relativo da curvatura normal
 * transversal (G2) e da sua derivada ao atravessar a aresta (G3, por diferenças finitas).
 */
export function continuity(scene: NamedBody): ContinuityResponse {
  const L = CONTINUITY_LIMITS;
  const size = (() => { const b = bbox(scene.shape); return Math.max(1, v3.dist(b.min, b.max)); })();
  const byName = new Map(scene.faces.map((f) => [f.name, f.face]));
  const rel = (a: number, b: number, floor: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), floor);
  const edges = namedEdges(scene)
    .filter((e) => e.faces.length === 2 && e.faces[0] !== e.faces[1])
    .map((e) => {
      const A = byName.get(e.faces[0])!, B = byName.get(e.faces[1])!;
      let gap = 0, deg = 0, dk = 0, dk3 = 0;
      const eps = 1e-3 * size;
      for (const { p, t } of sampleEdge(e.edge, 7).slice(1, -1)) {
        try {
          const a = surfaceAt(A, p), b = surfaceAt(B, p);
          gap = Math.max(gap, v3.dist(a.p, b.p));
          const c = Math.min(1, Math.abs(v3.dot(a.n, b.n)));
          deg = Math.max(deg, (Math.acos(c) * 180) / Math.PI);
          const s = v3.dot(a.n, b.n) < 0 ? -1 : 1;
          const dA = inward(A, p, a.n, t, eps), dB = inward(B, p, b.n, t, eps);
          const kA = a.kn(dA), kB = s * b.kn(dB);
          dk = Math.max(dk, rel(kA, kB, 1e-6));
          // derivada da curvatura ao atravessar a aresta de A para B (s cresce de A para B)
          const a2 = surfaceAt(A, v3.add(p, v3.mul(dA, eps))), b2 = surfaceAt(B, v3.add(p, v3.mul(dB, eps)));
          const gA = (kA - a2.kn(dA)) / eps, gB = (s * b2.kn(dB) - kB) / eps;
          dk3 = Math.max(dk3, rel(gA, gB, 1e-6));
        } catch { /* ponto fora das superfícies */ }
      }
      const cls = gap > L.gap ? -1 : deg > L.deg ? 0 : dk > L.dk ? 1 : dk3 > L.dk3 ? 2 : 3;
      const r = (x: number) => Math.round(x * 1e4) / 1e4;
      return { name: e.name, gap: r(gap), deg: r(deg), dk: r(dk), dk3: r(dk3), cls: cls as -1 | 0 | 1 | 2 | 3 };
    });
  return { edges, limits: L };
}

/**
 * Pentes de curvatura (porcupine) das arestas: em cada amostra, uma cerda no sentido oposto ao
 * centro de curvatura com comprimento proporcional à curvatura; a envolvente liga as pontas.
 * Sem lista de arestas: todas as arestas curvas da cena e as curvas 3D.
 */
export function combs(scene: NamedBody | null, curves: NamedEdge[], names?: string[]): CombsResponse {
  const o = oc();
  const all = [...(scene ? namedEdges(scene) : []), ...curves];
  const pick = names?.length ? all.filter((e) => names.includes(e.name)) : all;
  const P = T(new o.gp_Pnt(0, 0, 0)), V1 = T(new o.gp_Vec(0, 0, 0)), V2 = T(new o.gp_Vec(0, 0, 0));
  const xyz = (v: { X(): number; Y(): number; Z(): number }): Vec3 => [v.X(), v.Y(), v.Z()];
  const samples: { p: Vec3; k: Vec3 }[][] = [];
  let maxK = 0;
  const seen: TopoDS_Shape[] = [];
  for (const e of pick) {
    if (seen.some((x) => x.IsSame(e.edge))) continue;
    seen.push(e.edge);
    const c = T(new o.BRepAdaptor_Curve(T(o.TopoDS.Edge(e.edge))));
    const typeName = Object.entries(o.GeomAbs_CurveType).find(([, v]) => v === c.GetType())?.[0];
    if (typeName === "GeomAbs_Line" && !names?.length) continue;
    const a = c.FirstParameter(), b = c.LastParameter();
    const row: { p: Vec3; k: Vec3 }[] = [];
    const n = 60;
    for (let i = 0; i < n; i++) {
      c.D2(a + ((b - a) * i) / (n - 1), P, V1, V2);
      const d1 = xyz(V1), d2 = xyz(V2);
      const s2 = v3.dot(d1, d1);
      if (s2 < 1e-18) continue;
      const k = v3.mul(v3.sub(d2, v3.mul(d1, v3.dot(d2, d1) / s2)), 1 / s2);
      maxK = Math.max(maxK, v3.len(k));
      row.push({ p: xyz(P), k });
    }
    if (row.length > 1) samples.push(row);
  }
  const box = scene ? bbox(scene.shape) : null;
  const size = box ? Math.max(1, v3.dist(box.min, box.max)) : 100;
  const scale = maxK > 1e-12 ? (0.15 * size) / maxK : 0;
  const q: number[] = [], env: number[] = [];
  for (const row of samples) {
    const tips = row.map(({ p, k }) => v3.sub(p, v3.mul(k, scale)));
    row.forEach(({ p }, i) => q.push(...p, ...tips[i]));
    for (let i = 0; i + 1 < tips.length; i++) env.push(...tips[i], ...tips[i + 1]);
  }
  return { quills: new Float32Array(q), envelope: new Float32Array(env), maxK, scale, edges: samples.length };
}
