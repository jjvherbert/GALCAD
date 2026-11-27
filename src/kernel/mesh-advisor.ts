// Avaliador de malha (C9a): lê o plano da malha de um estudo FEM (o mesmo que vai para o Gmsh) e propõe
// alterações com o limite e a fonte (src/sim/quality.ts). Não inventa limites: cada frase cita um.
import type { Ctx } from "./context.ts";
import type { FemStudy } from "../doc/study.ts";
import type { TopoRef } from "../doc/types.ts";
import { pl } from "../doc/plural.ts";
import { type TopoDS_Shape, bbox, explore, edgeProps, distance, vertexAt } from "./occ.ts";
import { namedEdges, hintFor } from "./naming.ts";
import { THIN } from "./meshplan.ts";
import { studyPlan } from "./sim-fem.ts";
import { suggestSweepCuts } from "./sweep-cuts.ts";
import { ADVISOR_LIMITS as A, type MeshQuality } from "../sim/quality.ts";
import { type MeshAdvice, type MeshPatch, type Suggestion } from "../sim/mesh-advice.ts";
import type { V3 } from "../sim/case.ts";

const fmt = (x: number) => +x.toPrecision(3);
const DEG = 180 / Math.PI;

/** Razão de crescimento (maior/menor elemento) para que o 1.º de n elementos numa aresta de comprimento L meça h0. */
export function biasFor(L: number, n: number, h0: number): number {
  if (n < 2 || L / n <= h0) return 1;
  const first = (b: number) => { const q = b ** (1 / (n - 1)); return q === 1 ? L / n : (L * (q - 1)) / (q ** n - 1); };
  let lo = 1, hi = 100;
  if (first(hi) > h0) return hi;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (first(m) > h0) lo = m; else hi = m; }
  return hi;
}
const firstOf = (L: number, n: number, b: number) => { const q = n > 1 ? b ** (1 / (n - 1)) : 1; return q === 1 ? L / n : (L * (q - 1)) / (q ** n - 1); };

/**
 * Sugestões para a malha de um estudo FEM sólido: zonas finas (elementos na espessura), arestas minúsculas
 * (seed local graduada — não há topologia virtual), arcos grosseiros (15–20° por elemento), sólidos que não são
 * blocos hexaédricos (partição) e elementos invertidos (refinamento local junto à face mais próxima).
 * `worst` são os piores elementos da última malha (opcional).
 */
