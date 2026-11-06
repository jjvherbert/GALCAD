// GSD: multi-secção (loft/spine exatos, ou grelha de Gordon com guias e tangências).
import { type CurveRef, type Feature, type MultiSectionFeature, type Vec3 } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type StepReport, modelSize } from "../context.ts";
import { nameFresh } from "../naming.ts";
import { T, gridFace, oc, surfaceAt, type TopoDS_Face, type TopoDS_Shape } from "../occ.ts";
import { chordParams, closestParam, cross, dot, gordonGrid, mul, norm, reparam, resample, skinGrid, sub } from "../../geom/spline.ts";
import { type Step, NU, polyOf, curveLabel, rotateClosed, align, nearest, tangentAt, normalDeviation, reportTangency, supportFace } from "./gsd-common.ts";

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
