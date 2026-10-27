// Superfícies: corpos de superfície (folhas) criados a partir de esboços, preenchimentos e desvios,
// e as operações que os ligam aos sólidos (costurar, espessar, aparar, apagar faces).
// Cada corpo de superfície fica em ctx.sheets com a chave do id da feature que o criou; aparar mantém
// a chave, costurar/espessar consomem os corpos de entrada.
import type {
  BoundaryFeature, Continuity, DeleteFaceFeature, Feature, FillFeature, ReplaceFaceFeature, RuledSurfaceFeature, UntrimFeature, KnitFeature, OffsetSurfaceFeature, SurfaceExtrudeFeature, SurfaceLoftFeature,
  SurfaceRevolveFeature, SurfaceSweepFeature, ThickenFeature, TrimSurfaceFeature, Vec3,
} from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import type { Chain } from "../../sketch/profiles.ts";
import {
  type Ctx, type SketchResult, type StepReport, axisOf, edges as resolveEdges, faceOwner, faces as resolveFaces,
  featureName, modelSize, planeFrame, pool, sheetOf,
} from "../context.ts";
import { type Frame, rotateFrame } from "../frame.ts";
import { chainWire, mapEdgesToEntities } from "../sketch3d.ts";
import { type NamedBody, type NamedEdge, type NamedFace, ShapeIndex, nameFresh, nameResult } from "../naming.ts";
import { maxNormalDeviation } from "../analysis.ts";
import {
  T, type TopoDS_Face, type TopoDS_Shape, distance, edgeProps, explore, faceProps, gpAx1, gpPln, gpVec, interpolateEdge, listToArray,
  makeCompound, makeList, makeShell, makeWire, normalOnFace, oc, sampleEdge, v3, vertexAt, volume,
} from "../occ.ts";
import { applyOp } from "../boolean.ts";
import { generatedNames, nameFrom, sketchOf } from "./solid.ts";
import { curveRefEdges, pathWire } from "./curve.ts";
import { connectedParts, seamDeviations, setupPipe, simplifyBody } from "./gsd.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

/** Cadeias (abertas ou fechadas) de um esboço, para superfícies. */
function chainsOf(ctx: Ctx, id: string, report: StepReport): { s: SketchResult; chains: Chain[] } {
  const s = sketchOf(ctx, id);
  const chains = s.profiles.chains;
  const branched = s.profiles.errors.filter((e) => e.startsWith("Contorno ramificado"));
  if (!chains.length) throw new Error(`Esboço "${featureName(ctx, id)}": ${branched[0] ?? "sem entidades"}`);
  if (branched.length) report.warnings.push(`Esboço "${featureName(ctx, id)}": ${branched[0]} (ignorado)`);
  return { s, chains };
}

function chainWithMap(c: Chain, frame: Frame) {
  const wire = chainWire(c, frame);
  return { wire: wire.wrapped as TopoDS_Shape, edgeMap: mapEdgesToEntities(wire.wrapped, c.segs, frame) as Map<TopoDS_Shape, string> };
}

const shiftFrame = (f: Frame, d: Vec3): Frame => ({ ...f, o: v3.add(f.o, d) });
const one = (shapes: TopoDS_Shape[]) => (shapes.length === 1 ? shapes[0] : makeCompound(shapes));

/** Junta várias peças de superfície num corpo nomeado. */
function sheetFrom(parts: { shape: TopoDS_Shape; known: { face: TopoDS_Shape; name: string }[]; containing?: { edge: TopoDS_Shape; name: string }[] }[], fid: string): NamedBody {
  const shape = one(parts.map((p) => p.shape));
  const body = nameFrom(shape, fid, parts.flatMap((p) => p.known), undefined, parts.flatMap((p) => p.containing ?? []));
  if (!body.faces.length) throw new Error("A superfície não tem faces");
  return body;
}

export const surfaceExtrude: Step<SurfaceExtrudeFeature & Feature> = (ctx, f, report) => {
  const { s, chains } = chainsOf(ctx, f.sketch, report);
  const depth = evalParam(f.end.depth, ctx.scope, "Profundidade");
  if (depth <= 0) throw new Error("Profundidade: tem de ser positiva");
  const n = f.flip ? v3.mul(s.frame.z, -1) : s.frame.z;
  const frame = f.end.type === "midplane" ? shiftFrame(s.frame, v3.mul(n, -depth / 2)) : s.frame;
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, frame);
    const mk = T(new (oc().BRepPrimAPI_MakePrism)(wire, gpVec(v3.mul(n, depth)), false, true));
    return { shape: T(mk.Shape()), known: generatedNames(mk, edgeMap, `${f.id}:side`) };
  });
  ctx.sheets.set(f.id, sheetFrom(parts, f.id));
  return ctx;
};

