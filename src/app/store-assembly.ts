// Montagens: componentes, mates (com pré-visualização) e interferências. Funções que recebem o Store.
import { type AssemblyDoc, type CadProject, type Component, type Mate, type MateKind, type MateRef, containsAssembly } from "../doc/project.ts";
import { KernelRestartError } from "./kernel-client.ts";
import type { Pick } from "./store-state.ts";
import type { Store } from "./store.ts";

/** Projeto com o mate em edição aplicado (pré-visualização na montagem). */
export function displayProject(s: Store): CadProject {
  const { project, mateEdit, active } = s.state;
  if (!mateEdit || active.kind !== "assembly") return project;
  return {
    ...project,
    assemblies: project.assemblies.map((a) => a.id !== active.id ? a : {
      ...a, mates: mateEdit.isNew ? [...a.mates, mateEdit.draft] : a.mates.map((m) => (m.id === mateEdit.draft.id ? mateEdit.draft : m)),
    }),
  };
}

// --- montagens -----------------------------------------------------------------

function asm(s: Store): AssemblyDoc { const a = s.activeAssembly(); if (!a) throw new Error("Nenhuma montagem ativa"); return a; }

export function insertComponent(s: Store, ref: { kind: "part" | "assembly"; id: string }) {
  const a = asm(s);
  if (ref.kind === "assembly" && containsAssembly(s.state.project, ref.id, a.id)) { s.set({ error: "Uma montagem não pode conter-se a si própria" }); return; }
  const src = ref.kind === "part" ? s.state.project.parts.find((p) => p.id === ref.id) : s.state.project.assemblies.find((x) => x.id === ref.id);
  if (!src) return;
  const n = a.components.filter((c) => c.ref.id === ref.id).length + 1;
  const ids = a.components.map((c) => Number(c.id.slice(1)) || 0);
  const id = `c${Math.max(0, ...ids) + 1}`;
  // ao lado do que já existe, para não sobrepor
  const box = s.state.asmResult?.mass?.bbox;
  const x = box && a.components.length ? box.max[0] + 20 : 0;
  const c: Component = { id, name: `${src.name}<${n}>`, ref, placement: { t: [x, 0, 0], r: [0, 0, 0] }, fixed: a.components.length === 0 ? true : undefined };
  s.commitAssembly({ ...a, components: [...a.components, c] }, `Inserir ${c.name}`);
}

export function updateComponent(s: Store, id: string, patch: Partial<Component>) {
  const a = asm(s);
  s.commitAssembly({ ...a, components: a.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, "Componente");
}

export function deleteComponent(s: Store, id: string) {
  const a = asm(s);
  const c = a.components.find((x) => x.id === id);
  const mates = a.mates.filter((m) => m.a.component !== id && m.b.component !== id);
  s.commitAssembly({ ...a, components: a.components.filter((x) => x.id !== id), mates }, `Apagar ${c?.name}${mates.length < a.mates.length ? ` e ${a.mates.length - mates.length} mate(s)` : ""}`);
}

/** Começa um mate novo; usa as duas primeiras seleções de componentes, se houver. */
export function startMate(s: Store, kind: MateKind = "coincident") {
  const a = asm(s);
  const ids = a.mates.map((m) => Number(m.id.slice(1)) || 0);
  const refs = s.state.selection.flatMap((p) => mateRefOf(p) ?? []);
  const labels: Record<MateKind, string> = { coincident: "Coincidente", concentric: "Concêntrico", parallel: "Paralelo", perpendicular: "Perpendicular", distance: "Distância", angle: "Ângulo", tangent: "Tangente", lock: "Fixar" };
  const n = a.mates.filter((m) => m.kind === kind).length + 1;
  const draft: Mate = { id: `m${Math.max(0, ...ids) + 1}`, name: `${labels[kind]}${n}`, kind, a: refs[0] ?? { component: "", std: "XY" }, b: refs[1] ?? { component: "", std: "XY" } };
  s.set({ mateEdit: { draft, isNew: true }, selection: [], pickTarget: refs.length < 2 ? { field: refs.length ? "mateB" : "mateA", accept: ["face", "edge"] } : null });
  s.rebuild();
}

/** Referência de mate a partir de uma seleção no 3D da montagem. */
export function mateRefOf(p: Pick): MateRef | null {
  if ((p.kind !== "face" && p.kind !== "edge") || !p.component) return null;
  return { component: p.component, ref: { kind: p.kind, name: p.name, hint: p.hint } };
}

export function editMate(s: Store, id: string) {
  const m = asm(s).mates.find((x) => x.id === id);
  if (m) { s.set({ mateEdit: { draft: structuredClone(m), isNew: false }, pickTarget: null }); s.rebuild(); }
}

export function updateMateDraft(s: Store, patch: Partial<Mate>) {
  const e = s.state.mateEdit;
  if (!e) return;
  s.set({ mateEdit: { ...e, draft: { ...e.draft, ...patch } } });
  s.rebuild();
}

export function confirmMate(s: Store) {
  const e = s.state.mateEdit;
  if (!e) return;
  const a = asm(s);
  s.set({ mateEdit: null, pickTarget: null });
  s.commitAssembly({ ...a, mates: e.isNew ? [...a.mates, e.draft] : a.mates.map((m) => (m.id === e.draft.id ? e.draft : m)) }, `${e.isNew ? "Criar" : "Editar"} ${e.draft.name}`);
}

export function cancelMate(s: Store) { s.set({ mateEdit: null, pickTarget: null }); s.rebuild(0); }

export function deleteMate(s: Store, id: string) {
  const a = asm(s);
  s.commitAssembly({ ...a, mates: a.mates.filter((m) => m.id !== id) }, "Apagar mate");
}

export function toggleMate(s: Store, id: string) {
  const a = asm(s);
  s.commitAssembly({ ...a, mates: a.mates.map((m) => (m.id === id ? { ...m, suppressed: !m.suppressed } : m)) }, "Suprimir mate");
}

/** Aplica a posição resolvida pelos mates às posições iniciais (o solver parte daí da próxima vez). */
export async function checkInterference(s: Store) {
  try {
    await s.ensureBuilt();
    s.set({ busy: true });
    const r = await s.kernel.interference();
    s.set({ interference: r, busy: false, message: r.pairs.length ? `${r.pairs.length} interferência(s)` : "Sem interferências" });
  } catch (e) {
    // um reinício do núcleo já foi anunciado em onRestart
    s.set(e instanceof KernelRestartError ? { busy: false } : { busy: false, error: (e as Error).message });
  }
}