export function adviseMesh(ctx: Ctx, s: FemStudy, worst?: MeshQuality["worst"]): MeshAdvice {
  const notes: string[] = [];
  const body = ctx.body;
  if (s.shell || !body) return { suggestions: [], notes: [s.shell ? "Avaliador de malha: só para estudos sólidos (cascas ainda não)" : "Avaliador de malha: sem corpo"] };
  const sp = studyPlan(ctx, s);
  const { allEdges } = sp.topo, solids = sp.input.solids, size = sp.size;
  const order = (s.mesh.order ?? 2) as 1 | 2, element = sp.input.element;
  const multi = solids.length > 1;

  // nomes estáveis das arestas (as criadas pelas partições não têm nome: não se lhes põem seeds)
  const refOf = new Map<number, TopoRef>();
  for (const ne of namedEdges(body)) for (const t of sp.topo.edgeIdx(ne.edge)) if (!refOf.has(t)) refOf.set(t, { kind: "edge", name: ne.name, hint: hintFor("edge", ne.edge) });
  const tagOf = (e: TopoDS_Shape) => allEdges.findIndex((x) => x.IsSame(e)) + 1;
  const props = new Map<number, ReturnType<typeof edgeProps>>();
  const P = (t: number) => { let p = props.get(t); if (!p) { p = edgeProps(allEdges[t - 1]); props.set(t, p); } return p; };
  const verts = (t: number) => explore(allEdges[t - 1], "vertex");
  const solidOf = new Map<number, number>(), Ls: number[] = [];
  solids.forEach((so, i) => {
    const b = bbox(so); Ls.push(Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]));
    for (const e of explore(so, "edge")) { const t = tagOf(e); if (t && !solidOf.has(t)) solidOf.set(t, i); }
  });
  const blockOf = (t: number) => (multi ? `Bloco ${(solidOf.get(t) ?? 0) + 1}` : "Corpo");
  const refsOf = (tags: number[]) => tags.map((t) => refOf.get(t)).filter((r): r is TopoRef => !!r);
  const idOf = (rule: string, tags: number[]) => `${rule}:${[...new Set(tags.map((t) => refOf.get(t)?.name ?? `#${t}`))].sort().join(",")}`;
  const effSize = (t: number) => Math.min(size, sp.near.get(t) ?? Infinity);
  const out: Suggestion[] = [];

  // arestas curtas: espessuras (grupos de ≥ 4 arestas iguais) e minúsculas (isoladas, < 10 % do tamanho)
  const short = [...solidOf.keys()].filter((t) => verts(t).length === 2 && P(t).length <= THIN * Ls[solidOf.get(t)!]);
  const sameLen = (a: number, b: number) => Math.abs(P(a).length - P(b).length) <= 0.05 * Math.max(P(a).length, P(b).length);
  const tiny = new Set(short.filter((t) => P(t).length < A.tinyEdgeRatio.value * effSize(t) && short.filter((u) => sameLen(t, u)).length < 4));
  const thin = short.filter((t) => !tiny.has(t));

  // zona fina
  const need = A.thickness[order];
  const under = thin.filter((t) => sp.nOf(t).n < need.value);
  if (under.length && (s.mesh.layers ?? 0) < need.value) {
    const minN = Math.min(...under.map((t) => sp.nOf(t).n)), th = Math.min(...under.map((t) => P(t).length));
    const before = thin.reduce((a, t) => a + sp.nOf(t).n, 0), after = thin.reduce((a, t) => a + Math.max(sp.nOf(t).n, need.value), 0);
    out.push({
      id: idOf("thin", under), rule: "thin",
      region: { block: "Corpo", edges: refsOf(under), label: `${pl(under.length, "aresta", "arestas")} na espessura (${fmt(th)} mm)` },
      patch: { set: { layers: need.value } }, preview: { tags: under },
      why: `Zona fina: ${pl(minN, "elemento", "elementos")} na espessura de ${fmt(th)} mm; pedir ${need.value} (elementos de ordem ${order}: ${need.source}).${element === "tet" ? " Em tetraedros só as arestas ficam com as camadas; para camadas reais usar hexaedros." : ""}`,
      metric: { name: "elementos na espessura", before: minN, after: need.value, unit: "" },
      elements: { before, after },
    });
  }

  // aresta minúscula: seed graduada nas vizinhas (sem topologia virtual para a absorver)
  for (const t of tiny) {
    const vs = verts(t), len = P(t).length;
    const nbs = [...solidOf.keys()].filter((u) => u !== t && !tiny.has(u) && refOf.has(u) && verts(u).some((v) => vs.some((w) => v.IsSame(w))));
    if (!nbs.length || nbs.every((u) => sp.nOf(u).kind === "user")) continue;
    const h0 = A.tinyGrade.value * len, mid = P(t).mid as V3;
    const seeds = nbs.map((u) => {
      const L = P(u).length, n = Math.max(sp.nOf(u).n, 3), b = biasFor(L, n, h0);
      return { u, n, b, L, seed: { edges: [refOf.get(u)!], mode: "count" as const, value: n, bias: fmt(b), biasAt: "vertex" as const, biasPoint: mid } };
    });
    const before = Math.max(...nbs.map((u) => P(u).length / sp.nOf(u).n)), after = Math.max(...seeds.map((x) => firstOf(x.L, x.n, x.seed.bias)));
    out.push({
      id: idOf("tiny", [t]), rule: "tiny",
      region: { block: blockOf(t), edges: refsOf([t, ...nbs]), label: `aresta de ${fmt(len)} mm` },
      patch: { addSeeds: seeds.map((x) => x.seed) }, preview: { tags: [t, ...nbs] },
      why: `Aresta minúscula de ${fmt(len)} mm (< ${A.tinyEdgeRatio.value * 100} % do tamanho ${fmt(effSize(t))} mm: ${A.tinyEdgeRatio.source}). O GALCAD não tem topologia virtual para a absorver: seed local ${nbs.length === 1 ? "na aresta vizinha" : `nas ${nbs.length} arestas vizinhas`}, com o 1.º elemento ≈ ${A.tinyGrade.value}× o seu comprimento (${A.tinyGrade.source}).`,
      metric: { name: "1.º elemento junto à aresta", before: fmt(before), after: fmt(after), unit: "mm" },
      elements: { before: nbs.reduce((a, u) => a + sp.nOf(u).n, 0), after: seeds.reduce((a, x) => a + x.n, 0) },
    });
  }

  // arco grosseiro
  const curv = s.mesh.curvature ?? 12;
  const arcs = [...solidOf.keys()].filter((t) => P(t).type === "circle" && (P(t).radius ?? 0) > 0).map((t) => {
    const deg = (P(t).length / P(t).radius!) * DEG, { n, kind } = sp.nOf(t);
    const byCurv = element === "tet" && kind === "auto";
    const nEff = byCurv && curv > 0 ? Math.max(n, Math.ceil((deg / 360) * curv - 1e-9)) : n;
    return { t, deg, n, nEff, byCurv };
  }).filter((a) => a.deg / a.nEff > A.arcMaxDeg.value + 1e-9);
  const viaCurv = arcs.filter((a) => a.byCurv), viaSeed = arcs.filter((a) => !a.byCurv && refOf.has(a.t));
  if (viaCurv.length) {
    const c = A.curvatureSuggest.value, worstA = Math.max(...viaCurv.map((a) => a.deg / a.nEff));
    const nAfter = (a: (typeof viaCurv)[number]) => Math.max(a.n, Math.ceil((a.deg / 360) * c - 1e-9));
    out.push({
      id: idOf("arc", viaCurv.map((a) => a.t)), rule: "arc",
      region: { block: "Corpo", edges: refsOf(viaCurv.map((a) => a.t)), label: pl(viaCurv.length, "arco", "arcos") },
      patch: { set: { curvature: c } }, preview: { tags: viaCurv.map((a) => a.t) },
      why: `Arco grosseiro: ${fmt(worstA)}° por elemento (> ${A.arcMaxDeg.value}°: ${A.arcMaxDeg.source}). Curvatura ${c} elementos por volta (${A.curvatureSuggest.source}).`,
      metric: { name: "graus por elemento no arco", before: fmt(worstA), after: fmt(Math.max(...viaCurv.map((a) => a.deg / nAfter(a)))), unit: "°" },
      elements: { before: viaCurv.reduce((x, a) => x + a.nEff, 0), after: viaCurv.reduce((x, a) => x + nAfter(a), 0) },
    });
  }
  const byBlock = new Map<string, typeof viaSeed>();
  for (const a of viaSeed) byBlock.set(blockOf(a.t), [...(byBlock.get(blockOf(a.t)) ?? []), a]);
  for (const [block, list] of byBlock) {
    const nNew = (a: (typeof list)[number]) => Math.ceil(a.deg / A.arcTargetDeg.value - 1e-9), worstA = Math.max(...list.map((a) => a.deg / a.nEff));
    out.push({
      id: idOf("arc", list.map((a) => a.t)), rule: "arc",
      region: { block, edges: refsOf(list.map((a) => a.t)), label: pl(list.length, "arco", "arcos") },
      patch: { addSeeds: list.map((a) => ({ edges: [refOf.get(a.t)!], mode: "count" as const, value: nNew(a) })) }, preview: { tags: list.map((a) => a.t) },
      why: `Arco grosseiro: ${fmt(worstA)}° por elemento (> ${A.arcMaxDeg.value}°: ${A.arcMaxDeg.source}). Seed com ${A.arcTargetDeg.value}° por elemento (${A.arcTargetDeg.source}).`,
      metric: { name: "graus por elemento no arco", before: fmt(worstA), after: fmt(Math.max(...list.map((a) => a.deg / nNew(a)))), unit: "°" },
      elements: { before: list.reduce((x, a) => x + a.nEff, 0), after: list.reduce((x, a) => x + nNew(a), 0) },
    });
  }

  // hexaedros: sólidos que não são blocos → cortes para varrer (planos das faces do corpo e pelos eixos dos furos)
  const hm = s.mesh.hexMethod ?? "auto";
  if (element === "hex" && hm !== "subdivision" && sp.plan?.blocks.some((b) => !b)) {
    const N = sp.plan.blocks.length, k0 = sp.plan.blocks.filter((b) => b).length;
    const sc = suggestSweepCuts(ctx, s, sp);
    const notBlocks = `${N - k0} de ${pl(N, "sólido", "sólidos")} não ${N - k0 === 1 ? "é bloco hexaédrico" : "são blocos hexaédricos"}`;
    if (sc) {
      const parts = sc.cuts.flatMap((c) => c.parts), planes = sc.cuts.flatMap((c) => c.planes);
      const faces = [...new Map(sc.cuts.flatMap((c) => c.faces).map((f) => [f.name, f])).values()];
      const left = sc.after.solids - sc.after.blocks;
      const src = [sc.cuts.some((c) => c.kind === "face") && "faces do corpo", sc.cuts.some((c) => c.kind === "axis") && "eixos dos furos"].filter(Boolean).join(" e ");
      out.push({
        id: `hex:${sc.cuts.map((c) => c.key).sort().join(",")}`, rule: "hex",
        region: { block: "Corpo", faces, label: pl(parts.length, "partição", "partições") },
        patch: { addPartitions: parts },
        preview: { tags: [], planes },
        why: `Hexaedros: ${notBlocks} (6 faces de 4 arestas) e caem na subdivisão, de qualidade inferior. Partir por ${pl(planes.length, "plano", "planos")} (${src}) deixa ${sc.after.blocks} de ${sc.after.solids} em blocos.${left ? " Os restantes continuam por subdivisão." : ""}`,
        metric: { name: "blocos hexaédricos", before: k0, after: sc.after.blocks, unit: `/${N}→${sc.after.solids}` },
      });
    } else {
      out.push({
        id: "hex:subdivision", rule: "hex",
        region: { block: "Corpo", label: "método dos hexaedros" },
        patch: { set: { hexMethod: "subdivision" } }, preview: { tags: [] },
        why: `Hexaedros: ${notBlocks} e nenhuma partição pelos planos das faces do corpo ou pelos eixos dos furos ajuda. Assumir a subdivisão (qualidade inferior) ou partir à mão.`,
        metric: { name: "blocos hexaédricos", before: k0, unit: `/${N}` },
      });
    }
  }

  // elementos invertidos: refinamento local na face mais próxima
  const inv = (worst ?? []).filter((w) => w.sj <= A.invertedSj.value).slice(0, 5);
  if (inv.length) {
    const faces = new Map<string, { ref: TopoRef; face: TopoDS_Shape }>();
    for (const w of inv) {
      const v = vertexAt(w.center as V3);
      let best: (typeof body.faces)[number] | null = null, bd = Infinity;
      for (const nf of body.faces) { const d = distance(v, nf.face); if (d < bd) { bd = d; best = nf; } }
      if (best && !faces.has(best.name)) faces.set(best.name, { ref: { kind: "face", name: best.name, hint: hintFor("face", best.face) }, face: best.face });
    }
    const refs = [...faces.values()].map((f) => f.ref);
    const cur = Math.min(...refs.flatMap((r) => { try { return sp.topo.faceTags([r], "Faces").map((t) => sp.input.localSize.get(t) ?? size); } catch { return [size]; } }));
    const h = fmt(cur / 2);
    const tags = [...new Set([...faces.values()].flatMap((f) => explore(f.face, "edge").flatMap((e) => sp.topo.edgeIdx(e))))];
    out.push({
      id: `jacobian:${refs.map((r) => r.name).sort().join(",")}`, rule: "jacobian",
      region: { block: "Corpo", faces: refs, label: pl(inv.length, "elemento invertido", "elementos invertidos") },
      patch: { addLocal: [{ faces: refs, size: h }] }, preview: { tags },
      why: `${pl(inv.length, "elemento invertido", "elementos invertidos")} (${A.invertedSj.source}) junto a ${pl(refs.length, "face", "faces")}; refinamento local a ${h} mm. Se persistir, rever a geometria nessa zona (faces muito estreitas ou arestas minúsculas).`,
      metric: { name: "jacobiano escalado mínimo", before: fmt(Math.min(...inv.map((w) => w.sj))), unit: "" },
    });
  }

  notes.push("Gradiente de tensões: refinar onde a tensão varia muito só depois de uma primeira solução (nota; sem sugestão automática).");
  return { suggestions: resolveConflicts(out, notes), notes };
}

