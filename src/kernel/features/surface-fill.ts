// Preenchimento, fronteira e regrada: superfícies a partir de arestas.
import type { BoundaryFeature, Continuity, Feature, FillFeature, RuledSurfaceFeature, Vec3 } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type StepReport, axisOf, edges as resolveEdges, faces as resolveFaces, pool } from "../context.ts";
import { type NamedEdge, type NamedFace, nameFresh } from "../naming.ts";
import { maxNormalDeviation } from "../analysis.ts";
import { T, type TopoDS_Face, type TopoDS_Shape, edgeProps, explore, faceProps, gpVec, interpolateEdge, makeWire, normalOnFace, oc, sampleEdge, v3 } from "../occ.ts";
import { nameFrom } from "./solid.ts";
import { curveRefEdges } from "./curve.ts";
import { type Step, sew } from "./surface-common.ts";

/**
 * As arestas formam um contorno fechado? Cada extremidade tem de coincidir (geometricamente, com
 * tolerância) com exatamente outra: as arestas podem vir de corpos e curvas diferentes.
 */
function isClosedLoop(es: TopoDS_Shape[], tol = 1e-4): boolean {
  const ends: Vec3[] = [];
  for (const e of es) {
    const vs = explore(e, "vertex");
    if (vs.length === 1) continue; // aresta fechada (círculo)
    const p = edgeProps(e);
    ends.push(p.start, p.end);
  }
  if (!ends.length) return es.length === 1;
  return ends.every((p, i) => ends.filter((q, j) => j !== i && v3.dist(p, q) < tol).length === 1);
}

/** Restrição de um preenchimento: aresta, se é limite, e a continuidade pedida com a face vizinha. */
interface FillConstraint { edge: NamedEdge; bound: boolean; continuity: Continuity }

/**
 * Preenchimento (placa) com as arestas dadas. Devolve a face e o desvio de tangência máximo (graus)
 * medido ao longo das arestas com continuidade tangente/curvatura (verificação automática de G1).
 */
export function plate(ctx: Ctx, cons: FillConstraint[], report: StepReport): { shape: TopoDS_Shape; deviation: number | null } {
  const o = oc();
  const S = o.GeomAbs_Shape;
  const ORDER = { contact: S.GeomAbs_C0, tangent: S.GeomAbs_G1, curvature: S.GeomAbs_G2 };
  const all = ctx.body || ctx.sheets.size ? pool(ctx) : { faces: [] as NamedFace[] };
  const mk = T(new o.BRepOffsetAPI_MakeFilling());
  const checks: { edge: TopoDS_Shape; support: TopoDS_Face }[] = [];
  for (const c of cons) {
    const support = c.continuity === "contact" ? undefined : all.faces.find((x) => c.edge.faces.includes(x.name));
    if (support) { mk.Add(c.edge.edge, support.face, ORDER[c.continuity], c.bound); checks.push({ edge: c.edge.edge, support: support.face }); }
    else {
      if (c.continuity !== "contact") report.warnings.push(`Aresta "${c.edge.name}" sem face vizinha: só contacto`);
      mk.Add(c.edge.edge, S.GeomAbs_C0, c.bound);
    }
  }
  try {
    mk.Build();
  } catch {
    throw new Error("O preenchimento falhou (contorno demasiado complexo?)");
  }
  if (!mk.IsDone()) throw new Error("O preenchimento falhou");
  const shape = T(mk.Shape());
  const face = explore(shape, "face")[0];
  let deviation: number | null = null;
  if (face && checks.length) {
    deviation = 0;
    for (const ch of checks) deviation = Math.max(deviation, maxNormalDeviation(ch.edge, face, ch.support));
  }
  return { shape, deviation };
}

/** Informação e aviso da verificação de tangência de um preenchimento. */
export function reportDeviation(report: StepReport, title: string, dev: number | null) {
  if (dev === null) return;
  report.info = { title, rows: [["Desvio de tangência máx.", `${dev.toFixed(2)}°`]], note: "Ângulo máximo entre as normais do remendo e das faces vizinhas ao longo das arestas com tangência/curvatura pedida (amostragem em 9 pontos por aresta)." };
  if (dev > 1) report.warnings.push(`A tangência não é cumprida: desvio de ${dev.toFixed(1)}° (face vizinha quase perpendicular?)`);
}

export const fill: Step<FillFeature & Feature> = (ctx, f, report) => {
  const es = resolveEdges(ctx, f.edges, report);
  if (!es.length) throw new Error("Escolha as arestas do contorno a preencher");
  if (!isClosedLoop(es.map((e) => e.edge))) throw new Error("As arestas não formam um contorno fechado");
  const { shape, deviation } = plate(ctx, es.map((edge) => ({ edge, bound: true, continuity: f.continuity })), report);
  reportDeviation(report, "Preenchimento", deviation);
  ctx.sheets.set(f.id, nameFresh(shape, f.id, () => `${f.id}:fill`));
  return ctx;
};

