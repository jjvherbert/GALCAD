// Projeto e documentos: gravar/ativar/criar/apagar documentos, análises, desfazer e ficheiros. Funções que recebem o Store.
import type { CadDocument } from "../doc/types.ts";
import {
  type AssemblyDoc, type CadProject, type DocKind, type DocRef, type DrawingDoc, type PartDoc, type PartProperties,
  newAssembly, newDrawing, newPart, newProject, parseProject, serializeProject, usages,
} from "../doc/project.ts";
import { autoLayout } from "../drawing/auto-layout.ts";
import { KernelRestartError } from "./kernel-client.ts";
import type { Analysis } from "./store-state.ts";
import type { Store } from "./store.ts";

export const AUTOSAVE = "cad-prototipo:autosave";

/** Partes de um desenho que o núcleo usa (as vistas sem posição; as fontes das tabelas de BOM). */
function drawingKernelKey(d: DrawingDoc): string {
  return JSON.stringify([d.views.map(({ at: _a, name: _n, ...v }) => v), d.sheet, d.annotations.filter((a) => a.kind === "bom").map((a) => (a.kind === "bom" ? a.source : ""))]);
}

/** Grava um documento no projeto (com desfazer). */
export function commitDoc(s: Store, kind: DocKind, doc: PartDoc | AssemblyDoc | DrawingDoc, label: string, merge = false) {
  const p = s.state.project;
  const project: CadProject = kind === "part" ? { ...p, parts: p.parts.map((x) => (x.id === doc.id ? (doc as PartDoc) : x)) }
    : kind === "assembly" ? { ...p, assemblies: p.assemblies.map((x) => (x.id === doc.id ? (doc as AssemblyDoc) : x)) }
    : { ...p, drawings: p.drawings.map((x) => (x.id === doc.id ? (doc as DrawingDoc) : x)) };
  if (s.state.active.id === doc.id) s.history.push(doc, label, merge);
  const before = kind === "drawing" ? p.drawings.find((x) => x.id === doc.id) : undefined;
  s.set({ project, dirty: true, ...(kind === "part" && s.state.doc.id === doc.id ? { doc: doc as PartDoc } : {}) });
  autosave(s);
  // num desenho, mover vistas ou editar anotações não muda as projeções: não é preciso o núcleo
  if (kind === "drawing" && before && drawingKernelKey(before) === drawingKernelKey(doc as DrawingDoc) && s.state.drawingResult) return;
  s.rebuild();
}

export function setActive(s: Store, ref: DocRef) {
  if (s.state.edit || s.state.sketch) { s.set({ message: "Termine primeiro a edição em curso" }); return; }
  const doc = ref.kind === "part" ? s.state.project.parts.find((p) => p.id === ref.id) : undefined;
  s.set({
    active: ref, ...(doc ? { doc, result: null } : {}), selection: [], selectedFeature: null, pickTarget: null, analysis: null,
    // o espaço de trabalho segue o documento: desenhos no Desenho; peças e montagens fora dele (CFD só em peças)
    workspace: ref.kind === "drawing" ? "drawing" : s.state.workspace === "drawing" || (ref.kind === "assembly" && s.state.workspace === "cfd") ? "design" : s.state.workspace,
    asmResult: ref.kind === "assembly" ? s.state.asmResult : null, contextToolbar: null,
    mateEdit: null, componentEdit: null, interference: null, drawingTool: null, drawingSel: null,
    // os resultados do documento novo voltam (A3); o rebuild a seguir atualiza o desenho se o modelo mudou
    simResult: s.simResults.get(ref.id) ?? null,
    drawingResult: ref.kind === "drawing" ? s.drawingResults.get(ref.id) ?? null : null,
  });
  if (ref.kind !== "drawing") s.lastModelDoc = ref;
  s.rebuild(0);
}

export function addDocument(s: Store, kind: DocKind) {
  const p = s.state.project;
  let project: CadProject, id: string;
  if (kind === "part") { const d = newPart(p); project = { ...p, parts: [...p.parts, d] }; id = d.id; }
  else if (kind === "assembly") { const d = newAssembly(p); project = { ...p, assemblies: [...p.assemblies, d] }; id = d.id; }
  else { const d = newDrawing(p); project = { ...p, drawings: [...p.drawings, d] }; id = d.id; }
  s.set({ project, dirty: true });
  autosave(s);
  setActive(s, { kind, id });
}

/**
 * «Criar desenho 2D»: desenho novo da peça/montagem ativa (ou da última aberta) com frente, planta, lateral e
 * isométrica, escala normalizada e a menor folha onde cabem. Precisa da caixa da última reconstrução.
 */
export function createDrawing2D(s: Store) {
  const active = s.state.active;
  const ref = active.kind !== "drawing" ? active : s.lastModelDoc;
  const box = ref && s.modelBoxes.get(ref.id);
  if (!ref || ref.kind === "drawing" || !box) { s.set({ message: "Abra e reconstrua uma peça ou montagem antes de criar o desenho 2D." }); return; }
  const p = s.state.project;
  const model = (ref.kind === "part" ? p.parts : p.assemblies).find((d) => d.id === ref.id);
  if (!model) return;
  const d = autoLayout(newDrawing(p, `Desenho de ${model.name}`), { kind: ref.kind, id: ref.id }, box, { fitSheet: true });
  s.set({ project: { ...p, drawings: [...p.drawings, d] }, dirty: true });
  autosave(s);
  setActive(s, { kind: "drawing", id: d.id });
}

