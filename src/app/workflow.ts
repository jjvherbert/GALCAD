// Fluxo de trabalho guiado de um estudo FEM (C1a): passos pela ordem, estado de cada um
// (por fazer / em curso / concluído / desatualizado, com a razão), validação por passo e o que
// pode ser feito agora. Puro: não importa o store nem o núcleo (os testes correm em node), e
// recebe a geometria já resumida em impressões digitais (`partSnapshot` / `assemblySnapshot`).
//
// Um passo concluído guarda a impressão digital dos seus dados, dos passos a montante de que
// depende e da geometria. Muda os seus dados → «em curso»; muda algo a montante → «desatualizado».

import { type FemStudy, type StepId, type StepStamp, type StudyWorkflow, STRUCT_LOADS, THERMAL_LOADS, newFemStudy } from "../doc/study.ts";
import type { AssemblyDoc } from "../doc/project.ts";
import type { CadDocument } from "../doc/types.ts";
import { type CheckLevel, type CheckWhere, checkStudy } from "../sim/modelcheck.ts";
import type { SimSection } from "./store-state.ts";

export type { StepId } from "../doc/study.ts";
export type StepState = "por fazer" | "em curso" | "concluído" | "desatualizado";

export const STEP_ORDER: StepId[] = ["estudo", "material", "interacoes", "cargas", "malha", "verificar", "correr", "resultados"];

export const STEP_LABEL: Record<StepId, string> = {
  estudo: "Estudo", material: "Material", interacoes: "Interações", cargas: "Apoios e cargas",
  malha: "Malha", verificar: "Verificar", correr: "Correr", resultados: "Resultados",
};

/** Secção do painel de simulação onde se trabalha cada passo. */
export const STEP_SECTION: Record<StepId, SimSection> = {
  estudo: "study", material: "material", interacoes: "contact", cargas: "conditions",
  malha: "mesh", verificar: "check", correr: "run", resultados: "results",
};

/** Passo a que pertence cada aviso da verificação do modelo. */
export const WHERE_STEP: Record<CheckWhere, StepId> = {
  study: "estudo", material: "material", contact: "interacoes", conditions: "cargas",
  sets: "cargas", mesh: "malha", probes: "malha", run: "correr",
};

/** As interações (contacto) só existem nas montagens. */
export function stepsFor(assembly: boolean): StepId[] {
  return assembly ? STEP_ORDER : STEP_ORDER.filter((s) => s !== "interacoes");
}

/** Passo de uma secção do painel (as sondas e a convergência fazem parte da malha). */
export function sectionStep(section: SimSection): StepId {
  if (section === "probes" || section === "convergence") return "malha";
  return (Object.keys(STEP_SECTION) as StepId[]).find((k) => STEP_SECTION[k] === section) ?? "estudo";
}

/** Campos do estudo que pertencem a cada passo (a sua impressão digital). */
export const STEP_FIELDS: Record<StepId, (keyof FemStudy)[]> = {
  estudo: ["analysis", "solver", "nonlinear", "dynamic", "modes"],
  material: ["material", "bodyMaterials", "solidLaminate", "shell"],
  interacoes: ["contact"],
  cargas: ["loads", "steps", "sets"],
  malha: ["mesh", "probes", "convergence"],
  verificar: [], correr: [], resultados: [],
};

/** De que depende cada passo: "geom" e os passos a montante. */
function inputsOf(step: StepId, assembly: boolean): { geom: boolean; up: StepId[] } {
  switch (step) {
    case "estudo": case "material": return { geom: false, up: [] };
    case "interacoes": return { geom: true, up: [] };
    case "cargas": case "malha": return { geom: true, up: ["estudo"] };
    default: return { geom: true, up: ["estudo", "material", ...(assembly ? ["interacoes" as const] : []), "cargas", "malha"] };
  }
}

// ---------- impressões digitais ----------

/** FNV-1a de 32 bits + comprimento (o mesmo algoritmo do `hashText` do núcleo, sem o importar). */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
}

