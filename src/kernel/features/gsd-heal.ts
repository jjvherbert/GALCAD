// GSD: extrapolar, costura de faces e cura (healing).
import { type ExtrapolateFeature, type Feature, type HealFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { edges as resolveEdges, featureName, sheetOf } from "../context.ts";
import { type NamedBody, type NamedFace, namedEdges } from "../naming.ts";
import { T, distance, explore, faceProps, makeCompound, poleRowsFace, oc, sampleEdge, surfaceAt, vertexAt, type TopoDS_Shape } from "../occ.ts";
import { maxNormalDeviation } from "../analysis.ts";
import { nameFrom } from "./solid.ts";
import { add, dist, mul } from "../../geom/spline.ts";
import { type Step, NU, normalDeviation, reportTangency, outwardField } from "./gsd-common.ts";

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
