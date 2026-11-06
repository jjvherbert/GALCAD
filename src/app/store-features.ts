// Features: criar/editar/confirmar, templates (knowledgeware), publicações e referências externas. Funções que recebem o Store.
import type { CadDocument, Feature, FeatureData, FeatureType, Publication, Vec3 } from "../doc/types.ts";
import { addFeature, defaultFeatureName, nextFeatureId, updateFeature } from "../doc/io.ts";
import type { CadProject, FeatureTemplate, PartDoc } from "../doc/project.ts";
import { instantiateTemplate as instantiateKnowledge, makeTemplate } from "../doc/knowledge.ts";
import { defaultFeature } from "./defaults.ts";
import { PLUGINS } from "../plugins/meta.ts";
import type { Pick } from "./store-state.ts";
import type { Store } from "./store.ts";

/** Peças de que um documento depende por referências externas (transitivamente). */
export function externalParts(project: CadProject, doc: CadDocument): PartDoc[] {
  const out = new Map<string, PartDoc>();
  const visit = (d: CadDocument) => {
    for (const f of d.features) {
      if (f.type !== "external" || out.has(f.part)) continue;
      const p = project.parts.find((x) => x.id === f.part);
      if (p) { out.set(p.id, p); visit(p); }
    }
  };
  visit(doc);
  return [...out.values()];
}

/** inv(B) · A para matrizes rígidas 4×4 em coluna maior. */
function relativeMatrix(B: ArrayLike<number>, A: ArrayLike<number>): number[] {
  // inv(B): rotação transposta e translação −Rᵀt
  const R = [B[0], B[1], B[2], B[4], B[5], B[6], B[8], B[9], B[10]]; // colunas
  const t = [B[12], B[13], B[14]];
  const inv = new Array(16).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) inv[j * 4 + i] = R[i * 3 + j];
  for (let i = 0; i < 3; i++) inv[12 + i] = -(R[i * 3] * t[0] + R[i * 3 + 1] * t[1] + R[i * 3 + 2] * t[2]);
  inv[15] = 1;
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += inv[k * 4 + r] * A[c * 4 + k]; out[c * 4 + r] = s; }
  return out;
}

export function startFeature(s: Store, type: FeatureType, opts: Parameters<typeof defaultFeature>[2] = {}) {
  if (s.state.sketch) return;
  if (type === "sketch") { s.startSketch(opts.plane); return; }
  const doc = s.state.doc;
  const data = prefill(s, defaultFeature(doc, type, opts));
  let name = defaultFeatureName(doc, type);
  if (data.type === "plugin") {
    const label = PLUGINS.find((p) => p.id === data.plugin)?.kinds[data.kind]?.label.split(" ")[0] ?? "Plugin";
    const names = new Set(doc.features.map((f) => f.name));
    for (let i = 1; ; i++) if (!names.has(`${label}${i}`)) { name = `${label}${i}`; break; }
  }
  const draft = { ...data, id: nextFeatureId(doc), name } as Feature;
  s.set({ edit: { id: draft.id, isNew: true, draft, index: s.insertIndex() }, choosingPlane: false, pickTarget: null });
  s.rebuild();
}

/** Usa a seleção atual no 3D para pré-preencher a feature (ex.: arestas para um filete). */
function prefill(s: Store, f: FeatureData): FeatureData {
  const sel = s.state.selection;
  const refs = sel.filter((p): p is Extract<Pick, { kind: "face" | "edge" }> => p.kind === "face" || p.kind === "edge").map((p) => ({ kind: p.kind, name: p.name, hint: p.hint }));
  const faces = refs.filter((r) => r.kind === "face");
  if ((f.type === "fillet" || f.type === "chamfer") && refs.length) return { ...f, refs };
  if ((f.type === "shell" || f.type === "draft" || f.type === "offsetSurface" || f.type === "deleteFace" || f.type === "untrim" || f.type === "replaceFace") && faces.length) return { ...f, faces };
  const edgeRefs = refs.filter((r) => r.kind === "edge");
  if (f.type === "ruled" && edgeRefs.length) return { ...f, edges: edgeRefs };
  if (f.type === "curve" && edgeRefs.length) return { ...f, def: { kind: "composite", edges: edgeRefs } };
  if (f.type === "boundary" && edgeRefs.length) return { ...f, dir1: edgeRefs.map((ref) => ({ kind: "edge" as const, ref })) };
  if (f.type === "fill") { const es = refs.filter((r) => r.kind === "edge"); if (es.length) return { ...f, edges: es }; }
  const sheetIds = [...new Set(sel.flatMap((p) => (p.kind === "face" && p.body ? [p.body] : [])))];
  if (f.type === "knit" && sheetIds.length) return { ...f, sheets: sheetIds };
  if ((f.type === "thicken" || f.type === "trimSurface") && sheetIds.length) return { ...f, sheet: sheetIds[0] };
  if (f.type === "plane") {
    const p = sel.find((x) => x.kind === "plane");
    if (p) return { ...f, base: p.ref };
    if (faces.length === 1) return { ...f, base: { kind: "face", ref: faces[0] } };
  }
  return f;
}

export function editFeature(s: Store, id: string) {
  const { doc } = s.state;
  const index = doc.features.findIndex((f) => f.id === id);
  if (index < 0 || s.state.sketch) return;
  const f = doc.features[index];
  if (f.type === "sketch") { s.editSketch(id); return; }
  s.set({ edit: { id, isNew: false, draft: structuredClone(f), index }, selectedFeature: id, pickTarget: null });
  s.rebuild();
}