/** JSON com as chaves ordenadas e sem os `undefined` (a ordem dos campos não muda a impressão). */
export function stableJson(v: unknown): string {
  if (v === undefined) return "";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** Impressão digital dos dados de um passo ("" nos passos sem dados próprios). */
export function ownHash(s: FemStudy, step: StepId): string {
  const fields = STEP_FIELDS[step];
  if (!fields.length) return "";
  const pick: Record<string, unknown> = {};
  for (const f of fields) pick[f] = s[f];
  return hashText(stableJson(pick));
}

/** Geometria resumida: uma impressão por operação/componente/ligação e o nome para as razões. */
export interface GeomSnapshot { parts: Record<string, string>; names: Record<string, string> }

/** Peça: as operações antes da barra de rollback (sem o nome), as variáveis e a própria barra. */
export function partSnapshot(doc: Pick<CadDocument, "features" | "variables" | "rollback" | "configurations">): GeomSnapshot {
  const parts: Record<string, string> = {};
  const names: Record<string, string> = {};
  const end = doc.rollback ?? doc.features.length;
  doc.features.slice(0, end).forEach((f) => {
    const { name, ...data } = f;
    parts[f.id] = hashText(stableJson(data));
    names[f.id] = name;
  });
  parts.__vars = hashText(stableJson(doc.variables));
  parts.__rollback = String(doc.rollback ?? "fim");
  if (doc.configurations) parts.__config = hashText(stableJson(doc.configurations));
  return { parts, names };
}

/** Montagem: componentes (sem o nome), ligações e, se dada, a revisão de cada peça usada. */
export function assemblySnapshot(asm: Pick<AssemblyDoc, "components" | "mates" | "variables">, partRev?: (ref: { kind: "part" | "assembly"; id: string }) => { rev: string; name: string } | undefined): GeomSnapshot {
  const parts: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const c of asm.components) {
    const { name, ...data } = c;
    parts[`c:${c.id}`] = hashText(stableJson(data));
    names[`c:${c.id}`] = name;
    const r = partRev?.(c.ref);
    if (r) { parts[`p:${c.ref.id}`] = r.rev; names[`p:${c.ref.id}`] = r.name; }
  }
  for (const m of asm.mates) {
    const { name, ...data } = m;
    parts[`m:${m.id}`] = hashText(stableJson(data));
    names[`m:${m.id}`] = name;
  }
  if (asm.variables) parts.__vars = hashText(stableJson(asm.variables));
  return { parts, names };
}

/** Revisão única da geometria (chave da malha ao vivo, C9b). */
export function geomRev(g: GeomSnapshot): string {
  return hashText(stableJson(g.parts));
}

// ---------- estado dos passos ----------

export function stampStep(s: FemStudy, step: StepId, geom: GeomSnapshot, assembly = false, warn = false): StepStamp {
  const inp = inputsOf(step, assembly);
  const stamp: StepStamp = { own: ownHash(s, step) };
  if (warn) stamp.warn = true;
  if (inp.up.length) stamp.up = Object.fromEntries(inp.up.map((u) => [u, ownHash(s, u)]));
  if (inp.geom) stamp.geom = { ...geom.parts };
  return stamp;
}

function geomReasons(before: Record<string, string>, now: GeomSnapshot): string[] {
  const meta: string[] = [];
  const edits: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(now.parts)]);
  for (const k of keys) {
    const a = before[k];
    const b = now.parts[k];
    if (a === b) continue;
    if (k === "__rollback") meta.unshift("barra de rollback movida");
    else if (k === "__vars") meta.push("variáveis alteradas");
    else if (k === "__config") meta.push("configurações alteradas");
    else if (a === undefined) edits.push(`${k.startsWith("c:") ? "componente adicionado" : k.startsWith("m:") ? "ligação adicionada" : "operação adicionada"} «${now.names[k] ?? k}»`);
    else if (b === undefined) edits.push(k.startsWith("c:") ? "componente removido" : k.startsWith("m:") ? "ligação removida" : k.startsWith("p:") ? "peça removida" : "operação removida");
    else edits.push(`geometria alterada em «${now.names[k] ?? k}»`);
  }
  return [...meta, ...edits];
}

/** `warn`: concluído com avisos (só quando `state` é «concluído»). */
export interface StepInfo { id: StepId; label: string; section: SimSection; state: StepState; reasons: string[]; reason: string; warn?: boolean }

