// Features de acabamento sobre o corpo: filete, chanfro, casca e inclinação.
import type { ChamferFeature, DraftFeature, Feature, FilletFeature, ShellFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type StepReport, edges, faces, planeFrame } from "../context.ts";
import { type HistoryBuilder, type NamedBody, nameResult } from "../naming.ts";
import { T, type TopoDS_Shape, explore, faceProps, gpDir, gpPln, isTangentEdge, isValid, makeList, oc, v3 } from "../occ.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

/**
 * Filete/chanfro só em cantos: uma costura (aresta com uma só face, p. ex. de um cilindro) ou uma
 * aresta tangente (as duas faces continuam-se suavemente) não têm canto — como no SolidWorks, recusa
 * com uma mensagem clara em vez de deixar o OCCT falhar sem explicação.
 */
function corners(b: NamedBody, es: ReturnType<typeof edges>, what: string) {
  const seam = es.find((e) => e.faces.length < 2);
  if (seam) throw new Error(`${what}: a aresta "${seam.name}" é a costura de uma face fechada (não é um canto) — escolha outra`);
  for (const e of es) {
    const adj = e.faces.map((n) => b.faces.find((x) => x.name === n)?.face);
    if (adj.length === 2 && adj[0] && adj[1] && isTangentEdge(e.edge, adj[0], adj[1]))
      throw new Error(`${what}: a aresta "${e.name}" é tangente (as faces continuam-se suavemente) — não há canto para ${what === "Filete" ? "arredondar" : "chanfrar"}`);
  }
  return es;
}

/** Tipos das faces adjacentes às arestas (para explicar uma falha). */
function adjacentTypes(b: NamedBody, es: ReturnType<typeof edges>): Set<string> {
  const out = new Set<string>();
  for (const e of es) for (const n of e.faces) {
    const f = b.faces.find((x) => x.name === n);
    if (f) try { out.add(faceProps(f.face).type); } catch { /* ignora */ }
  }
  return out;
}

/** Fecha o filete/chanfro: erros internos do núcleo viram mensagens limpas e o sólido tem de ser válido. */
function finish(ctx: Ctx, b: NamedBody, mk: HistoryBuilder & { Shape(): TopoDS_Shape }, id: string, generated: Parameters<typeof nameResult>[4], fail: string): Ctx {
  let body: NamedBody;
  try {
    body = nameResult(mk, b.faces, T(mk.Shape()), id, generated);
  } catch {
    throw new Error(fail);
  }
  if (!explore(body.shape, "solid").length || !isValid(body.shape)) throw new Error(`${fail} (o resultado não é um sólido válido)`);
  return { ...ctx, body };
}

function body(ctx: Ctx) {
  if (!ctx.body) throw new Error("Ainda não existe corpo");
  return ctx.body;
}

export const fillet: Step<FilletFeature & Feature> = (ctx, f, report) => {
  const b = body(ctx);
  const r = evalParam(f.radius, ctx.scope, "Raio");
  if (r <= 0) throw new Error("Raio: tem de ser positivo");
  const es = corners(b, edges(ctx, f.refs, report), "Filete");
  if (!es.length) throw new Error("Selecione pelo menos uma aresta");
  const o = oc();
  const mk = T(new o.BRepFilletAPI_MakeFillet(b.shape, o.ChFi3d_FilletShape.ChFi3d_Rational));
  for (const e of es) mk.Add(r, e.edge);
  try { mk.Build(); } catch { /* tratado abaixo */ }
  const fail = `O filete falhou: raio ${r} mm demasiado grande para as arestas escolhidas?`;
  if (!mk.IsDone()) throw new Error(fail);
  const generated = es.map((e) => ({ from: e.edge, name: `${f.id}:fil${e.name}` }));
  return finish(ctx, b, mk, f.id, generated, fail);
};

export const chamfer: Step<ChamferFeature & Feature> = (ctx, f, report) => {
  const b = body(ctx);
  const d1 = evalParam(f.distance, ctx.scope, "Distância");
  const d2 = evalParam(f.distance2, ctx.scope, "Distância 2", d1);
  if (d1 <= 0 || d2 <= 0) throw new Error("Distâncias: têm de ser positivas");
  const es = corners(b, edges(ctx, f.refs, report), "Chanfro");
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
  // o chanfro do OCCT só é fiável entre planos, cilindros e cones; noutras faces curvas sugere o filete
  const curved = [...adjacentTypes(b, es)].some((x) => !["plane", "cylinder", "cone"].includes(x));
  const fail = curved
    ? "O chanfro falhou: numa face curva (toro, esfera ou superfície livre) o chanfro pode não ser possível — experimente um filete ou uma distância menor"
    : "O chanfro falhou: distância demasiado grande?";
  if (!mk.IsDone()) throw new Error(fail);
  const generated = es.map((e) => ({ from: e.edge, name: `${f.id}:ch${e.name}` }));
  return finish(ctx, b, mk, f.id, generated, fail);
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