function setTemplates(s: Store, templates: FeatureTemplate[], message: string) {
  s.set({ project: { ...s.state.project, templates }, dirty: true, message });
  s.autosave();
}

export function createTemplate(s: Store, ids: string[], name: string) {
  try {
    const all = s.state.project.templates ?? [];
    const n = all.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0);
    const t = makeTemplate(s.state.doc, ids, name, `t${n + 1}`);
    setTemplates(s, [...all, t], `Template "${name}": ${t.inputs.length} entrada(s), ${t.parameters.length} parâmetro(s)`);
  } catch (e) {
    s.set({ error: (e as Error).message });
  }
}

export function deleteTemplate(s: Store, id: string) {
  setTemplates(s, (s.state.project.templates ?? []).filter((t) => t.id !== id), "Template apagado");
}

export function importTemplate(s: Store, text: string) {
  const j = JSON.parse(text) as { format?: string; template?: FeatureTemplate };
  if (j.format !== "cadp-template" || !j.template?.features) throw new Error("Ficheiro de template inválido");
  const all = s.state.project.templates ?? [];
  const n = all.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0);
  setTemplates(s, [...all, { ...j.template, id: `t${n + 1}` }], `Template "${j.template.name}" importado`);
}

export function instantiateTemplate(s: Store, tpl: FeatureTemplate, bindings: Record<string, string>, values: Record<string, string>): boolean {
  try {
    const { doc, created } = instantiateKnowledge(s.state.doc, tpl, bindings, values);
    s.commitDoc("part", doc as PartDoc, `Instância de ${tpl.name}`);
    s.set({ message: `${created.length} feature(s) criadas a partir de "${tpl.name}"` });
    return true;
  } catch (e) {
    s.set({ error: (e as Error).message });
    return false;
  }
}

export function setPublications(s: Store, publications: Publication[], label = "Publicações") {
  s.commitDoc("part", { ...s.state.doc, publications }, label, true);
}

/** Congela a referência externa em edição (guarda a geometria atual da origem). */
export async function freezeExternal(s: Store) {
  const e = s.state.edit;
  if (!e || e.draft.type !== "external") return;
  try {
    const doc = { ...s.state.doc, features: s.state.doc.features.map((f) => (f.id === e.draft.id ? e.draft : f)) };
    if (!doc.features.some((f) => f.id === e.draft.id)) doc.features = [...doc.features, e.draft];
    const snap = await s.kernel.snapshot(doc, externalParts(s.state.project, doc), e.draft.id);
    updateDraft(s, { mode: "frozen", frozen: snap } as Partial<Feature>);
    s.set({ message: "Referência congelada: a cópia guardada já não acompanha a origem" });
  } catch (err) {
    s.set({ error: (err as Error).message });
  }
}

/**
 * Lê a posição relativa de duas instâncias numa montagem (origem → esta peça) para a referência
 * externa em edição: M = (M_destino)⁻¹ · M_origem.
 */
export async function readPlacement(s: Store, asmId: string, from: string, to: string) {
  const e = s.state.edit;
  if (!e || e.draft.type !== "external") return;
  try {
    const r = await s.kernel.assembly(s.state.project, asmId, false);
    if (!r) return;
    const A = r.instances.find((i) => i.path === from), B = r.instances.find((i) => i.path === to);
    if (!A || !B) throw new Error("Instâncias não encontradas na montagem");
    const m = relativeMatrix(B.matrix, A.matrix).map((x) => Math.round(x * 1e9) / 1e9);
    updateDraft(s, { placement: { m, assembly: asmId, from, to } } as Partial<Feature>);
    if (!r.ok) s.set({ message: "A montagem tem mates por resolver: a posição lida pode não ser a final" });
  } catch (err) {
    s.set({ error: (err as Error).message });
  }
}

/** Acrescenta um deslocamento a um polo da forma livre em edição (soma ao que já tiver). */
export function movePole(s: Store, i: number, j: number, d: Vec3, absolute = false) {
  const e = s.state.edit;
  if (!e || e.draft.type !== "freeform") return;
  const moves = e.draft.moves.slice();
  const k = moves.findIndex((m) => m.i === i && m.j === j);
  const prev = k >= 0 ? moves[k].d : [0, 0, 0];
  const nd = (absolute ? d : [prev[0] + d[0], prev[1] + d[1], prev[2] + d[2]]).map((x) => Math.round(x * 1000) / 1000) as Vec3;
  if (k >= 0) moves.splice(k, 1);
  if (nd.some((x) => x !== 0)) moves.push({ i, j, d: nd });
  s.set({ poleSel: [i, j] });
  updateDraft(s, { moves } as Partial<Feature>);
}

export function updateDraft(s: Store, patch: Partial<Feature>) {
  const e = s.state.edit;
  if (!e) return;
  s.set({ edit: { ...e, draft: { ...e.draft, ...patch } as Feature } });
  s.rebuild();
}

export function confirmEdit(s: Store) {
  const e = s.state.edit;
  if (!e) return;
  const { doc } = s.state;
  let next: CadDocument;
  if (e.isNew) {
    const { id: _id, ...rest } = e.draft;
    next = addFeature(doc, rest as never, e.index).doc;
  } else {
    next = updateFeature(doc, e.id, e.draft);
  }
  s.set({ edit: null, pickTarget: null, selection: [], selectedFeature: e.id, confirmed: { id: e.id, n: (s.state.confirmed?.n ?? 0) + 1 } });
  s.commit(next, `${e.isNew ? "Criar" : "Editar"} ${e.draft.name}`);
}

export function cancelEdit(s: Store) {
  s.set({ edit: null, pickTarget: null, choosingPlane: false });
  s.rebuild(0);
}
