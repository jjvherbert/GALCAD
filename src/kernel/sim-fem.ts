// Estudos: caso FEM de uma peça (apoios, cargas, malha e hipóteses).
import { type FemStudy, type LoadCsys, loadEdges, loadFaces, plasticCurveErrors } from "../doc/study.ts";
import { evalParam } from "../doc/variables.ts";
import { type Expr, type TopoRef } from "../doc/types.ts";
import { type Ctx, type StepReport, edges as resolveEdges } from "./context.ts";
import { type PlanInput, meshPlan } from "./meshplan.ts";
import { type TopoDS_Shape, bbox, explore, sampleEdge } from "./occ.ts";
import { edgeProps } from "./occ-props.ts";
import { type CaseCsys, type CaseFace, type FemCase, type FemCaseLoad, type V3, amplitudeTable, csysAxes, csysToGlobal, loadGroup } from "../sim/case.ts";
import { type MeshGeo, bodyOf, caseFaces, shellOf, tagsOf, n3 } from "./sim-common.ts";
import { orthoPlyError } from "../sim/laminate.ts";

const FEM_HYP: Record<FemStudy["analysis"], string> = {
  static: "Estática linear: pequenos deslocamentos e deformações, material elástico linear isotrópico, sem contacto",
  modal: "Modal: frequências próprias com as condições de apoio indicadas (sem cargas, sem amortecimento)",
  buckling: "Encurvadura linear (valores próprios): fatores sobre as cargas indicadas, sem imperfeições nem plasticidade",
  thermal: "Térmica em regime permanente: condução isotrópica, convecção e fluxo impostos, sem radiação",
  dynamic: "Dinâmica transitória linear: pequenos deslocamentos, material elástico linear, cargas com amplitude no tempo, condições iniciais nulas",
};

