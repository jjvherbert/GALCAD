// Verificação dos dados do modelo de simulação (como o «Model Check» do Abaqus/CAE e o «Model
// Info → Check» do Femap) e matriz de compatibilidade por solver. Corre sobre o estudo, sem o
// núcleo nem o agente: apanha logo o que o solver só diria tarde ou mal (condições sem faces,
// análise que o solver não faz, material impossível, apoios em falta). `erro` bloqueia o cálculo,
// `aviso` não; os rótulos do que cada solver faz vêm do que os adaptadores deste repositório
// implementam e estão verificados, não do que o solver em geral sabe fazer.
import { type CfdStudy, type FemLoad, type FemStudy, type Study, loadFaces } from "../doc/study.ts";

export type CheckLevel = "erro" | "aviso" | "info";
/** Secção do modelo onde se corrige (as mesmas da árvore). */
export type CheckWhere = "study" | "material" | "conditions" | "contact" | "mesh" | "probes" | "run" | "sets";
export interface CheckItem { level: CheckLevel; where: CheckWhere; text: string }

export type Solver = FemStudy["solver"] | CfdStudy["solver"];
export type Support = "sim" | "parcial" | "nao";
export interface Capability { feature: string; group: string; calculix: Support; code_aster: Support; openradioss: Support; note?: string }

const LOAD_LABEL: Record<FemLoad["kind"], string> = {
  fixed: "Encastramento", displacement: "Deslocamento imposto", symmetry: "Simetria", pointForce: "Força pontual", force: "Força", pressure: "Pressão", gravity: "Gravidade",
  temperature: "Temperatura", convection: "Convecção", heatFlux: "Fluxo de calor",
};

/**
 * O que cada solver faz neste software. `parcial` = faz com restrições (ver a nota). Fontes: adaptadores
 * `src/sim/calculix.ts`, `aster.ts` e `radioss.ts` e os testes de referência.
 */
