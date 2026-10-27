// Superfícies: corpos de superfície (folhas) criados a partir de esboços, preenchimentos e desvios,
// e as operações que os ligam aos sólidos (costurar, espessar, aparar, apagar faces).
// Cada corpo de superfície fica em ctx.sheets com a chave do id da feature que o criou; aparar mantém
// a chave, costurar/espessar consomem os corpos de entrada.
import type {
  DeleteFaceFeature, Feature, FillFeature, KnitFeature, OffsetSurfaceFeature, SurfaceExtrudeFeature, SurfaceLoftFeature,
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
import { type NamedBody, type NamedFace, ShapeIndex, nameFresh, nameResult } from "../naming.ts";
import {
  T, type TopoDS_Face, type TopoDS_Shape, distance, edgeProps, explore, gpAx1, gpPln, gpVec, listToArray, makeCompound,
  makeList, makeShell, oc, v3, vertexAt, volume,
} from "../occ.ts";
import { applyOp } from "../boolean.ts";
import { generatedNames, nameFrom, sketchOf } from "./solid.ts";

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
  const path = sketchOf(ctx, f.path);
  if (path.profiles.chains.length !== 1) throw new Error("O caminho tem de ser uma única cadeia de entidades");
  const spine = chainWire(path.profiles.chains[0], path.frame);
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, s.frame);
    const mk = T(new (oc().BRepOffsetAPI_MakePipeShell)(spine.wrapped));
    mk.SetMode(f.orientation !== "fixed");
    mk.Add(wire, false, false);
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

/** As arestas formam um contorno fechado (cada vértice usado exatamente duas vezes)? */
function isClosedLoop(es: TopoDS_Shape[]): boolean {
  const count = new ShapeIndex<number>();
  const list: TopoDS_Shape[] = [];
  for (const e of es) {
    for (const v of explore(e, "vertex")) {
      if (!count.has(v)) list.push(v);
      count.set(v, (count.get(v) ?? 0) + 1);
    }
  }
  return list.every((v) => count.get(v) === 2) || (es.length === 1 && list.length === 1);
}

export const fill: Step<FillFeature & Feature> = (ctx, f, report) => {
  const es = resolveEdges(ctx, f.edges, report);
  if (!es.length) throw new Error("Escolha as arestas do contorno a preencher");
  if (!isClosedLoop(es.map((e) => e.edge))) throw new Error("As arestas não formam um contorno fechado");
  const o = oc();
  const S = o.GeomAbs_Shape;
  const order = { contact: S.GeomAbs_C0, tangent: S.GeomAbs_G1, curvature: S.GeomAbs_G2 }[f.continuity];
  const all = pool(ctx);
  const mk = T(new o.BRepOffsetAPI_MakeFilling());
  for (const e of es) {
    const support = f.continuity === "contact" ? undefined : all.faces.find((x) => e.faces.includes(x.name));
    if (support) mk.Add(e.edge, support.face, order, true);
    else {
      if (f.continuity !== "contact") report.warnings.push(`Aresta "${e.name}" sem face vizinha: só contacto`);
      mk.Add(e.edge, S.GeomAbs_C0, true);
    }
  }
  try {
    mk.Build();
  } catch {
    throw new Error("O preenchimento falhou (contorno não plano demasiado complexo?)");
  }
  if (!mk.IsDone()) throw new Error("O preenchimento falhou");
  const shape = T(mk.Shape());
  ctx.sheets.set(f.id, nameFresh(shape, f.id, () => `${f.id}:fill`));
  return ctx;
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
  report.info = { title: "Costura", rows: [["Faces", String(explore(sewn.shape, "face").length)], ["Arestas livres", String(sewn.freeEdges)]] };
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
  const body = nameFrom(sewn.shape, f.id, known);
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

export const trimSurface: Step<TrimSurfaceFeature & Feature> = (ctx, f, report) => {
  const sheet = sheetOf(ctx, f.sheet);
  if (!f.keep.length) throw new Error("Indique as partes a manter");
  const tool = trimTool(ctx, f, report);
  const o = oc();
  const sp = T(new o.BRepAlgoAPI_Splitter());
  sp.SetArguments(makeList([sheet.shape]));
  sp.SetTools(makeList([tool]));
  sp.Build();
  if (sp.HasErrors()) throw new Error("Não foi possível aparar a superfície");
  const split = nameResult(sp, sheet.faces, T(sp.Shape()), f.id);

  // peças: faces ligadas por arestas que não estão sobre a ferramenta de corte
  const tol = modelSize(ctx) * 1e-7;
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
  const keep = new Set<number>();
  for (const p of f.keep) {
    const v = vertexAt(p);
    let best = -1, bestD = Infinity;
    split.faces.forEach((nf, i) => { const d = distance(v, nf.face); if (d < bestD) { bestD = d; best = i; } });
    if (best >= 0) keep.add(root(best));
  }
  const kept = split.faces.filter((_, i) => keep.has(root(i)));
  const pieces = new Set(split.faces.map((_, i) => root(i))).size;
  if (pieces === 1) report.warnings.push("A ferramenta não divide a superfície");
  const groups = new Map<number, TopoDS_Face[]>();
  split.faces.forEach((nf, i) => { if (keep.has(root(i))) groups.set(root(i), [...(groups.get(root(i)) ?? []), nf.face]); });
  const shape = one([...groups.values()].map((g) => makeShell(g)));
  ctx.sheets.set(f.sheet, { shape, faces: kept });
  return ctx;
};

export const deleteFace: Step<DeleteFaceFeature & Feature> = (ctx, f, report) => {
  const fs = resolveFaces(ctx, f.faces, report);
  if (!fs.length) throw new Error("Escolha as faces a apagar");
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
      // cada sólido com faces apagadas passa a casca aberta; os outros ficam no corpo
      const keepSolids: TopoDS_Shape[] = [];
      for (const solid of explore(ctx.body!.shape, "solid")) {
        const sf = explore(solid, "face");
        const named = ctx.body!.faces.filter((nf) => sf.some((x) => x.IsSame(nf.face)));
        if (!sf.some((x) => gone.has(x))) { keepSolids.push(solid); continue; }
        const rest = named.filter((nf) => !gone.has(nf.face));
        if (rest.length) opened.push({ shape: makeShell(rest.map((r) => r.face)), faces: rest });
      }
      const keepIdx = new ShapeIndex<true>();
      for (const s of keepSolids) for (const x of explore(s, "face")) keepIdx.set(x, true);
      body = keepSolids.length ? { shape: one(keepSolids), faces: ctx.body!.faces.filter((nf) => keepIdx.has(nf.face)) } : null;
    } else {
      const sh = ctx.sheets.get(ow)!;
      const rest = sh.faces.filter((nf) => !gone.has(nf.face));
      if (rest.length) sheets.set(ow, { shape: makeShell(rest.map((r) => r.face)), faces: rest });
      else sheets.delete(ow);
    }
  }
  if (opened.length) sheets.set(f.id, { shape: one(opened.map((x) => x.shape)), faces: opened.flatMap((x) => x.faces) });
  return { ...ctx, body, sheets };
};
