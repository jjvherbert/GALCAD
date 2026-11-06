// Aparar superfícies e apagar faces.
import type { Continuity, DeleteFaceFeature, Feature, TrimSurfaceFeature } from "../../doc/types.ts";
import { type Ctx, type StepReport, faceOwner, faces as resolveFaces, modelSize, planeFrame, sheetOf } from "../context.ts";
import { chainWire } from "../sketch3d.ts";
import { type NamedBody, type NamedEdge, type NamedFace, ShapeIndex, nameResult } from "../naming.ts";
import { T, type TopoDS_Face, type TopoDS_Shape, distance, edgeProps, explore, gpPln, gpVec, makeList, makeShell, oc, v3, vertexAt } from "../occ.ts";
import { nameFrom } from "./solid.ts";
import { type Step, chainsOf, shiftFrame, one, removeFromSheet, sew, solidsOf } from "./surface-common.ts";
import { plate, reportDeviation } from "./surface-fill.ts";

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
