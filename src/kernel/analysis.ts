// Análises de superfície no núcleo: curvatura exata em cada vértice da malha de visualização.
// Para cada vértice: projeção na superfície da face → (u, v) → derivadas até à 2.ª ordem →
// formas fundamentais → curvatura gaussiana K = (LN − M²)/(EG − F²) e média H = (EN − 2FM + GL)/(2(EG − F²)).
import type { CurvatureKind, CurvatureResponse } from "./protocol.ts";
import type { MeshData } from "./mesh.ts";
import type { NamedBody } from "./naming.ts";
import { T, faceProps, oc } from "./occ.ts";

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
