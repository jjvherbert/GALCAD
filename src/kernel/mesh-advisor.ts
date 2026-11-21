// Avaliador de malha (C9a): lê o plano da malha de um estudo FEM (o mesmo que vai para o Gmsh) e propõe
// alterações com o limite e a fonte (src/sim/quality.ts). Não inventa limites: cada frase cita um.
import type { Ctx } from "./context.ts";
import type { FemStudy } from "../doc/study.ts";
import type { TopoRef } from "../doc/types.ts";
import { type TopoDS_Shape, bbox, explore, edgeProps, faceProps, distance, vertexAt } from "./occ.ts";
import { namedEdges, hintFor } from "./naming.ts";
import { THIN } from "./meshplan.ts";
import { studyPlan, type StudyPlan } from "./sim-fem.ts";
import { ADVISOR_LIMITS as A, type MeshQuality } from "../sim/quality.ts";
import { applyPatch, type MeshAdvice, type MeshPatch, type Suggestion } from "../sim/mesh-advice.ts";
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
      region: { block: "Corpo", edges: refsOf(under), label: `${under.length} aresta(s) na espessura (${fmt(th)} mm)` },
      patch: { set: { layers: need.value } }, preview: { tags: under },
      why: `Zona fina: ${minN} elemento(s) na espessura de ${fmt(th)} mm; pedir ${need.value} (elementos de ordem ${order}: ${need.source}).${element === "tet" ? " Em tetraedros só as arestas ficam com as camadas; para camadas reais usar hexaedros." : ""}`,
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
      why: `Aresta minúscula de ${fmt(len)} mm (< ${A.tinyEdgeRatio.value * 100} % do tamanho ${fmt(effSize(t))} mm: ${A.tinyEdgeRatio.source}). O GALCAD não tem topologia virtual para a absorver: seed local nas ${nbs.length} aresta(s) vizinha(s), com o 1.º elemento ≈ ${A.tinyGrade.value}× o seu comprimento (${A.tinyGrade.source}).`,
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
      region: { block: "Corpo", edges: refsOf(viaCurv.map((a) => a.t)), label: `${viaCurv.length} arco(s)` },
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
      region: { block, edges: refsOf(list.map((a) => a.t)), label: `${list.length} arco(s)` },
      patch: { addSeeds: list.map((a) => ({ edges: [refOf.get(a.t)!], mode: "count" as const, value: nNew(a) })) }, preview: { tags: list.map((a) => a.t) },
      why: `Arco grosseiro: ${fmt(worstA)}° por elemento (> ${A.arcMaxDeg.value}°: ${A.arcMaxDeg.source}). Seed com ${A.arcTargetDeg.value}° por elemento (${A.arcTargetDeg.source}).`,
      metric: { name: "graus por elemento no arco", before: fmt(worstA), after: fmt(Math.max(...list.map((a) => a.deg / nNew(a)))), unit: "°" },
      elements: { before: list.reduce((x, a) => x + a.nEff, 0), after: list.reduce((x, a) => x + nNew(a), 0) },
    });
  }

  // hexaedros: sólidos que não são blocos → partição pelos planos das faces do corpo (escolha gulosa, até 4)
  const hm = s.mesh.hexMethod ?? "auto";
  if (element === "hex" && hm !== "subdivision" && sp.plan?.blocks.some((b) => !b)) {
    const blocks = sp.plan.blocks, N = blocks.length, bad = (p: StudyPlan) => (p.plan ? p.plan.blocks.filter((b) => !b).length : Infinity);
    const cand: { ref: TopoRef; origin: V3; normal: V3 }[] = [];
    for (const nf of body.faces) {
      const fp = faceProps(nf.face);
      if (fp.type !== "plane" || !fp.normal || !fp.planeOrigin) continue;
      const n = fp.normal as V3, o = fp.planeOrigin as V3, off = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
      if (cand.some((c) => Math.abs(Math.abs(c.normal[0] * n[0] + c.normal[1] * n[1] + c.normal[2] * n[2]) - 1) < 1e-6 && Math.abs(Math.abs(c.normal[0] * c.origin[0] + c.normal[1] * c.origin[1] + c.normal[2] * c.origin[2]) - Math.abs(off)) < 1e-6)) continue;
      const cuts = solids.some((so, i) => {
        if (blocks[i]) return false;
        const b = bbox(so), ds: number[] = [];
        for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) ds.push(n[0] * x + n[1] * y + n[2] * z - off);
        return Math.max(...ds) > 1e-3 && Math.min(...ds) < -1e-3;
      });
      if (cuts) cand.push({ ref: { kind: "face", name: nf.name, hint: hintFor("face", nf.face) }, origin: o, normal: n });
    }
    const chosen: typeof cand = [];
    // um só corte pode não reduzir os maus (ex.: L → o sólido que fica tem uma face partida pelo vizinho) mas
    // aumentar os bons: também conta como progresso (o seguinte fecha-o)
    const good = (p: StudyPlan) => (p.plan ? p.plan.blocks.filter((b) => b).length : 0);
    let cur = bad(sp), curGood = good(sp), curPlan = sp;
    const pool = cand.slice(0, 12);
    for (let k = 0; k < 4 && cur > 0; k++) {
      let best: { c: (typeof cand)[number]; p: StudyPlan; b: number; g: number } | null = null;
      for (const c of pool) {
        if (chosen.includes(c)) continue;
        const parts = [...chosen, c].map((x) => ({ axis: "f" as const, at: 0, face: x.ref }));
        const p = studyPlan(ctx, { ...s, mesh: applyPatch(s.mesh, { addPartitions: parts }) });
        if (p.warnings.some((w) => /parti/i.test(w) && !sp.warnings.includes(w))) continue;
        const b = bad(p), g = good(p);
        if ((b < cur || (b === cur && g > curGood)) && (!best || b < best.b || (b === best.b && g > best.g))) best = { c, p, b, g };
      }
      if (!best) break;
      chosen.push(best.c); cur = best.b; curGood = best.g; curPlan = best.p;
    }
    const k0 = N - bad(sp);
    if (chosen.length && cur < bad(sp)) {
      const N1 = curPlan.plan!.blocks.length;
      out.push({
        id: `hex:${chosen.map((c) => c.ref.name).sort().join(",")}`, rule: "hex",
        region: { block: "Corpo", faces: chosen.map((c) => c.ref), label: `${chosen.length} partição(ões)` },
        patch: { addPartitions: chosen.map((c) => ({ axis: "f" as const, at: 0, face: c.ref })) },
        preview: { tags: [], planes: chosen.map((c) => ({ origin: c.origin, normal: c.normal })) },
        why: `Hexaedros: ${N - k0} de ${N} sólido(s) não são blocos hexaédricos (6 faces de 4 arestas) e caem na subdivisão, de qualidade inferior. Partir pelos planos de ${chosen.length} face(s) deixa ${N1 - cur} de ${N1} em blocos.${cur ? " Os restantes continuam por subdivisão." : ""}`,
        metric: { name: "blocos hexaédricos", before: k0, after: N1 - cur, unit: `/${N}→${N1}` },
      });
    } else {
      out.push({
        id: "hex:subdivision", rule: "hex",
        region: { block: "Corpo", label: "método dos hexaedros" },
        patch: { set: { hexMethod: "subdivision" } }, preview: { tags: [] },
        why: `Hexaedros: ${N - k0} de ${N} sólido(s) não são blocos hexaédricos e nenhuma partição pelos planos das faces do corpo ajuda. Assumir a subdivisão (qualidade inferior) ou partir à mão.`,
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
      region: { block: "Corpo", faces: refs, label: `${inv.length} elemento(s) invertido(s)` },
      patch: { addLocal: [{ faces: refs, size: h }] }, preview: { tags },
      why: `${inv.length} elemento(s) invertido(s) (${A.invertedSj.source}) junto a ${refs.length} face(s); refinamento local a ${h} mm. Se persistir, rever a geometria nessa zona (faces muito estreitas ou arestas minúsculas).`,
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