/** Duas sugestões com seed na mesma aresta: fica a mais restritiva (mais elementos) e regista-se uma nota. */
function resolveConflicts(list: Suggestion[], notes: string[]): Suggestion[] {
  const owner = new Map<string, { s: Suggestion; n: number }>();
  const drop = new Map<Suggestion, Set<string>>();
  for (const s of list) for (const sd of s.patch.addSeeds ?? []) {
    const name = sd.edges[0]?.name, n = Number(sd.value);
    if (!name) continue;
    const o = owner.get(name);
    if (!o) { owner.set(name, { s, n }); continue; }
    const [win, lose] = n > o.n ? [{ s, n }, o] : [o, { s, n }];
    owner.set(name, win);
    drop.set(lose.s, (drop.get(lose.s) ?? new Set()).add(name));
    notes.push(`Aresta ${name}: «${win.s.region.label}» e «${lose.s.region.label}» em conflito; fica a mais restritiva (${win.n} elementos).`);
  }
  return list.flatMap((s) => {
    const d = drop.get(s);
    if (!d) return [s];
    const seeds = (s.patch.addSeeds ?? []).filter((sd) => !d.has(sd.edges[0]?.name ?? "") || owner.get(sd.edges[0].name)?.s === s);
    const patch: MeshPatch = { ...s.patch, addSeeds: seeds };
    if (!seeds.length && !patch.set && !patch.addPartitions?.length && !patch.addLocal?.length) return [];
    return [{ ...s, patch }];
  });
}
