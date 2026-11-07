// Estudos: caso FEM de uma peça (apoios, cargas, malha e hipóteses).
import { type FemStudy, loadFaces } from "../doc/study.ts";
import { evalParam } from "../doc/variables.ts";
import { type TopoRef } from "../doc/types.ts";
import { type Ctx, type StepReport, edges as resolveEdges } from "./context.ts";
import { meshPlan } from "./meshplan.ts";
import { bbox, explore } from "./occ.ts";
import { type CaseFace, type FemCase, type FemCaseLoad, type V3, amplitudeTable, loadGroup } from "../sim/case.ts";
import { type MeshGeo, bodyOf, caseFaces, tagsOf, n3 } from "./sim-common.ts";

const FEM_HYP: Record<FemStudy["analysis"], string> = {
  static: "Estática linear: pequenos deslocamentos e deformações, material elástico linear isotrópico, sem contacto",
  modal: "Modal: frequências próprias com as condições de apoio indicadas (sem cargas, sem amortecimento)",
  buckling: "Encurvadura linear (valores próprios): fatores sobre as cargas indicadas, sem imperfeições nem plasticidade",
  thermal: "Térmica em regime permanente: condução isotrópica, convecção e fluxo impostos, sem radiação",
  dynamic: "Dinâmica transitória linear: pequenos deslocamentos, material elástico linear, cargas com amplitude no tempo, condições iniciais nulas",
};

