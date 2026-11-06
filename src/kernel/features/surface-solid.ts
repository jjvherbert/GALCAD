// Superfícies para sólidos: costurar e espessar.
import type { Feature, KnitFeature, ThickenFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { sheetOf } from "../context.ts";
import { type NamedFace, nameResult } from "../naming.ts";
import { T, explore, oc, volume } from "../occ.ts";
import { applyOp } from "../boolean.ts";
import { nameFrom } from "./solid.ts";
import { connectedParts, seamDeviations, simplifyBody } from "./gsd.ts";
import { type Step, sew, solidsOf } from "./surface-common.ts";

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