export function stepState(s: FemStudy, step: StepId, geom: GeomSnapshot, assembly = false): Omit<StepInfo, "id" | "label" | "section"> {
  const stamp = s.workflow?.done?.[step];
  if (!stamp) {
    const touched = STEP_FIELDS[step].some((f) => s.workflow?.user?.includes(f));
    return { state: touched ? "em curso" : "por fazer", reasons: [], reason: "" };
  }
  if (stamp.own !== ownHash(s, step)) return { state: "em curso", reasons: [], reason: "" };
  const reasons: string[] = [];
  if (stamp.geom) reasons.push(...geomReasons(stamp.geom, geom));
  for (const u of inputsOf(step, assembly).up) {
    const was = stamp.up?.[u];
    if (was !== undefined && was !== ownHash(s, u)) reasons.push(`passo «${STEP_LABEL[u]}» alterado`);
  }
  if (!reasons.length) return stamp.warn ? { state: "concluído", reasons, reason: "", warn: true } : { state: "concluído", reasons, reason: "" };
  return { state: "desatualizado", reasons, reason: reasons.slice(0, 2).join("; ") + (reasons.length > 2 ? "…" : "") };
}

export function stepStates(s: FemStudy, geom: GeomSnapshot, assembly = false): StepInfo[] {
  return stepsFor(assembly).map((id) => ({ id, label: STEP_LABEL[id], section: STEP_SECTION[id], ...stepState(s, id, geom, assembly) }));
}

/** Primeiro passo por concluir (ou os resultados, se tudo estiver feito). */
export function firstOpenStep(s: FemStudy, geom: GeomSnapshot, assembly = false): StepId {
  return stepStates(s, geom, assembly).find((i) => i.state !== "concluído")?.id ?? "resultados";
}

/** Passo seguinte na ordem (o último fica onde está). */
export function nextStep(step: StepId, assembly = false): StepId {
  const order = stepsFor(assembly);
  const i = order.indexOf(step);
  return order[Math.min(i + 1, order.length - 1)] ?? step;
}

export function markDonePatch(s: FemStudy, step: StepId, geom: GeomSnapshot, assembly = false, warn = false): Pick<FemStudy, "workflow"> {
  const wf: StudyWorkflow = s.workflow ?? {};
  return { workflow: { ...wf, done: { ...wf.done, [step]: stampStep(s, step, geom, assembly, warn) } } };
}

/** Erros (bloqueiam a conclusão) e avisos (concluído com avisos) de um passo; «verificar» e «correr» veem o estudo todo. */
export function stepIssues(s: FemStudy, step: StepId, assembly = false): { errors: Issue[]; warnings: Issue[] } {
  const all = validate(s, step, assembly);
  return { errors: all.filter((i) => i.level === "erro"), warnings: all.filter((i) => i.level === "aviso") };
}

/** Regista os campos mudados à mão (a escolha do tipo de estudo deixa-os estar). */
export function touchUser(s: FemStudy, patch: Partial<FemStudy>): Pick<FemStudy, "workflow"> | undefined {
  const owned = new Set<string>(STEP_ORDER.flatMap((st) => STEP_FIELDS[st]));
  const fields = Object.keys(patch).filter((k) => owned.has(k));
  const user = s.workflow?.user ?? [];
  const add = fields.filter((f) => !user.includes(f));
  if (!add.length) return undefined;
  return { workflow: { ...s.workflow, user: [...user, ...add] } };
}

// ---------- validação ----------

export interface Issue { level: CheckLevel; text: string; step: StepId; section: SimSection }

const NO_SUPPORTS = "Sem apoios: o modelo pode mover-se como corpo rígido (a matriz de rigidez fica singular)";
const NO_LOADS = "Sem cargas: o resultado será nulo";

const nonZero = (v: unknown) => (typeof v === "number" ? v !== 0 : typeof v === "string" ? v.trim() !== "" && v.trim() !== "0" : false);

/**
 * Avisos e erros de um passo (o «Verificar» e o «Correr» recebem todos). Dois avisos da verificação
 * passam a bloquear: sem apoios numa estática ou encurvadura de uma peça, e sem cargas numa estática
 * ou dinâmica (salvo com velocidade inicial).
 */
