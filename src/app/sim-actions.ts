// Ações dos estudos de simulação partilhadas pela barra do espaço de trabalho, pela árvore do modelo e
// pelo painel: estudos da peça ou da montagem ativa, criar, gravar, calcular e pré-visualizar a malha.
import { type FemLoad, type FemStudy, type SimMesh, type Study, SIM_MATERIALS, newCfdStudy, newFemStudy } from "../doc/study.ts";
import { store } from "./store.ts";
import { previewStudyMesh, runStudy } from "./sim-client.ts";

/** Estudos do documento ativo (peça ou montagem), opcionalmente só de uma física. */
export function activeStudies(physics?: "fem" | "cfd"): Study[] {
  const asm = store.activeAssembly();
  const all: Study[] = asm ? asm.studies ?? [] : store.state.doc.studies ?? [];
  return physics ? all.filter((x) => x.physics === physics) : all;
}

/** Estudo em edição: o escolhido na árvore ou o primeiro da física do espaço de trabalho. */
export function activeStudy(physics?: "fem" | "cfd"): Study | undefined {
  const list = activeStudies(physics);
  return list.find((x) => x.id === store.state.simStudy) ?? list[0];
}

export function saveStudies(next: Study[], label = "Estudos") {
  const asm = store.activeAssembly();
  if (asm) store.commitAssembly({ ...asm, studies: next as FemStudy[] }, label, true);
  else store.commitDoc("part", { ...store.state.doc, studies: next }, label, true);
}

export function updateStudy(id: string, patch: Partial<Study>) {
  saveStudies(activeStudies().map((x) => (x.id === id ? ({ ...x, ...patch } as Study) : x)));
}

/** Novo estudo FEM (com o tipo de análise) ou CFD (interno/externo); fica escolhido na árvore. */
export function addStudy(kind: "fem" | "cfd", patch: Partial<Study> = {}): string {
  const st = store.state;
  const asm = store.activeAssembly();
  if (kind === "cfd" && asm) { store.set({ error: "A CFD é por peça (abra a peça)" }); return ""; }
  const studies = activeStudies();
  const n = studies.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1;
  const ns = { ...(kind === "fem" ? newFemStudy(`s${n}`, n) : newCfdStudy(`s${n}`, n)), ...patch } as Study;
  if (ns.physics === "fem") {
    if (st.doc.properties?.material && !asm) {
      const m = SIM_MATERIALS.find((x) => x.name === st.doc.properties!.material);
      if (m) ns.material = { ...m };
    }
    if (asm) ns.contact = { mode: "bonded" };
    const names = { static: "Estático", modal: "Modal", buckling: "Encurvadura", dynamic: "Dinâmico", thermal: "Térmico" } as const;
    if (!("name" in patch)) ns.name = `${names[ns.analysis]} ${n}`;
  }
  saveStudies([...studies, ns], "Novo estudo");
  store.set({ simStudy: ns.id, simSection: "study", simResult: null });
  return ns.id;
}

export function deleteStudy(id: string) {
  saveStudies(activeStudies().filter((x) => x.id !== id), "Apagar estudo");
  store.set({ simStudy: null, simResult: null });
}

/** Calcula o estudo ativo no agente (ou só a malha), com as opções de convergência da barra/painel. */
export async function runActiveStudy(meshOnly = false) {
  const st = store.state;
  const s = activeStudy(st.workspace === "cfd" ? "cfd" : st.workspace === "fem" ? "fem" : undefined);
  if (!s) { store.set({ error: "Crie primeiro um estudo" }); return; }
  if (st.simBusy) return;
  if (meshOnly && s.physics !== "fem") { store.set({ error: "A pré-visualização da malha é para estudos FEM" }); return; }
  const doc = store.activeAssembly()?.id ?? st.doc.id;
  const o = st.simRun;
  const conv = !meshOnly && o.conv ? { ratio: o.ratio, ...(o.mode === "auto" ? { target: o.target / 100, maxLevels: o.levels, metric: o.metric || undefined } : o.mode === "sweep" ? { sweep: 3, metric: o.metric || undefined } : {}) } : undefined;
  store.set({ simBusy: meshOnly ? "mesh" : "run", error: null });
  try {
    const { result } = meshOnly ? await previewStudyMesh(s.id, st.agent.url, st.agent.token) : await runStudy(s.id, st.agent.url, st.agent.token, conv);
    store.set({ simResult: { doc, studyId: s.id, result }, simView: { field: 0, disp: 0, scale: 0, hidden: [] }, simHidden: false, message: `${meshOnly ? "Malha gerada" : "Calculado"} em ${result.seconds.toFixed(1)} s`, ...(st.workspace === "fem" || st.workspace === "cfd" ? { simSection: meshOnly ? "mesh" : "results" } : {}) });
  } catch (e) {
    store.set({ error: (e as Error).message });
  } finally {
    store.set({ simBusy: null });
  }
}

