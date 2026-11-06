// Edição de superfícies: desaparar, substituir faces e desviar.
import type { Feature, ReplaceFaceFeature, UntrimFeature, OffsetSurfaceFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { faceOwner, faces as resolveFaces, modelSize, sheetOf } from "../context.ts";
import { ShapeIndex, nameFresh, nameResult } from "../naming.ts";
import { T, type TopoDS_Shape, distance, explore, faceProps, gpVec, listToArray, makeList, normalOnFace, oc, v3 } from "../occ.ts";
import { applyOp } from "../boolean.ts";
import { nameFrom } from "./solid.ts";
import { type Step, one, removeFromSheet, sew } from "./surface-common.ts";

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
