// Superfícies ao estilo do CATIA GSD (Fase 4): multi-secção com guias/spine/tangência, concordância
// (blend) G0/G1/G2, varrimento circular, extrapolação, cura (healing) e as opções avançadas de
// varrimento (binormal, suporte, guia, lei de escala).
// As superfícies construídas por amostragem são interpoladas por uma B-spline bicúbica (gridFace);
// a tangência pedida é sempre medida no fim e reportada (nunca é assumida).
import type {
  BlendFeature, BlendSide, CircleSweepFeature, Continuity, CurveRef, ExtrapolateFeature, Feature, HealFeature,
  MultiSectionFeature, SectionTangent, SweepOptions, Vec3,
} from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import {
  type Ctx, type StepReport, axisOf, faces as resolveFaces, edges as resolveEdges, featureName, modelSize, pool, sheetOf,
} from "../context.ts";
import { type NamedBody, type NamedEdge, type NamedFace, nameFresh, namedEdges } from "../naming.ts";
import {
  T, type TopoDS_Face, type TopoDS_Shape, distance, explore, faceProps, gpAx2, gpDir, gridFace, makeCompound,
  normalOnFace, poleRowsFace, oc, outwardDir, sampleEdge, sampleWire, surfaceAt, vertexAt, wireOf,
} from "../occ.ts";
import { maxNormalDeviation } from "../analysis.ts";
import { curveRefEdges } from "./curve.ts";
import { nameFrom } from "./solid.ts";
import {
  add, arcRadius, arcThrough3, bezier, chordParams, closestParam, cross, dist, dot, gordonGrid, hermitePoles, mul, norm,
  reparam, resample, skinGrid, sub,
} from "../../geom/spline.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

/** Amostras ao longo das curvas (direção u) das superfícies amostradas. */
const NU = 41;
const DENSE = 400;

/** Curva de entrada como contorno e poligonal densa. */
function polyOf(ctx: Ctx, c: CurveRef, report: StepReport) {
  const edges = curveRefEdges(ctx, c, report);
  const wire = wireOf(edges.map((e) => e.edge));
  const pts = sampleWire(wire, DENSE);
  const closed = dist(pts[0], pts[pts.length - 1]) < 1e-6 * Math.max(1, dist(pts[0], pts[DENSE >> 1]));
  if (closed) pts[pts.length - 1] = pts[0];
  return { edges, wire, pts, closed };
}

const curveLabel = (ctx: Ctx, c: CurveRef) =>
  c.kind === "curve" ? featureName(ctx, c.feature) : c.kind === "sketch" ? featureName(ctx, c.sketch) : c.ref.name;