export function femCase(ctx: Ctx, s: FemStudy, report: StepReport): FemCase {
  const sh = s.shell ? shellOf(ctx) : undefined;
  const solid = sh ? sh.shape : bodyOf(ctx);
  const faces = sh ? caseFaces(ctx, solid, sh.faces) : caseFaces(ctx, solid);
  const b = bbox(solid);
  const allEdges = explore(solid, "edge");
  const edgeTags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as arestas`);
    return resolveEdges(ctx, refs, report).map((ne) => {
      const i = allEdges.findIndex((e) => e.IsSame(ne.edge));
      if (i < 0) throw new Error(`${what}: a aresta "${ne.name}" não pertence ao ${sh ? "modelo" : "corpo"}`);
      return i + 1;
    });
  };
  const geo: MeshGeo = { solids: sh ? [] : [solid], faces: explore(solid, "face"), edges: allEdges, edgeTags };
  return buildFemCase(s, ctx.scope, faces, (refs, what) => tagsOf(ctx, faces, solid, refs, what, report), { min: b.min as V3, max: b.max as V3 }, report, geo);
}


/** Casca: espessura avaliada e as opções que o modelo de casca ainda não suporta recusadas. */
const SHELL_LOADS = new Set(["fixed", "displacement", "force", "pressure", "gravity"]);
function shellCheck(s: FemStudy, sc: Ctx["scope"], tags: (refs: TopoRef[], what: string) => number[]): FemCase["shell"] & {} {
  const plies = s.shell!.plies?.length ? s.shell!.plies : undefined;
  // regiões: faces com laminado próprio; uma face só pode estar numa região
  const seen = new Map<number, number>();
  const regions = (s.shell!.regions ?? []).map((r, i) => {
    if (!r.plies.length) throw new Error(`Laminado, região ${i + 1}: sem camadas`);
    r.plies.forEach((p, k) => { const e = orthoPlyError(p); if (e) throw new Error(`Laminado, região ${i + 1}, camada ${k + 1}: ${e}`); });
    const faces = tags(r.faces, `Laminado, região ${i + 1}`);
    if (!faces.length) throw new Error(`Laminado, região ${i + 1}: escolha pelo menos uma face`);
    for (const f of faces) {
      if (seen.has(f)) throw new Error(`Laminado, região ${i + 1}: a face ${f} já está na região ${seen.get(f)! + 1}`);
      seen.set(f, i);
    }
    return { faces, plies: r.plies };
  });
  if (plies || regions.length) {
    plies?.forEach((p, k) => { const e = orthoPlyError(p); if (e) throw new Error(`Laminado, camada ${k + 1}: ${e}`); });
    if (s.analysis !== "static" && s.analysis !== "modal" && s.analysis !== "buckling") throw new Error("Laminado em casca: só estática, modal ou encurvadura nesta versão");
    if (s.mesh.order !== 2) throw new Error("Laminado em casca: requer malha de ordem 2 (S6)");
  }
  const thickness = plies ? plies.reduce((a, p) => a + p.t, 0) : evalParam(s.shell!.thickness, sc, "Espessura da casca");
  if (!(thickness > 0)) throw new Error("Espessura da casca: tem de ser positiva");
  const no = (what: string) => { throw new Error(`Casca: ${what} ainda não é suportado`); };
  if ((s.solver ?? "calculix") !== "calculix") no(`o solver ${s.solver}`);
  if (s.analysis !== "static" && s.analysis !== "modal" && s.analysis !== "buckling") no(`a análise ${s.analysis}`);
  if (s.nonlinear?.geometry || s.nonlinear?.plasticity) no("a análise não linear");
  if (s.mesh.element === "hex" || s.mesh.seeds?.length || s.mesh.mapped?.length) no("a malha manual (hexaedros, seeds ou faces mapeadas)");
  if (s.contact && s.contact.mode !== "none") no("o contacto");
  for (const l of s.loads) if (!SHELL_LOADS.has(l.kind)) no(`a condição «${l.kind}»`);
  return { thickness, ...(plies ? { plies } : {}), ...(regions.length ? { regions } : {}) };
}

/** Referencial local de uma condição: avaliado e conferido (erro se degenerado). */
function loadCsys(c: LoadCsys | undefined, sc: Ctx["scope"], i: number): CaseCsys | undefined {
  if (!c) return undefined;
  const r: CaseCsys = { type: c.type, a: n3(c.a, sc, `Condição ${i + 1}: referencial (a)`), b: n3(c.b, sc, `Condição ${i + 1}: referencial (b)`) };
  try { csysAxes(r); } catch (e) { throw new Error(`Condição ${i + 1}: ${(e as Error).message}`); }
  return r;
}

/** Caso FEM a partir das faces com tag e de um resolvedor de referências (peça ou montagem). */
const HEX_NAME = (order: 1 | 2, integ: FemStudy["mesh"]["integration"]) => order === 2 ? (integ === "full" ? "C3D20 / HEXA20" : "C3D20R / HEXA20 (integração reduzida)") : integ === "full" ? "C3D8 / HEXA8 (integração completa)" : integ === "reduced" ? "C3D8R / HEXA8 (integração reduzida, controlo de hourglass)" : "C3D8I (modos incompatíveis) / HEXA8";

export function buildFemCase(s: FemStudy, sc: Ctx["scope"], faces: CaseFace[], tags: (refs: TopoRef[], what: string) => number[], box: { min: V3; max: V3 }, report: StepReport, geo: MeshGeo): FemCase {
  const groups: Record<string, number[]> = {};
  const edgeGroups: Record<string, number[]> = {}, edgeLength: Record<string, number> = {};
  const loads: FemCaseLoad[] = [];
  // passos de carga (só estática): índice de cada id; as condições recebem os índices onde estão ativas
  const multi = (s.steps?.length ?? 0) > 1;
  if (multi && s.analysis !== "static") report.warnings.push("Passos de carga: só na análise estática — ignorados (um só passo)");
  const stepIdx = new Map((multi && s.analysis === "static" ? s.steps! : []).map((st, k) => [st.id, k]));
  s.loads.forEach((l, i) => {
    const n0 = loads.length;
    loadCase(l, i);
    if (!stepIdx.size || !l.steps || l.kind === "spring" || l.kind === "mass") return;
    const ks = l.steps.map((id) => stepIdx.get(id)).filter((k): k is number => k !== undefined).sort((a, b) => a - b);
    if (!ks.length) report.warnings.push(`Condição ${i + 1}: não está ativa em nenhum passo`);
    if (ks.length < stepIdx.size) for (let j = n0; j < loads.length; j++) loads[j].steps = ks;
  });
  function loadCase(l: FemStudy["loads"][number], i: number) {
    if (l.kind === "gravity") { loads.push({ kind: "gravity", g: n3(l.g, sc, "Gravidade") }); return; }
    if (l.kind === "pointForce") { loads.push({ kind: "pointForce", point: n3(l.point, sc, `Condição ${i + 1}: ponto`), f: n3(l.f, sc, `Condição ${i + 1}: força`) }); return; }
    const g = loadGroup(i, l.kind);
    const edges = loadEdges(s, l);
    if (edges.length) {
      if (loadFaces(s, l).length) throw new Error(`Condição ${i + 1}: escolha faces ou arestas, não ambas`);
      edgeGroups[g] = geo.edgeTags(edges, `Condição ${i + 1}`);
      edgeLength[g] = edgeGroups[g].reduce((a, t) => a + edgeProps(geo.edges[t - 1]).length, 0);
    } else groups[g] = tags(loadFaces(s, l), `Condição ${i + 1}`);
    if (l.kind === "symmetry") {
      // simetria: o deslocamento normal ao plano é nulo (faces planas alinhadas com um eixo); desliza no plano
      const byAxis: number[][] = [[], [], []];
      for (const t of groups[g]) {
        const f = faces.find((x) => x.tag === t)!;
        const k = f.normal ? f.normal.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-6) : -1;
        if (k < 0) throw new Error(`Condição ${i + 1} (simetria): a face ${f.name} tem de ser plana e alinhada com X, Y ou Z`);
        byAxis[k].push(t);
      }
      delete groups[g];
      byAxis.forEach((ts, k) => {
        if (!ts.length) return;
        const gk = `${g}_${"XYZ"[k]}`;
        groups[gk] = ts;
        loads.push({ kind: "displacement", group: gk, u: [0, 1, 2].map((q) => (q === k ? 0 : null)) });
      });
      return;
    }
    switch (l.kind) {
      case "fixed": loads.push({ kind: "fixed", group: g }); break;
      case "displacement": {
        const csys = loadCsys(l.csys, sc, i);
        loads.push({ kind: "displacement", group: g, u: [l.ux, l.uy, l.uz].map((x, k) => (x === undefined || x === "" ? null : evalParam(x, sc, `Deslocamento ${"XYZ"[k]}`))), ...(csys && { csys }) });
        break;
      }
      case "force": {
        const csys = loadCsys(l.csys, sc, i), f = n3(l.f, sc, "Força");
        if (csys?.type === "cyl") throw new Error(`Condição ${i + 1} (força): a força total só aceita um referencial retangular (para cargas radiais use uma pressão)`);
        // força total num referencial retangular: as mesmas componentes globais em todos os nós
        loads.push({ kind: "force", group: g, f: csys ? csysToGlobal(csysAxes(csys)!, f) : f });
        break;
      }
      case "spring": {
        const k = n3(l.k, sc, "Rigidez da mola"), csys = loadCsys(l.csys, sc, i);
        if (k.some((x) => x < 0)) throw new Error(`Condição ${i + 1} (mola): a rigidez não pode ser negativa`);
        loads.push({ kind: "spring", group: g, k, ...(csys && { csys }) });
        break;
      }
      case "mass": {
        const m = evalParam(l.m, sc, "Massa");
        if (m < 0) throw new Error(`Condição ${i + 1} (massa): a massa não pode ser negativa`);
        loads.push({ kind: "mass", group: g, m: m / 1000 }); // kg → t
        break;
      }
      case "coupling": {
        if (l.mode === "distributing" && edges.length) throw new Error(`Condição ${i + 1} (acoplamento distribuído): escolha faces (as arestas só aceitam o acoplamento rígido)`);
        const z = (v?: [Expr, Expr, Expr], w = "") => (v ? n3(v, sc, `Condição ${i + 1}: ${w}`) : [0, 0, 0] as V3);
        loads.push({ kind: "coupling", group: g, point: n3(l.point, sc, `Condição ${i + 1}: ponto`), mode: l.mode, f: z(l.f, "força"), mo: z(l.mo, "momento") });
        break;
      }
      case "pressure": loads.push({ kind: "pressure", group: g, p: evalParam(l.p, sc, "Pressão") }); break;
      case "temperature": loads.push({ kind: "temperature", group: g, t: evalParam(l.t, sc, "Temperatura") }); break;
      case "convection": loads.push({ kind: "convection", group: g, h: evalParam(l.h, sc, "Coeficiente h"), tInf: evalParam(l.tInf, sc, "Temperatura do fluido") }); break;
      case "heatFlux": loads.push({ kind: "heatFlux", group: g, q: evalParam(l.q, sc, "Fluxo de calor") }); break;
    }
  }
  const local = (s.mesh.local ?? []).map((l, i) => {
    const g = `R${i + 1}`;
    groups[g] = tags(l.faces, `Refinamento ${i + 1}`);
    return { group: g, size: evalParam(l.size, sc, "Tamanho local") };
  });
  const probes = (s.probes ?? []).map((pr, i) => {
    const key = `probe${i + 1}`;
    if (pr.at.kind === "faces") {
      groups[`P${i + 1}`] = tags(pr.at.faces, `Sonda ${pr.name || i + 1}`);
      return { key, name: pr.name || `Sonda ${i + 1}`, quantity: pr.quantity, group: `P${i + 1}`, stat: pr.stat };
    }
    return { key, name: pr.name || `Sonda ${i + 1}`, quantity: pr.quantity, point: n3(pr.at.point, sc, `Sonda ${i + 1}`) };
  });
  const size = evalParam(s.mesh.size, sc, "Tamanho da malha");
  if (size <= 0) throw new Error("Tamanho da malha: tem de ser positivo");
  // malha manual: seeds, faces mapeadas e hexaedros
  const element = s.mesh.element ?? "tet";
  const shell = s.shell ? shellCheck(s, sc, tags) : undefined;
  const localSize = new Map<number, number>();
  for (const l of local) for (const t of groups[l.group]) localSize.set(t, Math.min(l.size, localSize.get(t) ?? Infinity));
  const plan = element === "hex" || s.mesh.seeds?.length || s.mesh.mapped?.length ? meshPlan({
    solids: geo.solids, faces: geo.faces, edges: geo.edges, size, localSize, element, hexMethod: s.mesh.hexMethod ?? "auto", names: geo.names,
    seeds: (s.mesh.seeds ?? []).map((sd, i) => ({ tags: geo.edgeTags(sd.edges, `Seed ${i + 1}`), mode: sd.mode, value: evalParam(sd.value, sc, `Seed ${i + 1}`), bias: sd.bias === undefined || sd.bias === "" ? 1 : evalParam(sd.bias, sc, `Seed ${i + 1}: razão`), biasAt: sd.biasAt ?? "start" })),
    mapped: s.mesh.mapped?.length ? tags(s.mesh.mapped, "Faces mapeadas") : [],
  }) : undefined;
  report.warnings.push(...(plan?.warnings ?? []));
  const meshHyp = shell
    ? `Malha: cascas triangulares de ordem ${s.mesh.order} (${s.mesh.order === 2 ? "S6" : "S3"}, Gmsh), tamanho máx. ${size} mm — confirmar a convergência refinando`
    : element === "hex"
    ? `Malha: ${plan!.notes.join("; ")}, elementos ${HEX_NAME(s.mesh.order, s.mesh.integration)} (Gmsh), tamanho ${size} mm — confirmar a convergência refinando e a qualidade (pré-visualização da malha)`
    : `Malha: tetraedros de ordem ${s.mesh.order} (Gmsh), tamanho máx. ${size} mm${plan?.notes.length ? `; ${plan.notes.join("; ")}` : ""} — confirmar a convergência refinando`;
  const thermal = s.analysis === "thermal";
  if (thermal && !s.loads.some((l) => l.kind === "temperature" || l.kind === "convection")) report.warnings.push("Térmica sem temperatura nem convecção imposta: o problema não tem solução única");
  if (!thermal && s.analysis !== "modal" && !s.loads.some((l) => l.kind === "fixed" || l.kind === "displacement" || l.kind === "symmetry" || l.kind === "spring")) report.warnings.push("Sem apoios: movimento de corpo rígido");
  const nl = s.analysis === "static" && (s.nonlinear?.geometry || s.nonlinear?.plasticity)
    ? { geometry: !!s.nonlinear.geometry, plasticity: !!s.nonlinear.plasticity, increments: Math.max(1, Math.round(s.nonlinear.increments ?? 10)) } : undefined;
  const m = s.material;
  if (nl?.plasticity && !(m.yield! > 0)) throw new Error("Plasticidade: indique a tensão de cedência do material");
  const curve = nl?.plasticity ? m.plasticCurve : undefined;
  if (curve?.length) { const e = plasticCurveErrors(m); if (e.length) throw new Error(`Plasticidade: ${e[0]}`); }
  else if (nl?.plasticity && !(m.tangent! >= 0 && m.tangent! < m.E)) throw new Error("Plasticidade: o módulo tangente tem de estar entre 0 e E");
  if (s.solver === "openradioss" && s.analysis !== "dynamic") throw new Error("OpenRadioss: escolha a análise «Dinâmica transitória» (explícita)");
  // dinâmica: duração, passo, amplitude e Rayleigh resolvidos
  let dynamic: FemCase["dynamic"];
  if (s.analysis === "dynamic") {
    const d = s.dynamic ?? { scheme: "implicit", duration: 0.01, load: "step" };
    const T = evalParam(d.duration, sc, "Duração");
    if (!(T > 0)) throw new Error("Dinâmica: a duração tem de ser positiva");
    const opt = (x: unknown, label: string) => (x === undefined || x === "" ? undefined : evalParam(x as never, sc, label));
    const dt = opt(d.dt, "Passo de tempo") ?? (d.scheme === "implicit" ? T / 200 : undefined);
    if (dt !== undefined && !(dt > 0 && dt <= T)) throw new Error("Dinâmica: o passo tem de estar entre 0 e a duração");
    const rise = opt(d.rise, "Tempo de subida"), period = opt(d.period, "Período");
    if ((d.load === "halfsine" || d.load === "sine") && !(period! > 0)) throw new Error("Dinâmica: indique o período (ou a duração do meio seno)");
    const alpha = opt(d.alpha, "Rayleigh α") ?? 0, beta = opt(d.beta, "Rayleigh β") ?? 0;
    if (alpha < 0 || beta < 0) throw new Error("Dinâmica: os coeficientes de Rayleigh não podem ser negativos");
    dynamic = { scheme: d.scheme, duration: T, dt, amplitude: amplitudeTable(d.load, T, rise, period), alpha, beta, frames: Math.min(400, Math.max(5, Math.round(d.frames ?? 50))) };
    if (s.solver === "openradioss" && d.scheme !== "explicit") throw new Error("OpenRadioss: só integração explícita");
    if (s.solver === "code_aster" && d.scheme === "explicit") report.warnings.push("code_aster explícito (DIFF_CENT): lento e só com integração completa — para impacto use o CalculiX (ou o OpenRadioss)");
  }
  const LOAD_NAME = { step: "degrau", ramp: "rampa", halfsine: "meio seno", sine: "seno" } as const;
  const analysisHyp = dynamic
    ? `${FEM_HYP.dynamic}; ${dynamic.scheme === "implicit" ? "integração implícita (CalculiX: α-HHT, α = −0,05; code_aster: Newmark, aceleração média)" : "integração explícita (diferenças centrais, massa diagonal, passo abaixo do limite de estabilidade)"}; ${dynamic.duration} s${dynamic.dt ? `, passo ${dynamic.dt} s` : ", passo estável da malha"}; carga em ${LOAD_NAME[s.dynamic?.load ?? "step"]}; ${dynamic.alpha || dynamic.beta ? `amortecimento de Rayleigh α = ${dynamic.alpha} 1/s, β = ${dynamic.beta} s` : "sem amortecimento físico"}`
    : !nl ? FEM_HYP[s.analysis]
    : `Estática não linear (${[nl.geometry && "grandes deslocamentos e rotações", nl.plasticity && `plasticidade de von Mises com encruamento isotrópico ${curve?.length ? "multilinear" : "bilinear"}`].filter(Boolean).join("; ")}), carga aplicada em ${nl.increments}+ incrementos, cargas de direção fixa, sem contacto`;
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: s.solver ?? "calculix", title: s.name, analysis: s.analysis, modes: s.modes ?? 6, nonlinear: nl, dynamic, ...(stepIdx.size ? { steps: s.steps!.map((st, k) => st.name || `Passo ${k + 1}`) } : {}), probes: probes.length ? probes : undefined,
    ...(shell ? { shell } : {}), material: s.material, groups, ...(Object.keys(edgeGroups).length ? { edgeGroups, edgeLength } : {}), faces, loads, bbox: box,
    mesh: {
      size, minSize: evalParam(s.mesh.minSize, sc, "Tamanho mínimo", size / 10), curvature: s.mesh.curvature ?? 12, order: s.mesh.order, local,
      ...(element === "hex" ? { element, integration: s.mesh.integration ?? (s.mesh.order === 2 ? "reduced" : "incompatible") } : {}),
      ...(plan && !shell ? { hexMethod: plan.hexMethod, volumes: plan.volumes, surfaces: plan.surfaces, curves: plan.curves } : {}),
    },
    hypotheses: [
      analysisHyp,
      `Material: ${m.name} (E = ${m.E} MPa, ν = ${m.nu}${thermal ? `, k = ${m.k} W/(m·K)` : `, ρ = ${m.density} g/cm³`}${nl?.plasticity ? `, σy = ${m.yield} MPa, ${curve?.length ? `curva σ–εp com ${curve.length} pontos até ${curve[curve.length - 1][0]} MPa (plástico perfeito depois)` : `Et = ${m.tangent} MPa`}` : ""})${m.source ? ` — ${m.source}` : ""}`,
      meshHyp,
      ...(shell ? [shell.plies
        ? `Casca laminada (Mindlin, S6, *SHELL SECTION COMPOSITE) na superfície média da chapa: ${shell.plies.length} camadas [${shell.plies.map((p) => `${p.theta}°`).join("/")}] da base para o topo, espessura total ${shell.thickness} mm; ângulos medidos a partir do eixo x projetado na superfície; camadas ortotrópicas (E3 = E2, G13 = G12); tensões da camada e da altura com maior von Mises; a pressão atua segundo a normal da superfície`
        : `Casca de Mindlin (corte transversal incluído) na superfície média da chapa, espessura uniforme ${shell.thickness} mm; tensões no topo e na base (±t/2) da casca; a pressão atua segundo a normal da superfície`] : []),
      ...(shell?.regions?.length ? [`Laminado por regiões: ${shell.regions.map((r, i) => `região ${i + 1} (faces ${r.faces.join(", ")}): [${r.plies.map((p) => `${p.theta}°`).join("/")}], ${+r.plies.reduce((a, p) => a + p.t, 0).toFixed(6)} mm`).join("; ")}; o resto da chapa fica com ${shell.plies ? "o laminado base" : `a casca isotrópica de ${shell.thickness} mm`}. Todas as secções com o mesmo número de camadas (a mais espessa é dividida em partes iguais) para o ccx dar tensões em todas; a superfície média é a mesma em todas as regiões (sem desvio)`] : []),
      "Forças distribuídas uniformemente pela área das faces; apoios ideais (rígidos)",
      ...(stepIdx.size ? [`${stepIdx.size} passos de carga sequenciais: cada passo parte do estado final do anterior (deslocamentos e, com plasticidade, deformações permanentes); molas e massas ativas em todos`] : []),
      ...(Object.keys(edgeGroups).length ? ["Condições em arestas: força distribuída uniformemente pelo comprimento, apoio nos nós da aresta; a tensão junto à aresta é singular (depende da malha) — ler os resultados a uma distância de alguns elementos"] : []),
      ...(s.loads.some((l) => l.kind === "symmetry") ? ["Simetria: modelo parcial — geometria, apoios e cargas têm de ser simétricos em relação ao plano; as cargas são as da parte modelada (metade da total) e os resultados só valem nessa parte"] : []),
      "Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado",
    ],
  };
}

/** Nós de uma aresta na pré-visualização das seeds (malha ao vivo, sem Gmsh). */
export interface SeedEdge { tag: number; n: number; kind: "user" | "propagated" | "auto"; progression?: number; bump?: number; points: number[] }
export interface SeedPreview { edges: SeedEdge[]; warnings: string[]; notes: string[] }

/**
 * Frações (0..1, ao longo do comprimento) dos n+1 nós de uma aresta com a distribuição do Gmsh:
 * Progression r = elementos de comprimento r^i a partir do início; Bump b aproximado por um tamanho
 * 1 + (1/b − 1)·4x(1−x) (b < 1: refinado nas pontas; b > 1: no centro).
 */
export function seedFractions(n: number, d: { progression?: number; bump?: number } = {}): number[] {
  if (d.progression && d.progression !== 1) {
    const l = Array.from({ length: n }, (_, i) => d.progression! ** i);
    const tot = l.reduce((a, b) => a + b, 0);
    let acc = 0;
    return [0, ...l.map((x) => (acc += x) / tot)].map((x, i) => (i === n ? 1 : x));
  }
  if (d.bump && d.bump !== 1) {
    // densidade 1/tamanho integrada numericamente e invertida
    const m = 400, k = 1 / d.bump - 1, cum = [0];
    for (let i = 0; i < m; i++) { const x = (i + 0.5) / m; cum.push(cum[i] + 1 / (1 + k * 4 * x * (1 - x))); }
    const out = [0];
    for (let j = 1, i = 0; j < n; j++) {
      const target = (cum[m] * j) / n;
      while (cum[i + 1] < target) i++;
      out.push((i + (target - cum[i]) / (cum[i + 1] - cum[i])) / m);
    }
    return [...out, 1];
  }
  return Array.from({ length: n + 1 }, (_, i) => i / n);
}

/** Pontos às frações dadas do comprimento da aresta (amostragem do parâmetro e interpolação por arco). */
function pointsAlong(edge: TopoDS_Shape, fr: number[]): number[] {
  const s = sampleEdge(edge, 200), cum = [0];
  for (let i = 1; i < s.length; i++) cum.push(cum[i - 1] + Math.hypot(s[i].p[0] - s[i - 1].p[0], s[i].p[1] - s[i - 1].p[1], s[i].p[2] - s[i - 1].p[2]));
  const L = cum[cum.length - 1] || 1, out: number[] = [];
  let i = 0;
  for (const f of fr) {
    const target = f * L;
    while (i < s.length - 2 && cum[i + 1] < target) i++;
    const u = cum[i + 1] > cum[i] ? Math.min(1, Math.max(0, (target - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
    for (let k = 0; k < 3; k++) out.push(s[i].p[k] + (s[i + 1].p[k] - s[i].p[k]) * u);
  }
  return out;
}

/**
 * Pré-visualização das seeds de um estudo FEM: n.º e posição dos nós em todas as arestas do corpo,
 * calculados pelo mesmo plano da malha que vai para o Gmsh (seeds, propagação pelas arestas opostas
 * das faces mapeadas e tamanho global/local nas restantes). Tolerante: entradas inválidas viram avisos.
 */
export function seedPreview(ctx: Ctx, s: FemStudy): SeedPreview {
  const report: StepReport = { warnings: [] };
  const warnings: string[] = [];
  const sh = s.shell ? shellOf(ctx) : undefined;
  const solid = sh ? sh.shape : bodyOf(ctx);
  const faces = sh ? caseFaces(ctx, solid, sh.faces) : caseFaces(ctx, solid);
  const allFaces = explore(solid, "face"), allEdges = explore(solid, "edge");
  const sc = ctx.scope;
  const tryDo = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch (e) { warnings.push((e as Error).message); return fallback; } };
  const edgeTags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as arestas`);
    return resolveEdges(ctx, refs, report).map((ne) => allEdges.findIndex((e) => e.IsSame(ne.edge)) + 1).filter((t) => t > 0);
  };
  let size = tryDo(() => evalParam(s.mesh.size, sc, "Tamanho da malha"), NaN);
  if (!(size > 0)) {
    const b = bbox(solid);
    size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 10 || 1;
    warnings.push(`Tamanho da malha inválido: pré-visualização com ${+size.toPrecision(3)} mm`);
  }
  const localSize = new Map<number, number>();
  (s.mesh.local ?? []).forEach((l, i) => tryDo(() => {
    const v = evalParam(l.size, sc, "Tamanho local");
    if (v > 0) for (const t of tagsOf(ctx, faces, solid, l.faces, `Refinamento ${i + 1}`, report)) localSize.set(t, Math.min(v, localSize.get(t) ?? Infinity));
  }, undefined));
  const seeds = (s.mesh.seeds ?? []).flatMap((sd, i) => tryDo(() => {
    const value = evalParam(sd.value, sc, `Seed ${i + 1}`);
    const bias = sd.bias === undefined || sd.bias === "" ? 1 : evalParam(sd.bias, sc, `Seed ${i + 1}: razão`);
    if (!(value > 0) || !(bias >= 1)) throw new Error(`Seed ${i + 1}: valor positivo e razão ≥ 1`);
    return [{ tags: edgeTags(sd.edges, `Seed ${i + 1}`), mode: sd.mode, value, bias, biasAt: sd.biasAt ?? "start" as const }];
  }, []));
  const mapped = s.mesh.mapped?.length ? tryDo(() => tagsOf(ctx, faces, solid, s.mesh.mapped!, "Faces mapeadas", report), []) : [];
  const input: PlanInput = { solids: [solid], faces: allFaces, edges: allEdges, size, localSize, element: s.mesh.element ?? "tet", hexMethod: s.mesh.hexMethod ?? "auto", seeds, mapped };
  let plan: ReturnType<typeof meshPlan> | null = null;
  try { plan = meshPlan(input); } catch (e) {
    warnings.push((e as Error).message);
    plan = tryDo(() => meshPlan({ ...input, hexMethod: "auto", mapped: mapped.filter((f) => { try { meshPlan({ ...input, hexMethod: "auto", mapped: [f] }); return true; } catch { return false; } }) }), null);
  }
  warnings.push(...(plan?.warnings ?? []), ...report.warnings);
  const curves = new Map((plan?.curves ?? []).map((c) => [c.tag, c]));
  // tamanho efetivo das arestas sem curva: o menor entre o global e os locais das faces vizinhas
  const near = new Map<number, number>();
  allFaces.forEach((f, i) => {
    const ls = localSize.get(i + 1);
    if (ls !== undefined) for (const e of explore(f, "edge")) { const t = allEdges.findIndex((x) => x.IsSame(e)) + 1; if (t) near.set(t, Math.min(ls, near.get(t) ?? Infinity)); }
  });
  const edges = allEdges.map((e, i): SeedEdge => {
    const tag = i + 1, c = curves.get(tag);
    if (c) {
      const d = { progression: c.progression, bump: c.bump };
      return { tag, n: c.n, kind: c.user ? "user" : "propagated", ...(c.progression ? { progression: c.progression } : {}), ...(c.bump ? { bump: c.bump } : {}), points: pointsAlong(e, seedFractions(c.n, d)) };
    }
    const n = Math.max(1, Math.ceil(edgeProps(e).length / Math.min(size, near.get(tag) ?? Infinity) - 1e-9));
    return { tag, n, kind: "auto", points: pointsAlong(e, seedFractions(n)) };
  });
  return { edges, warnings: [...new Set(warnings)], notes: plan?.notes ?? [] };
}