export function validate(s: FemStudy, step: StepId | "todos", assembly = false): Issue[] {
  const all = step === "todos" || step === "verificar" || step === "correr";
  const out: Issue[] = [];
  for (const c of checkStudy(s, assembly)) {
    let level = c.level;
    if (c.text === NO_SUPPORTS && !assembly && (s.analysis === "static" || s.analysis === "buckling")) level = "erro";
    if (c.text === NO_LOADS && (s.analysis === "static" || (s.analysis === "dynamic" && !(s.dynamic?.v0 ?? []).some(nonZero)))) level = "erro";
    const st = WHERE_STEP[c.where];
    if (all || st === step) out.push({ level, text: c.text, step: st, section: STEP_SECTION[st] });
  }
  const rank: Record<CheckLevel, number> = { erro: 0, aviso: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Pode correr se a verificação completa não tiver erros (não exige os passos marcados). */
export function canRun(s: FemStudy, assembly = false): boolean {
  return !validate(s, "todos", assembly).some((i) => i.level === "erro");
}

export interface EnableCtx { busy?: boolean; study?: FemStudy; assembly?: boolean; running?: boolean; hasResult?: boolean }

/** O comando está disponível agora? Se não, porquê (para o tooltip do botão). */
export function isEnabled(cmd: string, ctx: EnableCtx): { ok: boolean; reason: string } {
  if (ctx.busy) return { ok: false, reason: "Termine a edição em curso" };
  if (!cmd.startsWith("sim.")) return { ok: true, reason: "" };
  if (cmd.startsWith("sim.new")) return { ok: true, reason: "" };
  if (!ctx.study) return { ok: false, reason: "Crie primeiro um estudo" };
  if (cmd === "sim.run" || cmd === "sim.mesh") {
    if (ctx.running) return { ok: false, reason: "O estudo já está a correr" };
    if (cmd === "sim.run") {
      const err = validate(ctx.study, "todos", ctx.assembly).find((i) => i.level === "erro");
      if (err) return { ok: false, reason: err.text };
    }
  }
  if (cmd === "sim.results" && !ctx.hasResult) return { ok: false, reason: "Corra o estudo para ver resultados" };
  return { ok: true, reason: "" };
}

// ---------- tipo de estudo ----------

export type StudyTypeId = "static" | "nonlinear" | "modal" | "buckling" | "thermal" | "dynamic" | "explicit" | "fatigue";

export interface StudyType { id: StudyTypeId; label: string; description: string; disabled?: string }

export const STUDY_TYPES: StudyType[] = [
  { id: "static", label: "Estático linear", description: "Tensões e deslocamentos sob cargas constantes; material elástico, pequenos deslocamentos." },
  { id: "nonlinear", label: "Estático não linear", description: "Grandes deslocamentos e/ou plasticidade, em incrementos de carga." },
  { id: "modal", label: "Modal", description: "Frequências próprias e modos de vibração." },
  { id: "buckling", label: "Encurvadura linear", description: "Carga crítica e modo de encurvadura." },
  { id: "thermal", label: "Térmico permanente", description: "Temperaturas em regime permanente (condução e convecção)." },
  { id: "dynamic", label: "Dinâmico implícito", description: "Resposta no tempo a cargas variáveis (Newmark/HHT)." },
  { id: "explicit", label: "Dinâmico explícito", description: "Impacto e eventos rápidos (OpenRadioss)." },
  { id: "fatigue", label: "Fadiga", description: "Vida à fadiga a partir de um estudo estático.", disabled: "Em preparação" },
];

export const studyTypeLabel = (id: StudyTypeId) => STUDY_TYPES.find((t) => t.id === id)?.label ?? id;

const SOLVER_LABEL: Record<FemStudy["solver"], string> = { calculix: "CalculiX", code_aster: "code_aster", openradioss: "OpenRadioss" };

/** Pré-definições de um tipo de estudo novo (cartões do tipo): solver, malha e duração. */
export function studyTypeDefaults(type: StudyTypeId): string {
  if (type === "fatigue") return "";
  const base = newFemStudy("tmp", 0);
  const s = { ...base, ...studyTypePatch(base, type) };
  const bits = [SOLVER_LABEL[s.solver], s.mesh.order === 1 ? "lineares" : "quadráticos"];
  if (s.dynamic && typeof s.dynamic.duration === "number") bits.push(`${+(s.dynamic.duration * 1000).toPrecision(3)} ms`);
  if (s.analysis === "modal") bits.push(`${s.modes} modos`);
  return bits.join(" · ");
}

export function typeOf(s: Pick<FemStudy, "analysis" | "dynamic" | "nonlinear">): StudyTypeId {
  if (s.analysis === "dynamic") return s.dynamic?.scheme === "explicit" ? "explicit" : "dynamic";
  if (s.analysis === "static" && (s.nonlinear?.geometry || s.nonlinear?.plasticity)) return "nonlinear";
  return s.analysis;
}

/**
 * O que muda no estudo ao escolher um tipo: análise, não linearidades, dinâmica, o solver quando
 * o atual não serve (OpenRadioss só faz explícito; code_aster não faz encurvadura nem térmica), a
 * malha do OpenRadioss (lineares hexa reduzidas) e as condições que deixam de servir. O que o
 * utilizador escolheu à mão (`workflow.user`) fica, salvo quando o solver o obriga.
 */
export function studyTypePatch(s: FemStudy, type: StudyTypeId): Partial<FemStudy> {
  const cur = typeOf(s);
  const p: Partial<FemStudy> = {};
  const user = new Set(s.workflow?.user ?? []);
  switch (type) {
    case "static": case "modal": case "buckling": case "thermal":
      p.analysis = type; p.nonlinear = undefined; p.dynamic = undefined; break;
    case "nonlinear":
      p.analysis = "static"; p.dynamic = undefined;
      p.nonlinear = cur === "nonlinear" ? s.nonlinear : { ...s.nonlinear, geometry: true };
      break;
    case "dynamic": case "explicit": {
      const scheme = type === "explicit" ? "explicit" : "implicit";
      p.analysis = "dynamic";
      p.dynamic = s.dynamic ? { ...s.dynamic, scheme } : { scheme, duration: type === "explicit" ? 0.001 : 0.01, load: "step" };
      p.nonlinear = s.nonlinear?.plasticity ? { plasticity: true } : undefined;
      break;
    }
    case "fatigue": return {};
  }
  let solver = s.solver;
  if (type === "explicit") solver = "openradioss";
  else if (solver === "openradioss") solver = "calculix";
  else if (solver === "code_aster" && (type === "buckling" || type === "thermal")) solver = "calculix";
  if (solver !== s.solver) p.solver = solver;
  if (solver === "openradioss") {
    const mesh = { ...s.mesh, order: 1 as const, element: s.mesh.element ?? "hex", integration: "reduced" as const };
    if (stableJson(mesh) !== stableJson(s.mesh)) p.mesh = mesh;
  } else if (s.solver === "openradioss" && !user.has("mesh")) {
    const { element: _e, integration: _i, ...rest } = s.mesh;
    p.mesh = { ...rest, order: 2 };
  }
  const thermal = type === "thermal";
  const keep = thermal ? THERMAL_LOADS : STRUCT_LOADS;
  if ((s.analysis === "thermal") !== thermal) p.loads = s.loads.filter((l) => keep.includes(l.kind));
  for (const k of Object.keys(p) as (keyof FemStudy)[]) if (stableJson(p[k]) === stableJson(s[k])) delete p[k];
  return p;
}

const ANALYSIS_WORD: Record<StudyTypeId, string> = {
  static: "estática linear", nonlinear: "estática não linear", modal: "modal", buckling: "encurvadura",
  thermal: "térmica", dynamic: "dinâmica implícita", explicit: "dinâmica explícita", fatigue: "fadiga",
};

/** O patch e as mudanças legíveis (para pedir confirmação quando há algo além do tipo). */
export function diffTypeChange(s: FemStudy, type: StudyTypeId): { patch: Partial<FemStudy>; changes: string[]; destructive: boolean } {
  const patch = studyTypePatch(s, type);
  const changes: string[] = [];
  const from = typeOf(s);
  if (from !== type) changes.push(`Análise: ${ANALYSIS_WORD[from]} → ${ANALYSIS_WORD[type]}`);
  if (patch.solver) changes.push(`Solver: ${SOLVER_LABEL[s.solver]} → ${SOLVER_LABEL[patch.solver]}`);
  if (patch.mesh && patch.mesh.order !== s.mesh.order) changes.push(`Malha: ordem ${s.mesh.order} → ${patch.mesh.order}`);
  const removed = patch.loads ? s.loads.length - patch.loads.length : 0;
  if (removed) changes.push(`${removed} ${removed === 1 ? "condição removida" : "condições removidas"} (não servem para este tipo)`);
  return { patch, changes, destructive: removed > 0 || !!patch.solver || (!!patch.mesh && patch.mesh.order !== s.mesh.order) };
}