export const STRUCT_LOADS: FemLoad["kind"][] = ["fixed", "displacement", "force", "pressure", "gravity"];
export const THERMAL_LOADS: FemLoad["kind"][] = ["temperature", "convection", "heatFlux"];

export function newLoad(kind: FemLoad["kind"]): FemLoad {
  switch (kind) {
    case "fixed": return { kind, faces: [] };
    case "displacement": return { kind, faces: [], ux: 0 };
    case "force": return { kind, faces: [], f: [0, 0, -100] };
    case "pressure": return { kind, faces: [], p: 1 };
    case "gravity": return { kind, g: [0, 0, -9810] };
    case "temperature": return { kind, faces: [], t: 100 };
    case "convection": return { kind, faces: [], h: 10, tInf: 20 };
    case "heatFlux": return { kind, faces: [], q: 1000 };
  }
}

/** Estudo FEM em edição (cria um estático se não houver). */
function femStudy(): FemStudy | undefined {
  const s = activeStudy("fem");
  if (s?.physics === "fem") return s;
  const id = addStudy("fem");
  const n = activeStudies("fem").find((x) => x.id === id);
  return n?.physics === "fem" ? n : undefined;
}

/**
 * Acrescenta uma condição a partir da barra (como os ícones de cargas e apoios do SolidWorks
 * Simulation): abre a secção e deixa a seleção de faces ativa no 3D.
 */
export function addCondition(kind: FemLoad["kind"]) {
  const s = femStudy();
  if (!s) return;
  const thermal = s.analysis === "thermal";
  if (thermal !== THERMAL_LOADS.includes(kind)) { store.set({ error: thermal ? "Num estudo térmico use temperatura, convecção ou fluxo de calor" : "Temperatura, convecção e fluxo de calor são para estudos térmicos" }); return; }
  const i = s.loads.length;
  updateStudy(s.id, { loads: [...s.loads, newLoad(kind)] });
  store.set({ simStudy: s.id, simSection: "conditions", pickTarget: kind === "gravity" ? null : { field: `load${i}`, accept: ["face"] } });
}

/** Sonda nova (média em faces), com a seleção ativa. */
export function addProbe() {
  const s = femStudy();
  if (!s) return;
  const probes = s.probes ?? [];
  updateStudy(s.id, { probes: [...probes, { name: `Sonda ${probes.length + 1}`, quantity: s.analysis === "thermal" ? "T" : "u", at: { kind: "faces", faces: [] } }] });
  store.set({ simStudy: s.id, simSection: "probes", pickTarget: { field: `probe${probes.length}`, accept: ["face"] } });
}

/** Material de referência no estudo FEM ativo. */
export function setStudyMaterial(name: string) {
  const s = femStudy();
  const m = SIM_MATERIALS.find((x) => x.name === name);
  if (!s || !m) return;
  updateStudy(s.id, { material: { ...m } });
  store.set({ simStudy: s.id, simSection: "material", message: `Material: ${m.name}` });
}

/** Altera a malha do estudo FEM ativo (tipo, ordem, tamanho) e abre a secção. */
export function patchMesh(f: (m: SimMesh) => Partial<SimMesh>) {
  const s = femStudy();
  if (!s) return;
  updateStudy(s.id, { mesh: { ...s.mesh, ...f(s.mesh) } });
  store.set({ simStudy: s.id, simSection: "mesh" });
}

/** Cores das condições no 3D (apoios em azul, cargas em âmbar/vermelho, térmicas em laranja/ciano; CFD: entrada verde, saída vermelha). */
export const CONDITION_COLORS: Record<FemLoad["kind"] | "inlet" | "outlet", number> = {
  fixed: 0x2563eb, displacement: 0x0891b2, force: 0xf59e0b, pressure: 0xdc2626, gravity: 0xf59e0b,
  temperature: 0xef4444, convection: 0x06b6d4, heatFlux: 0xf97316, inlet: 0x16a34a, outlet: 0xdc2626,
};

/** Faces (nome no 3D) → cor da condição, para o estudo ativo do espaço FEM/CFD. */
export function conditionFaceColors(): Map<string, number> | null {
  const st = store.state;
  if (st.workspace !== "fem" && st.workspace !== "cfd") return null;
  const s = activeStudy(st.workspace);
  if (!s) return null;
  const asm = !!store.activeAssembly();
  // nas montagens a referência é "caminho/face" e a face no 3D "caminho|face"
  const key = (n: string) => (asm ? n.replace(/\/(?=[^/]*$)/, "|") : n);
  const out = new Map<string, number>();
  if (s.physics === "fem") {
    for (const l of s.loads) if ("faces" in l) for (const f of l.faces) out.set(key(f.name), CONDITION_COLORS[l.kind]);
  } else {
    for (const f of s.inlet?.faces ?? []) out.set(key(f.name), CONDITION_COLORS.inlet);
    for (const f of s.outlet?.faces ?? []) out.set(key(f.name), CONDITION_COLORS.outlet);
  }
  return out;
}