export function femCase(ctx: Ctx, s: FemStudy, report: StepReport): FemCase {
  const solid = bodyOf(ctx);
  const faces = caseFaces(ctx, solid);
  const b = bbox(solid);
  const allEdges = explore(solid, "edge");
  const edgeTags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as arestas`);
    return resolveEdges(ctx, refs, report).map((ne) => {
      const i = allEdges.findIndex((e) => e.IsSame(ne.edge));
      if (i < 0) throw new Error(`${what}: a aresta "${ne.name}" não pertence ao corpo`);
      return i + 1;
    });
  };
  const geo: MeshGeo = { solids: [solid], faces: explore(solid, "face"), edges: allEdges, edgeTags };
  return buildFemCase(s, ctx.scope, faces, (refs, what) => tagsOf(ctx, faces, solid, refs, what, report), { min: b.min as V3, max: b.max as V3 }, report, geo);
}


/** Caso FEM a partir das faces com tag e de um resolvedor de referências (peça ou montagem). */
const HEX_NAME = (order: 1 | 2, integ: FemStudy["mesh"]["integration"]) => order === 2 ? (integ === "full" ? "C3D20 / HEXA20" : "C3D20R / HEXA20 (integração reduzida)") : integ === "full" ? "C3D8 / HEXA8 (integração completa)" : integ === "reduced" ? "C3D8R / HEXA8 (integração reduzida, controlo de hourglass)" : "C3D8I (modos incompatíveis) / HEXA8";

export function buildFemCase(s: FemStudy, sc: Ctx["scope"], faces: CaseFace[], tags: (refs: TopoRef[], what: string) => number[], box: { min: V3; max: V3 }, report: StepReport, geo: MeshGeo): FemCase {
  const groups: Record<string, number[]> = {};
  const loads: FemCaseLoad[] = [];
  s.loads.forEach((l, i) => {
    if (l.kind === "gravity") { loads.push({ kind: "gravity", g: n3(l.g, sc, "Gravidade") }); return; }
    if (l.kind === "pointForce") { loads.push({ kind: "pointForce", point: n3(l.point, sc, `Condição ${i + 1}: ponto`), f: n3(l.f, sc, `Condição ${i + 1}: força`) }); return; }
    const g = loadGroup(i, l.kind);
    groups[g] = tags(loadFaces(s, l), `Condição ${i + 1}`);
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
      case "displacement": loads.push({ kind: "displacement", group: g, u: [l.ux, l.uy, l.uz].map((x, k) => (x === undefined || x === "" ? null : evalParam(x, sc, `Deslocamento ${"XYZ"[k]}`))) }); break;
      case "force": loads.push({ kind: "force", group: g, f: n3(l.f, sc, "Força") }); break;
      case "pressure": loads.push({ kind: "pressure", group: g, p: evalParam(l.p, sc, "Pressão") }); break;
      case "temperature": loads.push({ kind: "temperature", group: g, t: evalParam(l.t, sc, "Temperatura") }); break;
      case "convection": loads.push({ kind: "convection", group: g, h: evalParam(l.h, sc, "Coeficiente h"), tInf: evalParam(l.tInf, sc, "Temperatura do fluido") }); break;
      case "heatFlux": loads.push({ kind: "heatFlux", group: g, q: evalParam(l.q, sc, "Fluxo de calor") }); break;
    }
  });
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
  const localSize = new Map<number, number>();
  for (const l of local) for (const t of groups[l.group]) localSize.set(t, Math.min(l.size, localSize.get(t) ?? Infinity));
  const plan = element === "hex" || s.mesh.seeds?.length || s.mesh.mapped?.length ? meshPlan({
    solids: geo.solids, faces: geo.faces, edges: geo.edges, size, localSize, element, hexMethod: s.mesh.hexMethod ?? "auto", names: geo.names,
    seeds: (s.mesh.seeds ?? []).map((sd, i) => ({ tags: geo.edgeTags(sd.edges, `Seed ${i + 1}`), mode: sd.mode, value: evalParam(sd.value, sc, `Seed ${i + 1}`), bias: sd.bias === undefined || sd.bias === "" ? 1 : evalParam(sd.bias, sc, `Seed ${i + 1}: razão`), biasAt: sd.biasAt ?? "start" })),
    mapped: s.mesh.mapped?.length ? tags(s.mesh.mapped, "Faces mapeadas") : [],
  }) : undefined;
  report.warnings.push(...(plan?.warnings ?? []));
  const meshHyp = element === "hex"
    ? `Malha: ${plan!.notes.join("; ")}, elementos ${HEX_NAME(s.mesh.order, s.mesh.integration)} (Gmsh), tamanho ${size} mm — confirmar a convergência refinando e a qualidade (pré-visualização da malha)`
    : `Malha: tetraedros de ordem ${s.mesh.order} (Gmsh), tamanho máx. ${size} mm${plan?.notes.length ? `; ${plan.notes.join("; ")}` : ""} — confirmar a convergência refinando`;
  const thermal = s.analysis === "thermal";
  if (thermal && !s.loads.some((l) => l.kind === "temperature" || l.kind === "convection")) report.warnings.push("Térmica sem temperatura nem convecção imposta: o problema não tem solução única");
  if (!thermal && s.analysis !== "modal" && !s.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) report.warnings.push("Sem apoios: movimento de corpo rígido");
  const nl = s.analysis === "static" && (s.nonlinear?.geometry || s.nonlinear?.plasticity)
    ? { geometry: !!s.nonlinear.geometry, plasticity: !!s.nonlinear.plasticity, increments: Math.max(1, Math.round(s.nonlinear.increments ?? 10)) } : undefined;
  const m = s.material;
  if (nl?.plasticity && !(m.yield! > 0)) throw new Error("Plasticidade: indique a tensão de cedência do material");
  if (nl?.plasticity && !(m.tangent! >= 0 && m.tangent! < m.E)) throw new Error("Plasticidade: o módulo tangente tem de estar entre 0 e E");
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
    : `Estática não linear (${[nl.geometry && "grandes deslocamentos e rotações", nl.plasticity && "plasticidade de von Mises com encruamento isotrópico bilinear"].filter(Boolean).join("; ")}), carga aplicada em ${nl.increments}+ incrementos, cargas de direção fixa, sem contacto`;
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: s.solver ?? "calculix", title: s.name, analysis: s.analysis, modes: s.modes ?? 6, nonlinear: nl, dynamic, probes: probes.length ? probes : undefined,
    material: s.material, groups, faces, loads, bbox: box,
    mesh: {
      size, minSize: evalParam(s.mesh.minSize, sc, "Tamanho mínimo", size / 10), curvature: s.mesh.curvature ?? 12, order: s.mesh.order, local,
      ...(element === "hex" ? { element, integration: s.mesh.integration ?? (s.mesh.order === 2 ? "reduced" : "incompatible") } : {}),
      ...(plan ? { hexMethod: plan.hexMethod, volumes: plan.volumes, surfaces: plan.surfaces, curves: plan.curves } : {}),
    },
    hypotheses: [
      analysisHyp,
      `Material: ${m.name} (E = ${m.E} MPa, ν = ${m.nu}${thermal ? `, k = ${m.k} W/(m·K)` : `, ρ = ${m.density} g/cm³`}${nl?.plasticity ? `, σy = ${m.yield} MPa, Et = ${m.tangent} MPa` : ""})${m.source ? ` — ${m.source}` : ""}`,
      meshHyp,
      "Forças distribuídas uniformemente pela área das faces; apoios ideais (rígidos)",
      ...(s.loads.some((l) => l.kind === "symmetry") ? ["Simetria: modelo parcial — geometria, apoios e cargas têm de ser simétricos em relação ao plano; as cargas são as da parte modelada (metade da total) e os resultados só valem nessa parte"] : []),
      "Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado",
    ],
  };
}