export const boundary: Step<BoundaryFeature & Feature> = (ctx, f, report) => {
  const d1 = f.dir1.map((c) => curveRefEdges(ctx, c, report));
  const d2 = f.dir2.map((c) => curveRefEdges(ctx, c, report));
  if (d1.length < 2) throw new Error("A direção 1 precisa de pelo menos 2 curvas");
  if (d2.length === 1) throw new Error("A direção 2 precisa de 0 ou de pelo menos 2 curvas");
  if (!d2.length) {
    // só uma direção: superfície suave pelas curvas (loft de superfície)
    const mk = T(new (oc().BRepOffsetAPI_ThruSections)(false, false, 1e-6));
    for (const es of d1) {
      const w = es.length === 1 ? T(T(new (oc().BRepBuilderAPI_MakeWire)(oc().TopoDS.Edge(es[0].edge))).Wire()) : makeWire(es.map((e) => e.edge));
      if (!w) throw new Error("Uma das curvas não é contínua");
      mk.AddWire(oc().TopoDS.Wire(w));
    }
    mk.CheckCompatibility(false);
    mk.Build();
    if (!mk.IsDone()) throw new Error("A superfície limite falhou (curvas incompatíveis?)");
    if ((f.cont1 ?? "contact") !== "contact") report.warnings.push("Só com a direção 1 a tangência nos limites não é aplicada; acrescente curvas na direção 2");
    ctx.sheets.set(f.id, nameFresh(T(mk.Shape()), f.id, () => `${f.id}:bnd`));
    return ctx;
  }
  const c1 = f.cont1 ?? "contact", c2 = f.cont2 ?? "contact";
  const bounds = [...d1[0], ...d1.at(-1)!, ...d2[0], ...d2.at(-1)!];
  if (!isClosedLoop(bounds.map((e) => e.edge))) throw new Error("As curvas-limite (primeira e última de cada direção) não formam um contorno fechado: as extremidades têm de coincidir");
  const cons: FillConstraint[] = [
    ...[d1[0], d1.at(-1)!].flat().map((edge) => ({ edge, bound: true, continuity: c1 })),
    ...[d2[0], d2.at(-1)!].flat().map((edge) => ({ edge, bound: true, continuity: c2 })),
    ...[...d1.slice(1, -1), ...d2.slice(1, -1)].flat().map((edge) => ({ edge, bound: false, continuity: "contact" as Continuity })),
  ];
  const { shape, deviation } = plate(ctx, cons, report);
  reportDeviation(report, "Superfície limite", deviation);
  ctx.sheets.set(f.id, nameFresh(shape, f.id, () => `${f.id}:bnd`));
  return ctx;
};

export const ruled: Step<RuledSurfaceFeature & Feature> = (ctx, f, report) => {
  const es = resolveEdges(ctx, f.edges, report);
  if (!es.length) throw new Error("Escolha as arestas");
  const dist = evalParam(f.distance, ctx.scope, "Distância") * (f.flip ? -1 : 1);
  if (Math.abs(dist) < 1e-9) throw new Error("Distância: não pode ser nula");
  const ang = (evalParam(f.angle, ctx.scope, "Ângulo", 45) * Math.PI) / 180;
  const all = pool(ctx);
  const o = oc();
  const parts = es.map((e) => {
    let shape: TopoDS_Shape;
    if (f.mode === "direction") {
      if (!f.direction) throw new Error("Escolha a direção");
      const d = axisOf(ctx, f.direction, report).d;
      shape = T(T(new o.BRepPrimAPI_MakePrism(e.edge, gpVec(v3.mul(d, dist)), false, true)).Shape());
    } else {
      const ref = f.face ? resolveFaces(ctx, [f.face], report)[0] : undefined;
      if (!ref && e.faces.length > 1) throw new Error(`A aresta "${e.name}" está entre duas faces: escolha a face de referência`);
      const support = ref ?? all.faces.find((x) => e.faces.includes(x.name));
      if (!support) throw new Error(`A aresta "${e.name}" não tem face vizinha (use o modo direção)`);
      const fc = faceProps(support.face).center;
      const pts = sampleEdge(e.edge, 24).map(({ p, t }) => {
        const n = normalOnFace(support.face, p);
        let d = n;
        if (f.mode === "tangent" || f.mode === "angle") {
          d = v3.norm([t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]]);
          // tangente à face, para fora dela
          if (v3.dot(d, v3.sub(fc, p)) > 0) d = v3.mul(d, -1);
          // a um ângulo da face, rodando da tangente para a normal
          if (f.mode === "angle") d = v3.add(v3.mul(d, Math.cos(ang)), v3.mul(n, Math.sin(ang)));
        }
        return v3.add(p, v3.mul(d, dist));
      });
      const closed = v3.dist(pts[0], pts.at(-1)!) < 1e-7;
      const other = interpolateEdge(closed ? pts.slice(0, -1) : pts, closed);
      const mk = T(new o.BRepOffsetAPI_ThruSections(false, true, 1e-6));
      mk.AddWire(T(T(new o.BRepBuilderAPI_MakeWire(o.TopoDS.Edge(e.edge))).Wire()));
      mk.AddWire(T(T(new o.BRepBuilderAPI_MakeWire(o.TopoDS.Edge(other))).Wire()));
      mk.Build();
      if (!mk.IsDone()) throw new Error(`A superfície regrada falhou na aresta "${e.name}"`);
      shape = T(mk.Shape());
    }
    return { shape, name: `${f.id}:rul{${e.name}}` };
  });
  // costura das faces regradas de arestas consecutivas
  const sewn = parts.length > 1 ? sew(parts.map((p) => p.shape), 1e-4) : null;
  const known = parts.flatMap((p) => explore(p.shape, "face").map((face) => ({ face: sewn ? sewn.map(face) : face, name: p.name })));
  ctx.sheets.set(f.id, nameFrom(sewn?.shape ?? parts[0].shape, f.id, known));
  return ctx;
};