/** Normal de uma poligonal fechada (Newell). */
function newell(p: Vec3[]): Vec3 {
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
const rotateClosed = (p: Vec3[], k: number): Vec3[] => { const q = p.slice(0, -1); const r = [...q.slice(k), ...q.slice(0, k)]; r.push(r[0]); return r; };

/** Alinha uma poligonal à de referência: mesmo sentido e, se fechada, costura junto ao início da referência. */
function align(ref: Vec3[], p: Vec3[], closed: boolean): Vec3[] {
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
function nearest(a: Vec3[], b: Vec3[]): { ta: number; tb: number; d: number; p: Vec3 } {
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
const tangentAt = (p: Vec3[], i: number, closed: boolean): Vec3 => {
  const n = p.length;
  const a = i > 0 ? p[i - 1] : closed ? p[n - 2] : p[i];
  const b = i < n - 1 ? p[i + 1] : closed ? p[1] : p[i];
  return norm(sub(b, a));
};

/** Desvio máximo (graus) entre as normais de duas faces nos pontos dados. */
function normalDeviation(a: TopoDS_Shape, b: TopoDS_Shape, pts: Vec3[]): number {
  let max = 0;
  for (const p of pts) {
    try {
      const c = Math.min(1, Math.abs(dot(normalOnFace(a, p), normalOnFace(b, p))));
      max = Math.max(max, (Math.acos(c) * 180) / Math.PI);
    } catch { /* fora da superfície */ }
  }
  return max;
}

function reportTangency(report: StepReport, title: string, rows: [string, number][]) {
  if (!rows.length) return;
  report.info = {
    title,
    rows: rows.map(([k, v]) => [k, `${v.toFixed(2)}°`]),
    note: "Ângulo máximo entre as normais da superfície criada e das faces de suporte, medido em pontos ao longo dos limites. A superfície é uma B-spline que interpola uma grelha de pontos: a continuidade é aproximada e verificada, não exata.",
  };
  for (const [k, v] of rows) if (v > 1) report.warnings.push(`${k}: desvio de tangência de ${v.toFixed(1)}°`);
}

const supportFace = (ctx: Ctx, ref: SectionTangent["face"] | undefined, report: StepReport): TopoDS_Face | null =>
  ref ? resolveFaces(ctx, [ref], report)[0]?.face ?? null : null;

// ---------------------------------------------------------------------------
// Multi-secção
// ---------------------------------------------------------------------------

/** Derivadas ∂S/∂v ao longo de uma secção, tangentes à face de suporte e no sentido de `toward`. */
function tangentField(face: TopoDS_Face, sec: Vec3[], toward: Vec3[], closed: boolean, scale: number, flip: boolean): Vec3[] {
  return sec.map((p, i) => {
    const n = surfaceAt(face, p).n;
    let d = norm(cross(n, tangentAt(sec, i, closed)));
    if (dot(d, sub(toward[i], p)) < 0) d = mul(d, -1);
    return mul(d, (flip ? -1 : 1) * scale);
  });
}

export const multiSection: Step<MultiSectionFeature & Feature> = (ctx, f, report) => {
  if (f.sections.length < 2) throw new Error("A multi-secção precisa de pelo menos 2 secções");
  const secs = f.sections.map((c) => polyOf(ctx, c, report));
  const closed = secs[0].closed;
  if (secs.some((s) => s.closed !== closed)) throw new Error("As secções têm de ser todas abertas ou todas fechadas");
  const guides = (f.guides ?? []).map((c) => ({ ref: c, ...polyOf(ctx, c, report) }));
  const o = oc();
  const start = supportFace(ctx, f.startTangent?.face, report), end = supportFace(ctx, f.endTangent?.face, report);
  const w0 = evalParam(f.startTangent?.weight, ctx.scope, "Tensão inicial", 1);
  const w1 = evalParam(f.endTangent?.weight, ctx.scope, "Tensão final", 1);

  // caminho exato do OCC quando não há guias nem tangências: loft suave ou varrimento pela spine
  if (!guides.length && !start && !end) {
    let shape: TopoDS_Shape;
    if (f.spine) {
      const spine = polyOf(ctx, f.spine, report);
      const mk = T(new o.BRepOffsetAPI_MakePipeShell(o.TopoDS.Wire(spine.wire)));
      mk.SetMode(false);
      for (const s of secs) mk.Add(s.wire, false, false);
      mk.Build();
      if (!mk.IsDone()) throw new Error("A multi-secção pela spine falhou (as secções têm de cortar a spine, pela ordem)");
      shape = T(mk.Shape());
    } else {
      const mk = T(new o.BRepOffsetAPI_ThruSections(false, false, 1e-6));
      for (const s of secs) mk.AddWire(o.TopoDS.Wire(s.wire));
      mk.CheckCompatibility(true);
      mk.Build();
      if (!mk.IsDone()) throw new Error("A multi-secção falhou (secções incompatíveis?)");
      shape = T(mk.Shape());
    }
    ctx.sheets.set(f.id, nameFresh(shape, f.id, () => `${f.id}:ms`));
    return ctx;
  }
  if (f.spine) report.warnings.push("Com guias ou tangências, a spine não é usada: a forma entre secções vem das guias e das tangentes");

  // secções alinhadas (sentido e costura)
  const dense: Vec3[][] = [secs[0].pts];
  for (let i = 1; i < secs.length; i++) dense.push(align(dense[i - 1], secs[i].pts, closed));

  let grid: Vec3[][];
  if (!guides.length) {
    const sec = dense.map((p) => resample(p, NU));
    const centers = sec.map((s) => mul(s.slice(0, closed ? -1 : undefined).reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0] as Vec3), 1 / (closed ? NU - 1 : NU)));
    const v = chordParams(centers);
    const startD = start ? tangentField(start, sec[0], sec[1], closed, w0, !!f.startTangent?.flip) : undefined;
    const last = sec.length - 1;
    const endD = end ? tangentField(end, sec[last], sec[last].map((p, i) => [2 * p[0] - sec[last - 1][i][0], 2 * p[1] - sec[last - 1][i][1], 2 * p[2] - sec[last - 1][i][2]] as Vec3), closed, w1, !!f.endTangent?.flip) : undefined;
    grid = skinGrid({ sections: sec, v, startD, endD }).grid;
  } else {
    grid = gordon(ctx, dense, guides, closed, report, start && { face: start, w: w0, flip: !!f.startTangent?.flip }, end && { face: end, w: w1, flip: !!f.endTangent?.flip });
  }
  const face = gridFace(grid);
  const rows: [string, number][] = [];
  if (start) rows.push(["Tangência na 1.ª secção", normalDeviation(face, start, grid.map((c) => c[0]).filter((_, i) => i % 4 === 2))]);
  if (end) rows.push(["Tangência na última secção", normalDeviation(face, end, grid.map((c) => c[c.length - 1]).filter((_, i) => i % 4 === 2))]);
  reportTangency(report, "Multi-secção", rows);
  ctx.sheets.set(f.id, nameFresh(face, f.id, () => `${f.id}:ms`));
  return ctx;
};

/** Grelha da superfície de Gordon a partir das secções (alinhadas) e das guias. */
function gordon(
  ctx: Ctx, secs: Vec3[][], guidesIn: { ref: CurveRef; pts: Vec3[] }[], closed: boolean, report: StepReport,
  start: { face: TopoDS_Face; w: number; flip: boolean } | null, end: { face: TopoDS_Face; w: number; flip: boolean } | null,
): Vec3[][] {
  const size = modelSize(ctx, secs.flat());
  const tol = 0.01 + 1e-4 * size;
  // interseções secção × guia
  const X = secs.map((s, i) => guidesIn.map((g) => {
    const r = nearest(s, g.pts);
    if (r.d > tol) throw new Error(`A guia "${curveLabel(ctx, g.ref)}" não corta a secção ${i + 1} (distância ${r.d.toFixed(3)} mm)`);
    return r;
  }));
  // secções fechadas: a costura passa a ficar na primeira guia
  if (closed) {
    secs = secs.map((s, i) => {
      const k = Math.round(X[i][0].ta * (s.length - 1));
      const r = rotateClosed(s, Math.min(k, s.length - 2));
      r[0] = r[r.length - 1] = X[i][0].p;
      return r;
    });
    secs.forEach((s, i) => guidesIn.forEach((g, j) => { X[i][j] = { ...X[i][j], ta: j === 0 ? 0 : closestParam(s, X[i][j].p).t }; }));
  }
  // ordem das guias ao longo das secções (igual em todas)
  const order = guidesIn.map((_, j) => j).sort((a, b) => X[0][a].ta - X[0][b].ta);
  for (const row of X) for (let k = 1; k < order.length; k++) {
    if (row[order[k]].ta <= row[order[k - 1]].ta) throw new Error("As guias cruzam-se entre secções (ordem diferente ao longo das secções)");
  }
  const snapU = (t: number) => Math.round(t * (NU - 1)) / (NU - 1);
  const uG = order.map((j) => snapU(X.reduce((a, row) => a + row[j].ta, 0) / X.length));
  if (closed) uG[0] = 0;
  for (let k = 1; k < uG.length; k++) if (uG[k] <= uG[k - 1]) throw new Error("Guias demasiado próximas umas das outras");
  // reparametrização das secções: guia j em u = uG[j]
  const withEnds = (from: number[], to: number[]) => {
    const F = [...from], Tt = [...to];
    if (Tt[0] > 0) { F.unshift(0); Tt.unshift(0); }
    if (Tt[Tt.length - 1] < 1) { F.push(1); Tt.push(1); }
    return [F, Tt];
  };
  const sections = secs.map((s, i) => {
    const [F, Tt] = withEnds(order.map((j) => X[i][j].ta), uG);
    return reparam(s, F, Tt, NU);
  });
  // guias: sentido da 1.ª para a última secção e parâmetros das secções
  const m = secs.length;
  const NV = Math.max(25, 10 * (m - 1) + 1);
  const snapV = (t: number) => Math.round(t * (NV - 1)) / (NV - 1);
  const gPts = order.map((j) => {
    let g = guidesIn[j].pts;
    let s = X.map((row) => closestParam(g, row[j].p).t);
    if (s[m - 1] < s[0]) { g = g.slice().reverse(); s = s.map((x) => 1 - x); }
    for (let i = 1; i < m; i++) if (s[i] <= s[i - 1]) throw new Error(`A guia "${curveLabel(ctx, guidesIn[j].ref)}" não passa pelas secções pela ordem dada`);
    return { g, s };
  });
  const vS = Array.from({ length: m }, (_, i) => snapV(gPts.reduce((a, x) => a + (x.s[i] - x.s[0]) / (x.s[m - 1] - x.s[0]), 0) / gPts.length));
  for (let i = 1; i < m; i++) if (vS[i] <= vS[i - 1]) throw new Error("Secções demasiado próximas umas das outras");
  const guides = gPts.map(({ g, s }) => reparam(g, s, vS, NV));
  // tangências: derivada por unidade de v (normalizado) = tensão × comprimento médio das guias
  const span = guides.reduce((a, g) => a + chordParams(g)[NV - 1], 0) / guides.length;
  const startD = start ? tangentField(start.face, sections[0], sections[1], closed, start.w * span, start.flip) : undefined;
  const endD = end ? tangentField(end.face, sections[m - 1], sections[m - 1].map((p, i) => sub(mul(p, 2), sections[m - 2][i])), closed, end.w * span, end.flip) : undefined;
  if ((start || end) && guides.length) report.warnings.push("Com guias, a tangência só é exata se as guias também forem tangentes às faces de suporte");
  return gordonGrid({ sections, guides, uG, vS, closedU: closed, startD, endD });
}

// ---------------------------------------------------------------------------
// Concordância (blend)
// ---------------------------------------------------------------------------

/** Face de suporte de um lado da concordância: a indicada ou a face única da aresta. */
function blendSupport(ctx: Ctx, side: BlendSide, edges: NamedEdge[], report: StepReport): TopoDS_Face | null {
  if (side.support) return resolveFaces(ctx, [side.support], report)[0]?.face ?? null;
  if (side.continuity === "contact") return null;
  const names = new Set(edges.flatMap((e) => e.faces));
  if (side.curve.kind !== "edge" || names.size !== 1) throw new Error("Escolha a face de suporte (a curva não é uma aresta livre de uma só face)");
  const all = pool(ctx);
  return all.faces.find((x) => names.has(x.name))?.face ?? null;
}

/** Direção de saída da face de suporte ao longo da curva (sentido coerente, decidido a meio da curva). */
function outwardField(face: TopoDS_Face, pts: Vec3[], closed: boolean, eps: number, flip: boolean): Vec3[] {
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

export const blend: Step<BlendFeature & Feature> = (ctx, f, report) => {
  const A = polyOf(ctx, f.side1.curve, report), B = polyOf(ctx, f.side2.curve, report);
  if (A.closed !== B.closed) throw new Error("As duas curvas têm de ser ambas abertas ou ambas fechadas");
  const closed = A.closed;
  const a = resample(A.pts, NU);
  const b = resample(align(A.pts, B.pts, closed), NU);
  const sides = [
    { s: f.side1, pts: a, edges: A.edges, other: b, sign: 1 },
    { s: f.side2, pts: b, edges: B.edges, other: a, sign: -1 },
  ].map((x) => {
    const support = blendSupport(ctx, x.s, x.edges, report);
    const cont: Continuity = support ? x.s.continuity : "contact";
    if (x.s.continuity !== "contact" && !support) report.warnings.push("Sem face de suporte: só contacto");
    const tension = evalParam(x.s.tension, ctx.scope, "Tensão", 1);
    const eps = 1e-3 * Math.max(1, chordParams(x.pts)[NU - 1]);
    const dirs = support && cont !== "contact" ? outwardField(support, x.pts, closed, eps, !!x.s.flip) : null;
    return { ...x, support, cont, tension, dirs };
  });
  // polos de Hermite por amostra: G1 = cúbica; G2 = quíntica com a curvatura normal do suporte
  const poles = a.map((_, i) => {
    const chord = dist(a[i], b[i]);
    const ends = sides.map((x) => {
      if (!x.dirs || !x.support) return { p: x.pts[i] };
      const d = mul(x.dirs[i], x.sign * x.tension * chord);
      if (x.cont !== "curvature") return { p: x.pts[i], d };
      const loc = surfaceAt(x.support, x.pts[i]);
      return { p: x.pts[i], d, dd: mul(loc.n, loc.kn(x.dirs[i]) * (x.tension * chord) ** 2) };
    });
    return hermitePoles(ends[0], ends[1]);
  });
  const face = poleRowsFace(poles[0].map((_, k) => poles.map((p) => p[k])));
  const NV = 21;
  const grid = poles.map((p) => Array.from({ length: NV }, (_, k) => bezier(p, k / (NV - 1))));
  const rows: [string, number][] = [];
  sides.forEach((x, k) => {
    if (!x.support || x.cont === "contact") return;
    const line = grid.map((c) => c[k === 0 ? 0 : NV - 1]).filter((_, i) => i % 4 === 2);
    rows.push([`Tangência no lado ${k + 1}`, normalDeviation(face, x.support, line)]);
  });
  reportTangency(report, "Concordância", rows);
  ctx.sheets.set(f.id, nameFresh(face, f.id, () => `${f.id}:blend`));
  return ctx;
};

// ---------------------------------------------------------------------------
// Varrimento circular
// ---------------------------------------------------------------------------

export const circleSweep: Step<CircleSweepFeature & Feature> = (ctx, f, report) => {
  const need = { threeGuides: 3, twoGuidesRadius: 2, centerRadius: 1 }[f.mode];
  if (f.guides.length !== need) throw new Error(`Este modo precisa de ${need} curva(s)`);
  const o = oc();
  if (f.mode === "centerRadius") {
    // tubo: círculo exato varrido pela curva central (perfil normal ao início da curva)
    const r = evalParam(f.radius, ctx.scope, "Raio");
    if (r <= 0) throw new Error("Raio: tem de ser positivo");
    const c = polyOf(ctx, f.guides[0], report);
    const t0 = tangentAt(c.pts, 0, c.closed);
    const x0 = norm(cross(t0, Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const circ = T(new o.gp_Circ(gpAx2(c.pts[0], t0, x0), r));
    const prof = T(T(new o.BRepBuilderAPI_MakeWire(T(T(new o.BRepBuilderAPI_MakeEdge(circ)).Edge()))).Wire());
    const mk = T(new o.BRepOffsetAPI_MakePipeShell(o.TopoDS.Wire(c.wire)));
    mk.SetMode(false);
    mk.Add(prof, false, false);
    mk.Build();
    if (!mk.IsDone()) throw new Error("O tubo falhou (raio maior que o raio de curvatura da curva central?)");
    ctx.sheets.set(f.id, nameFresh(T(mk.Shape()), f.id, () => `${f.id}:circ`));
    return ctx;
  }
  const polys = f.guides.map((g) => polyOf(ctx, g, report));
  if (polys.some((p) => p.closed !== polys[0].closed)) throw new Error("As guias têm de ser todas abertas ou todas fechadas");
  const g = polys.map((p, k) => resample(k === 0 ? p.pts : align(polys[0].pts, p.pts, p.closed), NU));
  const NV = 25;
  let grid: Vec3[][];
  if (f.mode === "threeGuides") {
    grid = g[0].map((_, i) => arcThrough3(g[0][i], g[1][i], g[2][i], NV));
  } else {
    const r = evalParam(f.radius, ctx.scope, "Raio");
    if (r <= 0) throw new Error("Raio: tem de ser positivo");
    grid = g[0].map((p, i) => {
      // plano do arco: normal = tangente da 1.ª guia sem a componente da corda
      const e = norm(sub(g[1][i], p));
      const t = tangentAt(g[0], i, polys[0].closed);
      const n = norm(sub(t, mul(e, dot(t, e))));
      const arc = arcRadius(p, g[1][i], r, n, NV, f.flip ? -1 : 1, !!f.long);
      if (!arc) throw new Error(`As guias distam mais de 2 × raio (${dist(p, g[1][i]).toFixed(2)} mm num ponto)`);
      return arc;
    });
  }
  ctx.sheets.set(f.id, nameFresh(gridFace(grid), f.id, () => `${f.id}:circ`));
  return ctx;
};

// ---------------------------------------------------------------------------
// Opções avançadas de varrimento
// ---------------------------------------------------------------------------

/** Configura a orientação do perfil e acrescenta-o, com a lei de escala, a um varrimento. */
export function setupPipe(ctx: Ctx, mk: InstanceType<ReturnType<typeof oc>["BRepOffsetAPI_MakePipeShell"]>, opts: SweepOptions, profile: TopoDS_Shape, report: StepReport) {
  const o = oc();
  switch (opts.orientation ?? "frenet") {
    case "frenet": mk.SetMode(true); break;
    case "fixed": mk.SetMode(false); break;
    case "binormal": {
      if (!opts.binormal) throw new Error("Escolha a direção da binormal");
      mk.SetMode(gpDir(axisOf(ctx, opts.binormal, report).d));
      break;
    }
    case "support": {
      const fs = resolveFaces(ctx, opts.support ?? [], report);
      if (!fs.length) throw new Error("Escolha as faces de suporte do caminho");
      const sup = fs.length === 1 ? fs[0].face : makeCompound(fs.map((x) => x.face));
      if (!mk.SetMode(sup)) throw new Error("O caminho não está sobre as faces de suporte (use uma curva projetada nelas)");
      break;
    }
    case "guide": {
      if (!opts.guide) throw new Error("Escolha a curva guia");
      const gw = wireOf(curveRefEdges(ctx, opts.guide, report).map((e) => e.edge));
      const C = o.BRepFill_TypeOfContact;
      const mode = opts.guideMode === "contact" ? C.BRepFill_Contact : opts.guideMode === "border" ? C.BRepFill_ContactOnBorder : C.BRepFill_NoContact;
      mk.SetMode(o.TopoDS.Wire(gw), true, mode);
      break;
    }
  }
  const scale = evalParam(opts.scale, ctx.scope, "Escala final", 1);
  if (scale <= 0) throw new Error("Escala final: tem de ser positiva");
  if (Math.abs(scale - 1) > 1e-9) {
    // lei homotética no parâmetro normalizado do caminho (0 → 1)
    const law = T(opts.scaleLaw === "s" ? new o.Law_S() : new o.Law_Linear());
    law.Set(0, 1, 1, scale);
    mk.SetLaw(profile, law, false, false);
  } else mk.Add(profile, false, false);
}

// ---------------------------------------------------------------------------
// Extrapolar
// ---------------------------------------------------------------------------

export const extrapolate: Step<ExtrapolateFeature & Feature> = (ctx, f, report) => {
  const sheet = sheetOf(ctx, f.sheet);
  const L = evalParam(f.length, ctx.scope, "Comprimento");
  if (L <= 0) throw new Error("Comprimento: tem de ser positivo");
  const es = resolveEdges(ctx, f.edges, report);
  if (!es.length) throw new Error("Escolha as arestas livres a extrapolar");
  const free = new Map(namedEdges(sheet).filter((e) => e.faces.length === 1).map((e) => [e.name, e]));
  const ext = es.map((e) => {
    const own = [...free.values()].find((x) => x.edge.IsSame(e.edge));
    if (!own) throw new Error(`A aresta "${e.name}" não é uma aresta livre de "${featureName(ctx, f.sheet)}"`);
    const support = sheet.faces.find((x) => x.name === own.faces[0])!.face;
    const smp = sampleEdge(e.edge, NU);
    const pts = smp.map((s) => s.p);
    const closed = dist(pts[0], pts[NU - 1]) < 1e-7;
    const dirs = outwardField(support, pts, closed, 1e-3 * Math.max(L, 1), false);
    // extensão exata em v: reta (tangente) ou parábola osculadora (curvatura) como Bézier de grau 1/2,
    // com o comprimento medido ao longo da extensão (s + κ²s³/6 = L)
    const rowsOf = pts.map((p, i) => {
      if (f.continuity !== "curvature") return [p, add(p, mul(dirs[i], L))];
      const loc = surfaceAt(support, p);
      const k = loc.kn(dirs[i]);
      let sm = L;
      for (let it = 0; it < 20; it++) sm -= (sm + (k * k * sm ** 3) / 6 - L) / (1 + (k * k * sm * sm) / 2);
      const P1 = add(p, mul(dirs[i], sm / 2));
      return [p, P1, add(add(p, mul(dirs[i], sm)), mul(loc.n, (k * sm * sm) / 2))];
    });
    const face = poleRowsFace(rowsOf[0].map((_, k) => rowsOf.map((r) => r[k])));
    return { face, name: `${f.id}:ext{${e.name}}`, support, line: pts.filter((_, i) => i % 5 === 2) };
  });
  if (ext.length > 1) report.warnings.push("Nos cantos entre extensões de arestas diferentes pode ficar uma folga (como no GSD): feche-a com um preenchimento");
  reportTangency(report, "Extrapolação", ext.map((x) => [`Tangência em "${x.name}"`, normalDeviation(x.face, x.support, x.line)]));
  if (f.assemble === false) {
    ctx.sheets.set(f.id, nameFrom(ext.length === 1 ? ext[0].face : makeCompound(ext.map((x) => x.face)), f.id, ext));
    return ctx;
  }
  const sewn = sewFaces([...sheet.faces.map((x) => x.face), ...ext.map((x) => x.face)], 1e-3 + 1e-5 * L);
  const known = [...sheet.faces.map((x) => ({ face: sewn.map(x.face), name: x.name })), ...ext.map((x) => ({ face: sewn.map(x.face), name: x.name }))];
  ctx.sheets.set(f.sheet, nameFrom(sewn.shape, f.id, known));
  return ctx;
};

/** Costura de faces soltas (com o mapa face original → face costurada). */
export function sewFaces(shapes: TopoDS_Shape[], tol: number) {
  const s = T(new (oc().BRepBuilderAPI_Sewing)(tol, true, true, true, false));
  for (const x of shapes) s.Add(x);
  s.Perform();
  const shape = T(s.SewedShape());
  if (shape.IsNull()) throw new Error("A costura não produziu nenhuma forma");
  const map = (face: TopoDS_Shape) => (s.IsModifiedSubShape(face) ? T(s.ModifiedSubShape(face)) : s.IsModified(face) ? T(s.Modified(face)) : face);
  return { shape, map, freeEdges: s.NbFreeEdges() as number };
}

// ---------------------------------------------------------------------------
// Juntar / curar
// ---------------------------------------------------------------------------

/** Une faces da mesma superfície; cada face nova herda o nome de uma das originais que contém. */
export function simplifyBody(body: NamedBody, fid: string): NamedBody {
  const o = oc();
  const u = T(new o.ShapeUpgrade_UnifySameDomain(body.shape, true, true, false));
  u.Build();
  const shape = T(u.Shape());
  const known = body.faces.map((nf) => ({ v: vertexAt(faceProps(nf.face).center), name: nf.name }));
  const res = nameFrom(shape, fid, explore(shape, "face").flatMap((face) => {
    const hit = known.find((k) => distance(k.v, face) < 1e-6);
    return hit ? [{ face: face as TopoDS_Shape, name: hit.name }] : [];
  }));
  return res;
}

/** Arestas costuradas (entre duas faces) e o seu desvio de tangência em graus. */
export function seamDeviations(body: NamedBody): { name: string; deg: number }[] {
  const byName = new Map(body.faces.map((x) => [x.name, x.face]));
  return namedEdges(body)
    .filter((e) => e.faces.length === 2 && e.faces[0] !== e.faces[1])
    .map((e) => ({ name: e.name, deg: maxNormalDeviation(e.edge, byName.get(e.faces[0])!, byName.get(e.faces[1])!) }));
}

/** Número de partes ligadas (cascas/faces soltas) de uma forma costurada. */
export function connectedParts(shape: TopoDS_Shape): number {
  const shells = explore(shape, "shell");
  const inShells = new Set<number>();
  const faces = explore(shape, "face");
  faces.forEach((f, i) => { if (shells.some((sh) => explore(sh, "face").some((x) => x.IsSame(f)))) inShells.add(i); });
  return shells.length + faces.length - inShells.size;
}

export const heal: Step<HealFeature & Feature> = (ctx, f, report) => {
  if (!f.sheets.length) throw new Error("Escolha os corpos de superfície a curar");
  const inputs = f.sheets.map((id) => sheetOf(ctx, id));
  const d = evalParam(f.distance, ctx.scope, "Distância de fusão");
  if (d <= 0) throw new Error("Distância de fusão: tem de ser positiva");
  const tang = evalParam(f.tangency, ctx.scope, "Ângulo de tangência", 0.5);
  const o = oc();
  // correção de cada face (contornos, orientação, costuras em falta)
  const fixed: NamedFace[] = inputs.flatMap((b) => b.faces.map((nf) => {
    const fx = T(new o.ShapeFix_Face(nf.face));
    fx.Perform();
    return { ...nf, face: T(fx.Face()) };
  }));
  const before = sewFaces(fixed.map((x) => x.face), 1e-7).freeEdges;
  const sewn = sewFaces(fixed.map((x) => x.face), d);
  let body = nameFrom(sewn.shape, f.id, fixed.map((nf) => ({ face: sewn.map(nf.face), name: nf.name })));
  if (f.simplify) body = simplifyBody(body, f.id);
  const devs = seamDeviations(body);
  const near = devs.filter((x) => x.deg > 0.05 && x.deg < tang);
  report.info = {
    title: "Cura",
    rows: [
      ["Arestas livres antes", String(before)],
      ["Arestas livres depois", String(sewn.freeEdges)],
      ["Partes ligadas", String(connectedParts(body.shape))],
      ["Arestas quase tangentes", String(near.length)],
      ["Desvio máx. nas arestas costuradas", `${Math.max(0, ...devs.map((x) => x.deg)).toFixed(2)}°`],
    ],
    note: `Folgas até ${d} mm fechadas por costura; faces corrigidas pelo ShapeFix. As arestas "quase tangentes" (entre 0,05° e ${tang}°) são só assinaladas: a cura não deforma as superfícies para repor a tangência.`,
  };
  for (const x of near.slice(0, 5)) report.warnings.push(`Aresta "${x.name}" quase tangente (${x.deg.toFixed(2)}°)`);
  for (const id of f.sheets) ctx.sheets.delete(id);
  ctx.sheets.set(f.id, body);
  return ctx;
};