export const surfaceRevolve: Step<SurfaceRevolveFeature & Feature> = (ctx, f, report) => {
  const { s, chains } = chainsOf(ctx, f.sketch, report);
  const axis = axisOf(ctx, f.axis, report);
  const angle = evalParam(f.angle, ctx.scope, "Ângulo");
  if (angle <= 0 || angle > 360) throw new Error("Ângulo: tem de estar entre 0 e 360°");
  const rad = (angle * Math.PI) / 180;
  const frame = f.midplane && angle < 360 ? rotateFrame(s.frame, axis, -rad / 2) : s.frame;
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, frame);
    const mk = T(new (oc().BRepPrimAPI_MakeRevol)(wire, gpAx1(axis.o, axis.d), rad, false));
    return {
      shape: T(mk.Shape()),
      known: generatedNames(mk, edgeMap, `${f.id}:side`),
      containing: [...edgeMap].map(([edge, ent]) => ({ edge, name: `${f.id}:side:${ent}` })),
    };
  });
  ctx.sheets.set(f.id, sheetFrom(parts, f.id));
  return ctx;
};

export const surfaceSweep: Step<SurfaceSweepFeature & Feature> = (ctx, f, report) => {
  const { s, chains } = chainsOf(ctx, f.profile, report);
  const spine = pathWire(ctx, f.path);
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, s.frame);
    const mk = T(new (oc().BRepOffsetAPI_MakePipeShell)(oc().TopoDS.Wire(spine)));
    setupPipe(ctx, mk, f, wire, report);
    mk.Build();
    if (!mk.IsDone()) throw new Error("O varrimento falhou (perfil demasiado grande para a curvatura do caminho?)");
    return { shape: T(mk.Shape()), known: generatedNames(mk, edgeMap, `${f.id}:side`) };
  });
  ctx.sheets.set(f.id, sheetFrom(parts, f.id));
  return ctx;
};