export const CAPABILITIES: Capability[] = [
  { group: "Análise", feature: "Estática linear", calculix: "sim", code_aster: "sim", openradioss: "nao", note: "OpenRadioss só resolve dinâmica explícita" },
  { group: "Análise", feature: "Modal (frequências próprias)", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Análise", feature: "Encurvadura linear", calculix: "sim", code_aster: "nao", openradioss: "nao", note: "code_aster ainda sem adaptador de encurvadura" },
  { group: "Análise", feature: "Térmica em regime permanente", calculix: "sim", code_aster: "nao", openradioss: "nao" },
  { group: "Análise", feature: "Dinâmica implícita", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Análise", feature: "Dinâmica explícita", calculix: "sim", code_aster: "parcial", openradioss: "sim", note: "code_aster explícito é lento e só com integração completa; OpenRadioss é o indicado para impacto" },
  { group: "Não linear", feature: "Grandes deslocamentos", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Não linear", feature: "Plasticidade (von Mises bilinear)", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Elementos", feature: "Tetraedros lineares (4 nós)", calculix: "sim", code_aster: "sim", openradioss: "sim" },
  { group: "Elementos", feature: "Tetraedros quadráticos (10 nós)", calculix: "sim", code_aster: "sim", openradioss: "nao", note: "o explícito do OpenRadioss usa elementos lineares" },
  { group: "Elementos", feature: "Hexaedros lineares (8 nós)", calculix: "sim", code_aster: "sim", openradioss: "sim", note: "CalculiX: C3D8I por omissão; code_aster: 3D_SI; OpenRadioss: Isolid 24" },
  { group: "Elementos", feature: "Hexaedros quadráticos (20 nós)", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Condições", feature: "Encastramento", calculix: "sim", code_aster: "sim", openradioss: "sim" },
  { group: "Condições", feature: "Simetria (plano)", calculix: "sim", code_aster: "sim", openradioss: "sim", note: "faces planas alinhadas com X, Y ou Z" },
  { group: "Condições", feature: "Deslocamento imposto", calculix: "sim", code_aster: "sim", openradioss: "parcial", note: "OpenRadioss: só deslocamento nulo (use forças)" },
  { group: "Condições", feature: "Força nas faces", calculix: "sim", code_aster: "sim", openradioss: "sim" },
  { group: "Condições", feature: "Força pontual (nó mais próximo)", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Condições", feature: "Pressão", calculix: "sim", code_aster: "sim", openradioss: "sim" },
  { group: "Condições", feature: "Gravidade", calculix: "sim", code_aster: "sim", openradioss: "sim" },
  { group: "Condições", feature: "Temperatura, convecção, fluxo de calor", calculix: "sim", code_aster: "nao", openradioss: "nao" },
  { group: "Montagens", feature: "Contacto colado entre corpos", calculix: "sim", code_aster: "sim", openradioss: "nao" },
  { group: "Montagens", feature: "Contacto com atrito e separação", calculix: "sim", code_aster: "nao", openradioss: "nao" },
  { group: "Resultados", feature: "Sondas e histórias no tempo", calculix: "sim", code_aster: "sim", openradioss: "sim" },
];

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

/** Nome da capacidade que o estudo usa (para a matriz realçar o que interessa). */
export function usedFeatures(s: FemStudy): string[] {
  const used: string[] = [];
  const dyn = s.dynamic;
  used.push({ static: "Estática linear", modal: "Modal (frequências próprias)", buckling: "Encurvadura linear", thermal: "Térmica em regime permanente", dynamic: dyn?.scheme === "explicit" ? "Dinâmica explícita" : "Dinâmica implícita" }[s.analysis]);
  if (s.analysis === "static" && s.nonlinear?.geometry) used.push("Grandes deslocamentos");
  if (s.analysis === "static" && s.nonlinear?.plasticity) used.push("Plasticidade (von Mises bilinear)");
  const hex = s.mesh.element === "hex";
  used.push(hex ? (s.mesh.order === 1 ? "Hexaedros lineares (8 nós)" : "Hexaedros quadráticos (20 nós)") : (s.mesh.order === 1 ? "Tetraedros lineares (4 nós)" : "Tetraedros quadráticos (10 nós)"));
  for (const l of s.loads) {
    used.push(l.kind === "fixed" ? "Encastramento" : l.kind === "symmetry" ? "Simetria (plano)" : l.kind === "displacement" ? "Deslocamento imposto" : l.kind === "force" ? "Força nas faces" : l.kind === "pointForce" ? "Força pontual (nó mais próximo)" : l.kind === "pressure" ? "Pressão" : l.kind === "gravity" ? "Gravidade" : "Temperatura, convecção, fluxo de calor");
  }
  if (s.probes?.length) used.push("Sondas e histórias no tempo");
  if (s.contact?.mode === "bonded") used.push("Contacto colado entre corpos");
  if (s.contact?.mode === "friction") used.push("Contacto com atrito e separação");
  return [...new Set(used)];
}

/** Veredito de um solver para o estudo: o pior estado entre as capacidades usadas. */
export function solverVerdict(s: FemStudy, solver: FemStudy["solver"]): { support: Support; reasons: string[] } {
  const reasons: string[] = [];
  let worst: Support = "sim";
  for (const name of usedFeatures(s)) {
    const c = CAPABILITIES.find((x) => x.feature === name);
    if (!c) continue;
    const v = c[solver];
    if (v === "nao") { worst = "nao"; reasons.push(`${name}: não suportado${c.note ? ` (${c.note})` : ""}`); }
    else if (v === "parcial") { if (worst === "sim") worst = "parcial"; reasons.push(`${name}: parcial${c.note ? ` (${c.note})` : ""}`); }
  }
  return { support: worst, reasons };
}

/** Verificação de um estudo FEM. */
function checkFem(s: FemStudy, assembly: boolean): CheckItem[] {
  const out: CheckItem[] = [];
  const add = (level: CheckLevel, where: CheckWhere, text: string) => out.push({ level, where, text });
  const solver = s.solver ?? "calculix";
  const thermal = s.analysis === "thermal";
  const SOLVER = { calculix: "CalculiX", code_aster: "code_aster", openradioss: "OpenRadioss" }[solver];

  // compatibilidade analisada pela matriz: o que o solver escolhido não faz é erro
  const v = solverVerdict(s, solver);
  for (const r of v.reasons) if (/não suportado/.test(r)) add("erro", "study", `${SOLVER}: ${r}`);
  for (const r of v.reasons) if (/parcial/.test(r)) add("aviso", "study", `${SOLVER}: ${r}`);
  if (v.support === "nao") {
    const alt = (["calculix", "code_aster", "openradioss"] as const).find((x) => x !== solver && solverVerdict(s, x).support === "sim");
    if (alt) add("info", "study", `Este estudo é suportado por ${{ calculix: "CalculiX", code_aster: "code_aster", openradioss: "OpenRadioss" }[alt]}: mude o solver na secção Estudo`);
  }

  // material
  const m = s.material;
  if (!(m.E > 0)) add("erro", "material", "Módulo de Young E tem de ser positivo");
  if (!(m.nu > -1 && m.nu < 0.5)) add("erro", "material", "Coeficiente de Poisson fora de (−1; 0,5): o material seria instável ou incompressível");
  const needsDensity = s.analysis === "modal" || s.analysis === "dynamic" || s.loads.some((l) => l.kind === "gravity");
  if (needsDensity && !(m.density > 0)) add("erro", "material", "A massa volúmica tem de ser positiva (modal, dinâmica e gravidade usam a massa)");
  if (thermal && !(num(m.k) && m.k! > 0)) add("aviso", "material", "Sem condutividade térmica k: usa-se 50 W/(m·K)");
  if (s.nonlinear?.plasticity && !(m.yield! > 0)) add("erro", "material", "Plasticidade: falta a tensão de cedência do material");
  if (s.nonlinear?.plasticity && !(m.tangent! >= 0 && m.tangent! < m.E)) add("erro", "material", "Plasticidade: o módulo tangente tem de estar entre 0 e E");

  // condições
  s.loads.forEach((l, i) => {
    const name = `Condição ${i + 1} (${LOAD_LABEL[l.kind]})`;
    if ("faces" in l && loadFaces(s, l).length === 0) add("erro", "conditions", `${name}: sem faces — escolha as faces no 3D`);
    if ((l.kind === "force" || l.kind === "pointForce") && l.f.every((x) => num(x) === 0)) add("aviso", "conditions", `${name}: força nula`);
    if (l.kind === "pressure" && num(l.p) === 0) add("aviso", "conditions", `${name}: pressão nula`);
    if (l.kind === "gravity" && l.g.every((x) => num(x) === 0)) add("aviso", "conditions", `${name}: gravidade nula`);
    if (l.kind === "displacement" && [l.ux, l.uy, l.uz].every((x) => x === undefined || x === "")) add("aviso", "conditions", `${name}: nenhuma direção impedida nem imposta`);
    if (l.kind === "convection" && num(l.h) !== undefined && !(num(l.h)! > 0)) add("aviso", "conditions", `${name}: h tem de ser positivo`);
    const thermalKind = l.kind === "temperature" || l.kind === "convection" || l.kind === "heatFlux";
    if (thermalKind && !thermal) add("erro", "conditions", `${name}: condição térmica num estudo ${s.analysis === "static" ? "estrutural" : s.analysis}`);
    if (!thermalKind && thermal) add("erro", "conditions", `${name}: condição estrutural num estudo térmico`);
  });
  const supports = s.loads.filter((l) => l.kind === "fixed" || l.kind === "displacement" || l.kind === "symmetry").length;
  const loads = s.loads.filter((l) => l.kind === "force" || l.kind === "pointForce" || l.kind === "pressure" || l.kind === "gravity").length;
  if (!thermal && s.analysis !== "modal" && !supports && !assembly) add("aviso", "conditions", "Sem apoios: o modelo pode mover-se como corpo rígido (a matriz de rigidez fica singular)");
  if (!thermal && s.analysis === "modal" && !supports) add("info", "conditions", "Modal sem apoios: aparecem modos de corpo rígido com frequência ≈ 0 Hz");
  if (!thermal && s.analysis !== "modal" && !loads && s.analysis !== "buckling") add("aviso", "conditions", "Sem cargas: o resultado será nulo");
  if (s.analysis === "buckling" && !loads) add("erro", "conditions", "Encurvadura: indique a carga de referência (força ou pressão)");
  if (thermal && !s.loads.some((l) => l.kind === "temperature" || l.kind === "convection")) add("erro", "conditions", "Térmica sem temperatura nem convecção imposta: o problema não tem solução única");

  // malha
  const size = num(s.mesh.size);
  if (size !== undefined && !(size > 0)) add("erro", "mesh", "O tamanho da malha tem de ser positivo");
  if (solver === "openradioss" && s.mesh.order === 2) add("erro", "mesh", "OpenRadioss: o explícito usa elementos lineares (ordem 1)");
  if (s.mesh.element === "hex" && s.mesh.hexMethod === "structured" && !assembly) add("info", "mesh", "Hexaedros estruturados só existem em volumes de 6 faces de 4 arestas; noutras peças use a subdivisão");
  const dt = s.dynamic;
  if (s.analysis === "dynamic" && dt && num(dt.duration) !== undefined && !(num(dt.duration)! > 0)) add("erro", "study", "Dinâmica: a duração tem de ser positiva");
  if (s.analysis === "dynamic" && (dt?.load === "halfsine" || dt?.load === "sine") && (dt.period === undefined || dt.period === "")) add("erro", "study", "Dinâmica: indique o período (ou a duração do meio seno)");

  // sondas e convergência
  const emptyProbe = (s.probes ?? []).findIndex((p) => p.at.kind === "faces" && p.at.faces.length === 0);
  if (emptyProbe >= 0) add("erro", "probes", `Sonda ${emptyProbe + 1}: sem faces`);
  if (!(s.probes ?? []).length && s.analysis !== "modal") add("info", "probes", "Sem sondas: o estudo de convergência segue o deslocamento máximo, que depende pouco da malha mas esconde singularidades");

  // montagens
  if (assembly && s.contact?.mode === "friction" && solver === "code_aster") add("erro", "contact", "code_aster: contacto com atrito ainda sem adaptador (use o CalculiX)");
  if (assembly && s.contact?.mode === "none") add("aviso", "contact", "Contacto «sem ligação»: os corpos movem-se independentes e precisam de apoios próprios");
  return out;
}

function checkCfd(s: CfdStudy): CheckItem[] {
  const out: CheckItem[] = [];
  const add = (level: CheckLevel, where: CheckWhere, text: string) => out.push({ level, where, text });
  if (s.regime === "internal") {
    if (!s.inlet?.faces.length) add("erro", "conditions", "Faltam as faces de entrada");
    if (!s.outlet?.faces.length) add("erro", "conditions", "Faltam as faces de saída");
    if (s.inlet && s.inlet.velocity.every((x) => num(x) === 0)) add("erro", "conditions", "Velocidade de entrada nula");
  } else if (s.freestream && s.freestream.velocity.every((x) => num(x) === 0)) add("erro", "conditions", "Velocidade do escoamento livre nula");
  if (!(s.fluid.rho > 0) || !(s.fluid.nu > 0)) add("erro", "conditions", "O fluido precisa de massa volúmica e viscosidade positivas");
  if (!(s.iterations > 0)) add("erro", "run", "O n.º de iterações tem de ser positivo");
  const size = num(s.mesh.size);
  if (size !== undefined && !(size > 0)) add("erro", "mesh", "O tamanho da malha tem de ser positivo");
  if (s.solver === "su2" && s.turbulence === "kEpsilon") add("aviso", "study", "SU2: o modelo k-ε não está disponível; usa-se SA/SST");
  return out;
}

/** Verifica um estudo; `assembly` quando o estudo é de uma montagem. */
export function checkStudy(s: Study, assembly = false): CheckItem[] {
  const items = s.physics === "fem" ? checkFem(s, assembly) : checkCfd(s);
  const rank = { erro: 0, aviso: 1, info: 2 } as const;
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

export const countLevel = (items: CheckItem[], level: CheckLevel) => items.filter((i) => i.level === level).length;

/** Resumo curto para a árvore: «2 erros · 1 aviso» ou «sem problemas». */
export function checkSummary(items: CheckItem[]): string {
  const e = countLevel(items, "erro"), a = countLevel(items, "aviso");
  if (!e && !a) return "sem problemas";
  return [e && `${e} erro${e > 1 ? "s" : ""}`, a && `${a} aviso${a > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
}
