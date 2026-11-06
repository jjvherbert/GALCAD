// GSD: concordância (blend) G0/G1/G2, varrimento circular e opções avançadas de varrimento.
import { type BlendFeature, type BlendSide, type CircleSweepFeature, type Continuity, type Feature, type SweepOptions, type Vec3 } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type StepReport, axisOf, faces as resolveFaces, pool } from "../context.ts";
import { type NamedEdge, nameFresh } from "../naming.ts";
import { T, gpAx2, gpDir, gridFace, makeCompound, poleRowsFace, oc, surfaceAt, wireOf, type TopoDS_Face, type TopoDS_Shape } from "../occ.ts";
import { curveRefEdges } from "./curve.ts";
import { arcRadius, arcThrough3, bezier, chordParams, cross, dist, dot, hermitePoles, mul, norm, resample, sub } from "../../geom/spline.ts";
import { type Step, NU, polyOf, align, tangentAt, normalDeviation, reportTangency, outwardField } from "./gsd-common.ts";

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
