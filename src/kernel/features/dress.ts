// Features de acabamento sobre o corpo: filete, chanfro, casca e inclinação.
import type { ChamferFeature, DraftFeature, Feature, FilletFeature, ShellFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type StepReport, edges, faces, planeFrame } from "../context.ts";
import { nameResult } from "../naming.ts";
import { T, explore, gpDir, gpPln, makeList, oc, v3 } from "../occ.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

function body(ctx: Ctx) {
  if (!ctx.body) throw new Error("Ainda não existe corpo");
  return ctx.body;
}

export const fillet: Step<FilletFeature & Feature> = (ctx, f, report) => {
  const b = body(ctx);
  const r = evalParam(f.radius, ctx.scope, "Raio");
  if (r <= 0) throw new Error("Raio: tem de ser positivo");
  const es = edges(ctx, f.refs, report);
  if (!es.length) throw new Error("Selecione pelo menos uma aresta");
  const o = oc();
  const mk = T(new o.BRepFilletAPI_MakeFillet(b.shape, o.ChFi3d_FilletShape.ChFi3d_Rational));
  for (const e of es) mk.Add(r, e.edge);
  try { mk.Build(); } catch { /* tratado abaixo */ }
  if (!mk.IsDone()) throw new Error(`O filete falhou: raio ${r} mm demasiado grande para as arestas escolhidas?`);
  const shape = T(mk.Shape());
  const generated = es.map((e) => ({ from: e.edge, name: `${f.id}:fil${e.name}` }));
  return { ...ctx, body: nameResult(mk, b.faces, shape, f.id, generated) };
};

export const chamfer: Step<ChamferFeature & Feature> = (ctx, f, report) => {
  const b = body(ctx);
  const d1 = evalParam(f.distance, ctx.scope, "Distância");
  const d2 = evalParam(f.distance2, ctx.scope, "Distância 2", d1);
  if (d1 <= 0 || d2 <= 0) throw new Error("Distâncias: têm de ser positivas");
  const es = edges(ctx, f.refs, report);
  if (!es.length) throw new Error("Selecione pelo menos uma aresta");
  const o = oc();
  const mk = T(new o.BRepFilletAPI_MakeChamfer(b.shape));
  for (const e of es) {
    if (Math.abs(d1 - d2) < 1e-12) mk.Add(d1, e.edge);
    else {
      // assimétrico: d1 medida na primeira face adjacente (por ordem de nome)
      const adj = b.faces.find((nf) => nf.name === [...e.faces].sort()[0]);
      if (!adj) throw new Error("Chanfro assimétrico: face adjacente não encontrada");
      mk.Add(d1, d2, e.edge, adj.face);
    }
  }
  try { mk.Build(); } catch { /* tratado abaixo */ }
  if (!mk.IsDone()) throw new Error("O chanfro falhou: distância demasiado grande?");
  const generated = es.map((e) => ({ from: e.edge, name: `${f.id}:ch${e.name}` }));
  return { ...ctx, body: nameResult(mk, b.faces, T(mk.Shape()), f.id, generated) };
};

export const shell: Step<ShellFeature & Feature> = (ctx, f, report) => {
  const b = body(ctx);
  const t = evalParam(f.thickness, ctx.scope, "Espessura");
  if (t <= 0) throw new Error("Espessura: tem de ser positiva");
  const removed = f.faces.length ? faces(ctx, f.faces, report) : [];
  const o = oc();
  const mk = T(new o.BRepOffsetAPI_MakeThickSolid());
  mk.MakeThickSolidByJoin(
    b.shape, makeList(removed.map((r) => r.face)), f.outward ? t : -t, 1e-3,
    o.BRepOffset_Mode.BRepOffset_Skin, false, false, o.GeomAbs_JoinType.GeomAbs_Arc, false,
  );
  if (!mk.IsDone()) throw new Error("A casca falhou: espessura demasiado grande para os raios/geometria?");
  const shape = T(mk.Shape());
  if (!explore(shape, "solid").length) throw new Error("A casca não produziu um sólido");
  // faces desviadas (paredes interiores) nascem das faces originais
  const generated = b.faces.map((nf) => ({ from: nf.face, name: `${f.id}:in:${nf.name}` }));
  return { ...ctx, body: nameResult(mk, b.faces, shape, f.id, generated) };
};

export const draft: Step<DraftFeature & Feature> = (ctx, f, report) => {
  const b = body(ctx);
  const angle = evalParam(f.angle, ctx.scope, "Ângulo");
  const fs = faces(ctx, f.faces, report);
  if (!fs.length) throw new Error("Selecione as faces a inclinar");
  const plane = planeFrame(ctx, f.neutral, report);
  const dir = f.flip ? v3.mul(plane.z, -1) : plane.z;
  const o = oc();
  const mk = T(new o.BRepOffsetAPI_DraftAngle(b.shape));
  for (const nf of fs) {
    mk.Add(nf.face, gpDir(dir), (angle * Math.PI) / 180, gpPln(plane.o, plane.z), true);
    if (!mk.AddDone()) throw new Error(`Não é possível inclinar a face "${nf.name}" (tem de ser plana, cilíndrica ou cónica e cortar o plano neutro)`);
  }
  mk.Build();
  if (!mk.IsDone()) throw new Error("A inclinação falhou");
  return { ...ctx, body: nameResult(mk, b.faces, T(mk.Shape()), f.id) };
};