export function deleteDocument(s: Store, ref: DocRef) {
  const p = s.state.project;
  const used = usages(p, ref.id);
  if (used.length) { s.set({ error: `Não é possível apagar: usado em ${used.join(", ")}` }); return; }
  if (ref.kind === "part" && p.parts.length === 1) { s.set({ error: "O projeto tem de ter pelo menos uma peça" }); return; }
  const project: CadProject = {
    ...p,
    parts: p.parts.filter((x) => x.id !== ref.id),
    assemblies: p.assemblies.filter((x) => x.id !== ref.id),
    drawings: p.drawings.filter((x) => x.id !== ref.id),
  };
  s.histories.delete(ref.id);
  s.simResults.delete(ref.id);
  s.drawingResults.delete(ref.id);
  s.modelBoxes.delete(ref.id);
  if (s.lastModelDoc?.id === ref.id) s.lastModelDoc = null;
  s.set({ project, dirty: true });
  autosave(s);
  if (s.state.active.id === ref.id) setActive(s, { kind: "part", id: project.parts[0].id });
}

export function renameDocument(s: Store, ref: DocRef, name: string) {
  if (!name.trim()) return;
  const p = s.state.project;
  const list = ref.kind === "part" ? p.parts : ref.kind === "assembly" ? p.assemblies : p.drawings;
  const d = list.find((x) => x.id === ref.id);
  if (d) commitDoc(s, ref.kind, { ...d, name: name.trim() } as never, "Renomear");
}

export function setPartProperties(s: Store, props: PartProperties) {
  commitDoc(s, "part", { ...s.state.doc, properties: props }, "Propriedades");
}

/** Liga/desliga uma análise; a curvatura é calculada no núcleo (exata, por vértice). */
export async function setAnalysis(s: Store, a: Analysis | null) {
  s.set({ analysis: a });
  await refreshAnalysis(s);
}

export async function refreshAnalysis(s: Store) {
  const a = s.state.analysis;
  if (a?.kind === "highlight" && s.state.result?.mesh && (!a.normals || s.normalsFor !== s.state.result)) {
    try {
      await s.ensureBuilt();
      const res = s.state.result;
      const { normals } = await s.kernel.normals();
      s.normalsFor = res;
      if (s.state.analysis === a) s.set({ analysis: { ...a, normals } });
    } catch (e) { if (!(e instanceof KernelRestartError)) s.set({ error: (e as Error).message }); }
    return;
  }
  if ((a?.kind !== "curvature" && a?.kind !== "deviation" && a?.kind !== "continuity" && a?.kind !== "combs") || !s.state.result?.mesh) return;
  try {
    await s.ensureBuilt();
    const data = a.kind === "curvature" ? await s.kernel.curvature(a.mode)
      : a.kind === "continuity" ? await s.kernel.continuity()
      : a.kind === "combs" ? await s.kernel.combs(a.edges)
      : await s.kernel.deviation();
    if (s.state.analysis === a) s.set({ analysis: { ...a, data } as Analysis });
  } catch (e) {
    if (!(e instanceof KernelRestartError)) s.set({ error: (e as Error).message });
  }
}

export function autosave(s: Store) {
  try { localStorage.setItem(AUTOSAVE, serializeProject(s.state.project)); } catch { /* quota/privado: ignorar */ }
}

/** Grava a peça ativa. */
export function commit(s: Store, doc: CadDocument, label: string, merge = false) {
  commitDoc(s, "part", { ...doc, id: s.state.doc.id, properties: s.state.doc.properties } as PartDoc, label, merge);
}

function restore(s: Store, d: unknown, message: string) {
  const kind = s.state.active.kind;
  const p = s.state.project;
  const doc = d as PartDoc & AssemblyDoc & DrawingDoc;
  const project: CadProject = kind === "part" ? { ...p, parts: p.parts.map((x) => (x.id === doc.id ? doc : x)) }
    : kind === "assembly" ? { ...p, assemblies: p.assemblies.map((x) => (x.id === doc.id ? doc : x)) }
    : { ...p, drawings: p.drawings.map((x) => (x.id === doc.id ? doc : x)) };
  s.set({ project, message, ...(kind === "part" ? { doc } : {}) });
  autosave(s);
  s.rebuild(0);
}

export function undo(s: Store) {
  if (s.state.edit || s.state.sketch) return;
  const d = s.history.undo();
  if (d) restore(s, d, "Desfeito");
}
export function redo(s: Store) {
  if (s.state.edit || s.state.sketch) return;
  const d = s.history.redo();
  if (d) restore(s, d, "Refeito");
}

// --- ficheiros -------------------------------------------------------------

export function newDoc(s: Store) {
  const project = newProject();
  s.histories.clear();
  s.simResults.clear();
  s.drawingResults.clear();
  s.modelBoxes.clear();
  s.lastModelDoc = null;
  s.set({ project, active: { kind: "part", id: project.parts[0].id }, doc: project.parts[0], result: null, asmResult: null, drawingResult: null, simResult: null, edit: null, sketch: null, selection: [], selectedFeature: null, fileName: project.name, dirty: false, pickTarget: null });
  autosave(s);
  s.rebuild(0);
}

export function open(s: Store, text: string, fileName: string) {
  const project = parseProject(text);
  if (!project.parts.length) project.parts.push(newPart(project));
  s.histories.clear();
  s.simResults.clear();
  s.drawingResults.clear();
  s.modelBoxes.clear();
  s.lastModelDoc = null;
  const name = fileName.replace(/\.cadp\.json$|\.json$/i, "");
  s.set({ project: { ...project, name: project.name || name }, active: { kind: "part", id: project.parts[0].id }, doc: project.parts[0], result: null, asmResult: null, drawingResult: null, simResult: null, edit: null, sketch: null, selection: [], selectedFeature: null, fileName: name, dirty: false });
  autosave(s);
  s.rebuild(0);
}