export const surfaceLoft: Step<SurfaceLoftFeature & Feature> = (ctx, f, report) => {
  if (f.sections.length < 2) throw new Error("O loft precisa de pelo menos 2 secções");
  const mk = T(new (oc().BRepOffsetAPI_ThruSections)(false, !!f.ruled, 1e-6));
  let firstMap: Map<TopoDS_Shape, string> | undefined;
  let closed: boolean | undefined;
  for (const id of f.sections) {
    const { s, chains } = chainsOf(ctx, id, report);
    if (chains.length > 1) throw new Error(`Secção "${featureName(ctx, id)}": só uma cadeia por secção`);
    if (closed !== undefined && closed !== chains[0].closed) throw new Error("As secções têm de ser todas abertas ou todas fechadas");
    closed = chains[0].closed;
    const { wire, edgeMap } = chainWithMap(chains[0], s.frame);
    firstMap ??= edgeMap;
    mk.AddWire(oc().TopoDS.Wire(wire));
  }
  mk.CheckCompatibility(false);
  mk.Build();
  if (!mk.IsDone()) throw new Error("O loft falhou (secções incompatíveis?)");
  ctx.sheets.set(f.id, sheetFrom([{ shape: T(mk.Shape()), known: generatedNames(mk, firstMap!, `${f.id}:side`) }], f.id));
  return ctx;
};

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
function plate(ctx: Ctx, cons: FillConstraint[], report: StepReport): { shape: TopoDS_Shape; deviation: number | null } {
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
function reportDeviation(report: StepReport, title: string, dev: number | null) {
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

/** Retira faces de um corpo de superfície (e apaga-o se ficar vazio). */
function removeFromSheet(sheets: Map<string, NamedBody>, id: string, gone: ShapeIndex<true>) {
  const sh = sheets.get(id)!;
  const rest = sh.faces.filter((nf) => !gone.has(nf.face));
  if (rest.length) sheets.set(id, { shape: makeShell(rest.map((r) => r.face)), faces: rest });
  else sheets.delete(id);
}

export const untrim: Step<UntrimFeature & Feature> = (ctx, f, report) => {
  const fs = resolveFaces(ctx, f.faces, report);
  if (!fs.length) throw new Error("Escolha as faces a desaparar");
  const o = oc();
  const out = fs.map((nf) => {
    const face = T(o.TopoDS.Face(nf.face));
    const surf = T(o.BRep_Tool.Surface(face));
    const nat = surf.Bounds(0, 0, 0, 0);
    const box = o.BRepTools.UVBounds(face, 0, 0, 0, 0);
    // superfícies infinitas (plano, cilindro em V, …): fica a caixa UV da face, sem furos nem recortes
    const inf = (x: number) => !Number.isFinite(x) || Math.abs(x) > 1e50;
    const u1 = inf(nat.U1) ? box.UMin : nat.U1, u2 = inf(nat.U2) ? box.UMax : nat.U2;
    const w1 = inf(nat.V1) ? box.VMin : nat.V1, w2 = inf(nat.V2) ? box.VMax : nat.V2;
    const mk = T(new o.BRepBuilderAPI_MakeFace(surf, u1, u2, w1, w2, 1e-6));
    if (!mk.IsDone()) throw new Error(`Não foi possível desaparar a face "${nf.name}"`);
    return { face: T(mk.Face()) as TopoDS_Shape, name: `${f.id}:unt{${nf.name}}` };
  });
  // as faces escolhidas de corpos de superfície são substituídas; as do sólido são copiadas
  const gone = new ShapeIndex<true>();
  for (const nf of fs) gone.set(nf.face, true);
  for (const ow of new Set(fs.map((nf) => faceOwner(ctx, nf.face)))) if (ow && ow !== "body") removeFromSheet(ctx.sheets, ow, gone);
  const shape = one(out.map((x) => x.face));
  ctx.sheets.set(f.id, nameFrom(shape, f.id, out));
  return ctx;
};

/**
 * Substituir faces: o sólido é prolongado para fora de cada face (prisma segundo a normal) e cortado
 * pela superfície; ficam as partes que não chegam ao fim do prolongamento. Serve tanto para estender
 * como para aparar o sólido até à superfície (faces laterais aproximadamente paralelas à normal).
 */
export const replaceFace: Step<ReplaceFaceFeature & Feature> = (ctx, f, report) => {
  if (!ctx.body) throw new Error("Substituir face precisa de um corpo sólido");
  const sheet = sheetOf(ctx, f.sheet);
  const fs = resolveFaces(ctx, f.faces, report);
  if (!fs.length) throw new Error("Escolha as faces a substituir");
  if (fs.some((nf) => faceOwner(ctx, nf.face) !== "body")) throw new Error("As faces a substituir têm de ser do corpo sólido");
  const far = modelSize(ctx);
  const o = oc();
  let body = ctx.body;
  const caps: TopoDS_Shape[] = [];
  for (const nf of fs) {
    const n = normalOnFace(nf.face, faceProps(nf.face).center);
    const mk = T(new o.BRepPrimAPI_MakePrism(nf.face, gpVec(v3.mul(n, far)), false, true));
    caps.push(T(mk.LastShape()));
    const prism = nameFresh(T(mk.Shape()), f.id, () => undefined);
    for (const pf of prism.faces) pf.name = pf.name.replace(`${f.id}:u`, `${f.id}:ext`);
    body = applyOp({ ...ctx, body }, prism, "add", f.id);
  }
  const sp = T(new o.BRepAlgoAPI_Splitter());
  sp.SetArguments(makeList([body.shape]));
  sp.SetTools(makeList([sheet.shape]));
  sp.Build();
  if (sp.HasErrors()) throw new Error("Não foi possível cortar o corpo pela superfície");
  const split = nameResult(sp, [...body.faces, ...sheet.faces], T(sp.Shape()), f.id);
  const tol = far * 1e-7;
  const keep = explore(split.shape, "solid").filter((sol) => caps.every((c) => distance(sol, c) > tol));
  if (!keep.length) throw new Error("A superfície não atravessa o corpo prolongado (tem de cobrir toda a face a substituir)");
  const idx = new ShapeIndex<true>();
  for (const sol of keep) for (const x of explore(sol, "face")) idx.set(x, true);
  const out = { shape: one(keep), faces: split.faces.filter((nf) => idx.has(nf.face)) };
  if (out.faces.some((nf) => nf.name.startsWith(`${f.id}:ext`))) report.warnings.push("Parte do prolongamento ficou no resultado: a superfície não fecha o corpo em toda a volta");
  ctx.sheets.delete(f.sheet);
  return { ...ctx, body: out };
};

/** Costura faces soltas numa casca (as arestas comuns ficam partilhadas), com o mapa face → face costurada. */
function sew(shapes: TopoDS_Shape[], tol: number) {
  const s = T(new (oc().BRepBuilderAPI_Sewing)(tol, true, true, true, false));
  for (const x of shapes) s.Add(x);
  s.Perform();
  const shape = T(s.SewedShape());
  if (shape.IsNull()) throw new Error("A costura não produziu nenhuma forma");
  // as faces são subformas das formas costuradas: o histórico delas está em *SubShape
  const map = (face: TopoDS_Shape) => (s.IsModifiedSubShape(face) ? T(s.ModifiedSubShape(face)) : s.IsModified(face) ? T(s.Modified(face)) : face);
  return { shape, map, freeEdges: s.NbFreeEdges() };
}

export const offsetSurface: Step<OffsetSurfaceFeature & Feature> = (ctx, f, report) => {
  const fs = resolveFaces(ctx, f.faces, report);
  if (!fs.length) throw new Error("Escolha as faces a deslocar");
  const d = evalParam(f.distance, ctx.scope, "Distância");
  if (Math.abs(d) < 1e-9) throw new Error("Distância: não pode ser nula");
  const sewn = fs.length > 1 ? sew(fs.map((x) => x.face), 1e-6) : null;
  const input = sewn?.shape ?? fs[0].face;
  const mk = T(new (oc().BRepOffsetAPI_MakeOffsetShape)());
  mk.PerformBySimple(input, d);
  if (!mk.IsDone()) throw new Error("O desvio da superfície falhou (distância maior que o raio de curvatura?)");
  const shape = T(mk.Shape());
  // o desvio simples regista as faces novas como "geradas" a partir das originais
  const known = fs.flatMap((nf) => {
    const src = sewn ? sewn.map(nf.face) : nf.face;
    return [...listToArray(mk.Generated(src)), ...listToArray(mk.Modified(src))].map((m) => ({ face: m, name: `${f.id}:off{${nf.name}}` }));
  });
  ctx.sheets.set(f.id, nameFrom(shape, f.id, known));
  return ctx;
};

/** Sólido(s) a partir das cascas fechadas de uma forma, com a matéria para dentro. */
function solidsOf(shape: TopoDS_Shape): TopoDS_Shape {
  const o = oc();
  const solids = explore(shape, "shell").map((sh) => {
    const mk = T(new o.BRepBuilderAPI_MakeSolid(o.TopoDS.Shell(sh)));
    const solid = T(mk.Solid());
    if (!o.BRepLib.OrientClosedSolid(solid)) throw new Error("A casca costurada não é orientável (faces sobrepostas?)");
    return solid as TopoDS_Shape;
  });
  if (!solids.length) throw new Error("A costura não formou nenhuma casca");
  return one(solids);
}

export const knit: Step<KnitFeature & Feature> = (ctx, f, report) => {
  if (!f.sheets.length) throw new Error("Escolha os corpos de superfície a costurar");
  const inputs = f.sheets.map((id) => sheetOf(ctx, id));
  const tol = evalParam(f.tolerance, ctx.scope, "Tolerância", 0.01);
  const sewn = sew(inputs.map((b) => b.shape), tol);
  const known = inputs.flatMap((b) => b.faces.map((nf) => ({ face: sewn.map(nf.face), name: nf.name })));
  const info = { title: "Costura", rows: [["Faces", String(explore(sewn.shape, "face").length)], ["Arestas livres", String(sewn.freeEdges)]] as [string, string][] };
  report.info = info;
  if (f.makeSolid) {
    if (sewn.freeEdges > 0) throw new Error(`A costura tem ${sewn.freeEdges} aresta(s) livre(s): não fecha um volume (feche as aberturas ou aumente a tolerância)`);
    const tool = nameFrom(solidsOf(sewn.shape), f.id, known);
    if (volume(tool.shape).volume <= 0) throw new Error("O sólido costurado tem volume nulo");
    const op = f.op ?? "add";
    const body = applyOp(ctx, tool, op, f.id);
    for (const id of f.sheets) ctx.sheets.delete(id);
    ctx.tools.set(f.id, { body: tool, op });
    return { ...ctx, body };
  }
  let body = nameFrom(sewn.shape, f.id, known);
  if (f.simplify) body = simplifyBody(body, f.id);
  const parts = connectedParts(body.shape);
  info.rows.push(["Partes ligadas", String(parts)]);
  if (f.checkConnected && parts > 1) throw new Error(`O resultado tem ${parts} partes desligadas (aumente a tolerância ou acrescente superfícies de ligação)`);
  if (f.checkTangency) {
    const bad = seamDeviations(body).filter((x) => x.deg > 0.5);
    if (bad.length) throw new Error(`${bad.length} aresta(s) costurada(s) não tangente(s) (máx. ${Math.max(...bad.map((x) => x.deg)).toFixed(1)}°)`);
  }
  for (const id of f.sheets) ctx.sheets.delete(id);
  ctx.sheets.set(f.id, body);
  return ctx;
};

export const thicken: Step<ThickenFeature & Feature> = (ctx, f) => {
  const sheet = sheetOf(ctx, f.sheet);
  const t = evalParam(f.thickness, ctx.scope, "Espessura");
  if (t <= 0) throw new Error("Espessura: tem de ser positiva");
  const o = oc();
  let src = sheet.shape;
  let inputs: NamedFace[] = sheet.faces;
  if (f.side === "both") {
    // primeiro desloca a superfície meia espessura para trás, depois espessa para a frente
    const off = T(new o.BRepOffsetAPI_MakeOffsetShape());
    off.PerformBySimple(src, -t / 2);
    if (!off.IsDone()) throw new Error("Espessar dos dois lados falhou (espessura maior que o raio de curvatura?)");
    src = T(off.Shape());
    inputs = nameResult(off, sheet.faces, src, f.id).faces;
  }
  const mk = T(new o.BRepOffsetAPI_MakeThickSolid());
  mk.MakeThickSolidBySimple(src, f.side === "back" ? -t : t);
  if (!mk.IsDone()) throw new Error("Espessar falhou (espessura maior que o raio de curvatura?)");
  let shape = T(mk.Shape());
  if (!explore(shape, "solid").length) throw new Error("Espessar não gerou um sólido");
  // o algoritmo simples pode devolver o sólido com a matéria para fora: reorientar
  if (volume(shape).volume < 0) shape = solidsOf(shape);
  const tool = nameResult(mk, inputs, shape, f.id, inputs.map((nf) => ({ from: nf.face, name: `${f.id}:off{${nf.name}}` })));
  for (const nf of tool.faces) nf.name = nf.name.replace(`${f.id}:u`, `${f.id}:wall`);
  if (volume(tool.shape).volume <= 0) throw new Error("O sólido espessado tem volume nulo");
  const body = applyOp(ctx, tool, f.op, f.id);
  ctx.sheets.delete(f.sheet);
  ctx.tools.set(f.id, { body: tool, op: f.op });
  return { ...ctx, body };
};

/** Ferramenta de corte de um aparar: plano (face grande), outra superfície ou esboço extrudido nos dois sentidos. */
function trimTool(ctx: Ctx, f: TrimSurfaceFeature, report: StepReport): TopoDS_Shape {
  const far = modelSize(ctx);
  const o = oc();
  switch (f.tool.kind) {
    case "plane": {
      const fr = planeFrame(ctx, f.tool.plane, report);
      return T(T(new o.BRepBuilderAPI_MakeFace(gpPln(fr.o, fr.z), -far, far, -far, far)).Face());
    }
    case "sheet":
      if (f.tool.sheet === f.sheet) throw new Error("A ferramenta de aparar tem de ser outro corpo de superfície");
      return sheetOf(ctx, f.tool.sheet).shape;
    case "sketch": {
      const { s, chains } = chainsOf(ctx, f.tool.sketch, report);
      return one(chains.map((c) => {
        const wire = chainWire(c, shiftFrame(s.frame, v3.mul(s.frame.z, -far))).wrapped;
        return T(T(new o.BRepPrimAPI_MakePrism(wire, gpVec(v3.mul(s.frame.z, 2 * far)), false, true)).Shape());
      }));
    }
  }
}

/** Divide um corpo de superfície por uma ferramenta e agrupa as faces em peças (ligadas por arestas fora da ferramenta). */
function splitPieces(sheet: NamedBody, tool: TopoDS_Shape, fid: string, tol: number) {
  const sp = T(new (oc().BRepAlgoAPI_Splitter)());
  sp.SetArguments(makeList([sheet.shape]));
  sp.SetTools(makeList([tool]));
  sp.Build();
  if (sp.HasErrors()) throw new Error("Não foi possível aparar a superfície");
  const split = nameResult(sp, sheet.faces, T(sp.Shape()), fid);
  const parent = split.faces.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const owners = new ShapeIndex<number[]>();
  const edgeList: TopoDS_Shape[] = [];
  split.faces.forEach((nf, i) => {
    for (const e of explore(nf.face, "edge")) {
      const l = owners.get(e);
      if (l) l.push(i);
      else { owners.set(e, [i]); edgeList.push(e); }
    }
  });
  for (const e of edgeList) {
    const fs = owners.get(e)!;
    if (fs.length < 2 || distance(vertexAt(edgeProps(e).mid), tool) < tol) continue;
    for (const j of fs.slice(1)) parent[root(j)] = root(fs[0]);
  }
  return { faces: split.faces, root, count: new Set(split.faces.map((_, i) => root(i))).size };
}

export const trimSurface: Step<TrimSurfaceFeature & Feature> = (ctx, f, report) => {
  const sheet = sheetOf(ctx, f.sheet);
  if (!f.keep.length) throw new Error("Indique as partes a manter");
  const tool = trimTool(ctx, f, report);
  const tol = modelSize(ctx) * 1e-7;
  const mutual = !!f.mutual && f.tool.kind === "sheet";
  // aparar mútuo: as duas superfícies dividem-se uma à outra e escolhem-se peças de ambas
  const sets = [splitPieces(sheet, tool, f.id, tol)];
  if (mutual) sets.push(splitPieces(sheetOf(ctx, (f.tool as { sheet: string }).sheet), sheet.shape, f.id, tol));
  const keep = sets.map(() => new Set<number>());
  for (const p of f.keep) {
    const v = vertexAt(p);
    let best: [number, number] = [-1, -1], bestD = Infinity;
    sets.forEach((set, k) => set.faces.forEach((nf, i) => { const d = distance(v, nf.face); if (d < bestD) { bestD = d; best = [k, i]; } }));
    if (best[0] >= 0) keep[best[0]].add(sets[best[0]].root(best[1]));
  }
  if (sets[0].count === 1) report.warnings.push("A ferramenta não divide a superfície");
  const kept = sets.flatMap((set, k) => set.faces.filter((_, i) => keep[k].has(set.root(i))));
  if (!kept.length) throw new Error("Nenhuma parte escolhida");
  if (mutual) {
    // as peças das duas superfícies são costuradas num só corpo
    const sewn = sew(kept.map((nf) => nf.face), tol * 100);
    ctx.sheets.set(f.sheet, nameFrom(sewn.shape, f.id, kept.map((nf) => ({ face: sewn.map(nf.face), name: nf.name }))));
    ctx.sheets.delete((f.tool as { sheet: string }).sheet);
    return ctx;
  }
  const groups = new Map<number, TopoDS_Face[]>();
  sets[0].faces.forEach((nf, i) => { const r = sets[0].root(i); if (keep[0].has(r)) groups.set(r, [...(groups.get(r) ?? []), nf.face]); });
  ctx.sheets.set(f.sheet, { shape: one([...groups.values()].map((g) => makeShell(g))), faces: kept });
  return ctx;
};

/** Arestas de fronteira entre faces apagadas e faces que ficam, agrupadas em contornos. */
function holeLoops(rest: NamedFace[], deleted: NamedFace[]): NamedEdge[][] {
  const restIdx = new ShapeIndex<NamedFace>();
  for (const nf of rest) for (const e of explore(nf.face, "edge")) restIdx.set(e, nf);
  const border: NamedEdge[] = [];
  const seen = new ShapeIndex<true>();
  for (const nf of deleted) for (const e of explore(nf.face, "edge")) {
    const owner = restIdx.get(e);
    if (!owner || seen.has(e)) continue;
    seen.set(e, true);
    border.push({ edge: e, name: `{${owner.name}&${nf.name}}`, faces: [owner.name] });
  }
  // componentes ligadas pelos vértices
  const loops: NamedEdge[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < border.length; i++) {
    if (used.has(i)) continue;
    const loop = [border[i]];
    used.add(i);
    for (let grew = true; grew;) {
      grew = false;
      for (let j = 0; j < border.length; j++) {
        if (used.has(j)) continue;
        const vs = explore(border[j].edge, "vertex");
        if (loop.some((l) => explore(l.edge, "vertex").some((v) => vs.some((w) => w.IsSame(v))))) { loop.push(border[j]); used.add(j); grew = true; }
      }
    }
    loops.push(loop);
  }
  return loops;
}

/** Remenda os buracos deixados pelas faces apagadas e costura tudo. */
function patched(ctx: Ctx, rest: NamedFace[], deleted: NamedFace[], continuity: Continuity, fid: string, report: StepReport) {
  const loops = holeLoops(rest, deleted);
  const patches = loops.map((loop) => plate(ctx, loop.map((edge) => ({ edge, bound: true, continuity })), report));
  const dev = patches.reduce<number | null>((m, p) => (p.deviation === null ? m : Math.max(m ?? 0, p.deviation)), null);
  reportDeviation(report, "Remendo", dev);
  const sewn = sew([...rest.map((r) => r.face), ...patches.map((p) => p.shape)], 1e-4);
  const known = [
    ...rest.map((nf) => ({ face: sewn.map(nf.face), name: nf.name })),
    ...patches.flatMap((p, k) => explore(p.shape, "face").map((face) => ({ face: sewn.map(face), name: `${fid}:patch${k}` }))),
  ];
  return { sewn, known };
}

export const deleteFace: Step<DeleteFaceFeature & Feature> = (ctx, f, report) => {
  const fs = resolveFaces(ctx, f.faces, report);
  if (!fs.length) throw new Error("Escolha as faces a apagar");
  const patch = f.mode === "patch";
  const gone = new ShapeIndex<true>();
  for (const nf of fs) gone.set(nf.face, true);
  const byOwner = new Map<string, NamedFace[]>();
  for (const nf of fs) {
    const ow = faceOwner(ctx, nf.face);
    if (!ow) throw new Error(`A face "${nf.name}" não pertence a nenhum corpo`);
    byOwner.set(ow, [...(byOwner.get(ow) ?? []), nf]);
  }
  let body = ctx.body;
  const sheets = new Map(ctx.sheets);
  const opened: { shape: TopoDS_Shape; faces: NamedFace[] }[] = [];
  for (const ow of byOwner.keys()) {
    if (ow === "body") {
      // cada sólido com faces apagadas passa a casca aberta (ou é remendado); os outros ficam no corpo
      const keepSolids: TopoDS_Shape[] = [];
      const keepFaces: NamedFace[] = [];
      for (const solid of explore(ctx.body!.shape, "solid")) {
        const sf = explore(solid, "face");
        const named = ctx.body!.faces.filter((nf) => sf.some((x) => x.IsSame(nf.face)));
        if (!sf.some((x) => gone.has(x))) { keepSolids.push(solid); keepFaces.push(...named); continue; }
        const rest = named.filter((nf) => !gone.has(nf.face));
        if (patch) {
          const { sewn, known } = patched(ctx, rest, named.filter((nf) => gone.has(nf.face)), f.continuity ?? "tangent", f.id, report);
          if (sewn.freeEdges > 0) throw new Error(`O remendo deixou ${sewn.freeEdges} aresta(s) livre(s): o sólido não fecha`);
          const solidBody = nameFrom(solidsOf(sewn.shape), f.id, known);
          keepSolids.push(solidBody.shape);
          keepFaces.push(...solidBody.faces);
        } else if (rest.length) opened.push({ shape: makeShell(rest.map((r) => r.face)), faces: rest });
      }
      body = keepSolids.length ? { shape: one(keepSolids), faces: keepFaces } : null;
    } else if (patch) {
      const sh = ctx.sheets.get(ow)!;
      const rest = sh.faces.filter((nf) => !gone.has(nf.face));
      const { sewn, known } = patched(ctx, rest, sh.faces.filter((nf) => gone.has(nf.face)), f.continuity ?? "tangent", f.id, report);
      sheets.set(ow, nameFrom(sewn.shape, f.id, known));
    } else removeFromSheet(sheets, ow, gone);
  }
  if (opened.length) sheets.set(f.id, { shape: one(opened.map((x) => x.shape)), faces: opened.flatMap((x) => x.faces) });
  return { ...ctx, body, sheets };
};
