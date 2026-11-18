// Edição ao vivo das seeds da malha (como no Femap, mas sem diálogos): a seed em seleção no 3D muda com
// +/− ou Shift+roda (n.º de elementos ou tamanho) e B (distribuição); os nós de cada aresta são
// recalculados pelo meshPlan no worker, sem Gmsh, e desenhados no viewport.
import type { MeshSeed } from "../doc/study.ts";
import type { SeedPreview } from "../kernel/sim-fem.ts";
import { externalParts } from "./store-features.ts";
import { store } from "./store.ts";
import { activeStudy, cancelActiveStudy, currentGeom, patchMesh, runActiveStudy } from "./sim-actions.ts";
import { type LiveRun, keyDoc, liveMeshKey, liveMeshScheduler, lru, materialsRev } from "./live-mesh.ts";
import { geomRev } from "./workflow.ts";
import type { State } from "./store-state.ts";

/** Índice da seed cuja lista de arestas está em seleção no 3D (pickTarget `seed<i>`). */
export function activeSeedIndex(): number | null {
  const m = /^seed(\d+)$/.exec(store.state.pickTarget?.field ?? "");
  return m ? Number(m[1]) : null;
}

/** Seed ativa do estudo FEM em edição. */
export function activeSeed(): MeshSeed | null {
  const i = activeSeedIndex(), s = activeStudy("fem");
  return i != null && s?.physics === "fem" ? s.mesh.seeds?.[i] ?? null : null;
}

function patchSeed(f: (sd: MeshSeed) => Partial<MeshSeed>) {
  const i = activeSeedIndex();
  if (i == null) return;
  patchMesh((m) => ({ seeds: (m.seeds ?? []).map((x, k) => (k === i ? { ...x, ...f(x) } : x)) }));
}

/** +1/−1 elemento (modo n.º) ou tamanho ÷/× 1,25 (modo tamanho). */
export function stepSeed(step: 1 | -1) {
  const sd = activeSeed();
  if (!sd) return;
  if (typeof sd.value !== "number") { store.set({ message: "A seed usa uma expressão: altere o valor no painel." }); return; }
  const value = sd.mode === "count" ? Math.max(1, Math.round(sd.value) + step) : Math.max(1e-3, +(sd.value / 1.25 ** step).toPrecision(3));
  patchSeed(() => ({ value }));
}

const BIAS_CYCLE: (MeshSeed["biasAt"] | null)[] = [null, "start", "end", "ends", "center"];
const BIAS_NAME: Record<NonNullable<MeshSeed["biasAt"]>, string> = { start: "pequenos no início", end: "pequenos no fim", ends: "pequenos nas pontas", center: "pequenos no meio", vertex: "pequenos junto ao vértice" };

/** Distribuição da seed ativa (sem razão definida = uniforme). */
export function seedBiasName(sd: MeshSeed): string {
  return sd.bias == null || sd.bias === "" || sd.bias === 1 ? "uniforme" : BIAS_NAME[sd.biasAt ?? "start"];
}

/** B: uniforme → início → fim → pontas → meio (→ vértice, se já escolhido) → uniforme (razão 3 quando não havia). */
export function cycleSeedBias() {
  const sd = activeSeed();
  if (!sd) return;
  const uniform = seedBiasName(sd) === "uniforme";
  const cycle = sd.biasPoint ? [...BIAS_CYCLE, "vertex" as const] : BIAS_CYCLE;
  const next = cycle[(cycle.indexOf(uniform ? null : sd.biasAt ?? "start") + 1) % cycle.length];
  patchSeed(() => (next ? { biasAt: next, bias: uniform ? 3 : sd.bias } : { bias: undefined, biasAt: undefined }));
}

/** Nova seed (10 elementos) com a seleção de arestas já ligada no 3D. */
export function addSeed() {
  const s = activeStudy("fem");
  const n = (s?.physics === "fem" ? s.mesh.seeds?.length : 0) ?? 0;
  patchMesh((m) => ({ seeds: [...(m.seeds ?? []), { edges: [], mode: "count", value: 10 }] }));
  store.set({ pickTarget: { field: `seed${n}`, accept: ["edge", "face"] } });
}

/** Teclas da seed ativa (+/=, −, B); devolve true quando a tecla foi tratada. */
export function handleSeedKey(e: KeyboardEvent): boolean {
  if (activeSeedIndex() == null || e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=") stepSeed(1);
  else if (k === "-" || k === "_") stepSeed(-1);
  else if (k === "b") cycleSeedBias();
  else return false;
  e.preventDefault();
  return true;
}

let seq = 0, timer: ReturnType<typeof setTimeout> | undefined;

/** Pede ao worker os nós das seeds do estudo FEM ativo (peças), com debounce; null fora do espaço FEM. */
export function scheduleSeedPreview(show: (p: SeedPreview | null) => void, delay = 150) {
  clearTimeout(timer);
  const id = ++seq, st = store.state, study = activeStudy("fem");
  if (st.workspace !== "fem" || st.active.kind !== "part" || study?.physics !== "fem" || !st.result?.mesh) { show(null); return; }
  timer = setTimeout(() => {
    store.kernel.meshSeeds(st.doc, externalParts(st.project, st.doc), study.id)
      .then((p) => { if (id === seq) show(p); })
      .catch(() => { if (id === seq) show(null); });
  }, delay);
}

// últimas malhas ao vivo por chave: desfazer uma edição volta à malha anterior sem a refazer
const meshCache = lru<NonNullable<State["simResult"]>>(5);

/** Uma malha ao vivo: da cache se a chave já foi gerada, senão no agente (sem tocar no erro global). */
async function liveMeshRun(key: string): Promise<LiveRun> {
  const hit = meshCache.get(key);
  if (hit && hit.doc === keyDoc(key)) { store.set({ simResult: hit, simHidden: false, liveMeshError: null }); return "ok"; }
  const r = await runActiveStudy(true, { live: true });
  if (r.ok) {
    const res = store.state.simResult;
    if (res) meshCache.set(key, res);
    return "ok";
  }
  if (r.error) { store.set({ liveMeshError: r.error }); return "error"; }
  return "cancelled";
}
const liveMesh = liveMeshScheduler(liveMeshRun, {
  blocked: () => !!store.state.simBusy,
  cancel: () => void cancelActiveStudy(),
});

/**
 * Chamado a cada alteração do estado: agenda a malha ao vivo quando muda algo de que ela depende
 * (geometria, materiais, definições da malha, estudo ou documento) — ou retoma depois de um cálculo.
 */
export function scheduleLiveMesh() {
  const st = store.state, study = activeStudy("fem");
  const fem = st.workspace === "fem" && study?.physics === "fem" ? study : undefined;
  const on = st.liveMesh && !!st.agent.token && !!fem;
  const key = on && fem ? liveMeshKey({
    on, token: st.agent.token, doc: store.activeAssembly()?.id ?? st.doc.id, studyId: fem.id,
    geom: geomRev(currentGeom()), materials: materialsRev(fem), mesh: fem.mesh,
  }) : null;
  if (key === null && st.liveMeshError) store.set({ liveMeshError: null });
  liveMesh(key);
}
