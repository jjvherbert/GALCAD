// GSD: tipos e auxiliares partilhados (curvas amostradas, alinhamento, tangências).
import { type CurveRef, type SectionTangent, type Vec3 } from "../../doc/types.ts";
import { type Ctx, type StepReport, faces as resolveFaces, featureName } from "../context.ts";
import { type TopoDS_Face, type TopoDS_Shape, normalOnFace, outwardDir, sampleWire, surfaceAt, wireOf } from "../occ.ts";
import { curveRefEdges } from "./curve.ts";
import { closestParam, cross, dist, dot, mul, norm, resample, sub } from "../../geom/spline.ts";

export type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

/** Amostras ao longo das curvas (direção u) das superfícies amostradas. */
export const NU = 41;
export const DENSE = 400;

/** Curva de entrada como contorno e poligonal densa. */
export function polyOf(ctx: Ctx, c: CurveRef, report: StepReport) {
  const edges = curveRefEdges(ctx, c, report);
  const wire = wireOf(edges.map((e) => e.edge));
  const pts = sampleWire(wire, DENSE);
  const closed = dist(pts[0], pts[pts.length - 1]) < 1e-6 * Math.max(1, dist(pts[0], pts[DENSE >> 1]));
  if (closed) pts[pts.length - 1] = pts[0];
  return { edges, wire, pts, closed };
}

export const curveLabel = (ctx: Ctx, c: CurveRef) =>
  c.kind === "curve" ? featureName(ctx, c.feature) : c.kind === "sketch" ? featureName(ctx, c.sketch) : c.ref.name;

/** Normal de uma poligonal fechada (Newell). */
export function newell(p: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm(n);
}

/** Roda uma poligonal fechada para começar no índice k (mantém o fecho). */
export const rotateClosed = (p: Vec3[], k: number): Vec3[] => { const q = p.slice(0, -1); const r = [...q.slice(k), ...q.slice(0, k)]; r.push(r[0]); return r; };

/** Alinha uma poligonal à de referência: mesmo sentido e, se fechada, costura junto ao início da referência. */
export function align(ref: Vec3[], p: Vec3[], closed: boolean): Vec3[] {
  if (!closed) {
    const same = dist(ref[0], p[0]) + dist(ref[ref.length - 1], p[p.length - 1]);
    const rev = dist(ref[0], p[p.length - 1]) + dist(ref[ref.length - 1], p[0]);
    return rev < same ? p.slice().reverse() : p;
  }
  let q = dot(newell(ref), newell(p)) < 0 ? p.slice().reverse() : p;
  let k = 0, best = Infinity;
  for (let i = 0; i + 1 < q.length; i++) { const d = dist(q[i], ref[0]); if (d < best) { best = d; k = i; } }
  q = rotateClosed(q, k);
  return q;
}

/** Ponto de duas poligonais mais próximo entre si: parâmetros normalizados em cada uma e distância. */
export function nearest(a: Vec3[], b: Vec3[]): { ta: number; tb: number; d: number; p: Vec3 } {
  let best = { ta: 0, tb: 0, d: Infinity, p: a[0] };
  const step = Math.max(1, Math.floor(b.length / 200));
  for (let k = 0; k < b.length; k += step) {
    const c = closestParam(a, b[k]);
    if (c.d < best.d) best = { ta: c.t, tb: k / (b.length - 1), d: c.d, p: b[k] };
  }
  // refinar: projetar o ponto de a de volta em b e de novo em a
  for (let it = 0; it < 3; it++) {
    const pa = resample(a, 2001)[Math.round(best.ta * 2000)];
    const cb = closestParam(b, pa);
    const pb = resample(b, 2001)[Math.round(cb.t * 2000)];
    const ca = closestParam(a, pb);
    best = { ta: ca.t, tb: cb.t, d: ca.d, p: pb };
  }
  return best;
}

/** Tangente (unitária) de uma poligonal no índice i. */
export const tangentAt = (p: Vec3[], i: number, closed: boolean): Vec3 => {
  const n = p.length;
  const a = i > 0 ? p[i - 1] : closed ? p[n - 2] : p[i];
  const b = i < n - 1 ? p[i + 1] : closed ? p[1] : p[i];
  return norm(sub(b, a));
};

/** Desvio máximo (graus) entre as normais de duas faces nos pontos dados. */
export function normalDeviation(a: TopoDS_Shape, b: TopoDS_Shape, pts: Vec3[]): number {
  let max = 0;
  for (const p of pts) {
    try {
      const c = Math.min(1, Math.abs(dot(normalOnFace(a, p), normalOnFace(b, p))));
      max = Math.max(max, (Math.acos(c) * 180) / Math.PI);
    } catch { /* fora da superfície */ }
  }
  return max;
}

export function reportTangency(report: StepReport, title: string, rows: [string, number][]) {
  if (!rows.length) return;
  report.info = {
    title,
    rows: rows.map(([k, v]) => [k, `${v.toFixed(2)}°`]),
    note: "Ângulo máximo entre as normais da superfície criada e das faces de suporte, medido em pontos ao longo dos limites. A superfície é uma B-spline que interpola uma grelha de pontos: a continuidade é aproximada e verificada, não exata.",
  };
  for (const [k, v] of rows) if (v > 1) report.warnings.push(`${k}: desvio de tangência de ${v.toFixed(1)}°`);
}

export const supportFace = (ctx: Ctx, ref: SectionTangent["face"] | undefined, report: StepReport): TopoDS_Face | null =>
  ref ? resolveFaces(ctx, [ref], report)[0]?.face ?? null : null;

/** Direção de saída da face de suporte ao longo da curva (sentido coerente, decidido a meio da curva). */
export function outwardField(face: TopoDS_Face, pts: Vec3[], closed: boolean, eps: number, flip: boolean): Vec3[] {
  const mid = pts.length >> 1;
  const ref = outwardDir(face, pts[mid], tangentAt(pts, mid, closed), eps);
  const out: Vec3[] = new Array(pts.length);
  const at = (i: number, prev: Vec3) => {
    let d = norm(cross(surfaceAt(face, pts[i]).n, tangentAt(pts, i, closed)));
    if (dot(d, prev) < 0) d = mul(d, -1);
    return d;
  };
  out[mid] = ref;
  for (let i = mid + 1; i < pts.length; i++) out[i] = at(i, out[i - 1]);
  for (let i = mid - 1; i >= 0; i--) out[i] = at(i, out[i + 1]);
  return flip ? out.map((d) => mul(d, -1)) : out;
}
