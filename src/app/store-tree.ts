// Esboços (criar/editar/sair), operações da árvore (apagar, suprimir, renomear, reordenar, rollback, variáveis, importar) e seleção. Funções que recebem o Store.
import type { Feature, PlaneRef, SketchFeature, Variable } from "../doc/types.ts";
import { addFeature, defaultFeatureName, nextFeatureId, updateFeature } from "../doc/io.ts";
import { dependents, moveFeature } from "../doc/features.ts";
import { defaultFeature } from "./defaults.ts";
import { type Pick, pickHandlers } from "./store-state.ts";
import type { Store } from "./store.ts";

// --- esboços ---

export function startSketch(s: Store, plane?: PlaneRef) {
  const sel = s.state.selection;
  const picked = plane ?? (sel[0]?.kind === "plane" ? sel[0].ref : sel[0]?.kind === "face" && sel[0].type === "plane" ? { kind: "face" as const, ref: { kind: "face" as const, name: sel[0].name, hint: sel[0].hint } } : undefined);
  if (!picked) { s.set({ choosingPlane: true, edit: null }); return; }
  const doc = s.state.doc;
  const draft = { ...defaultFeature(doc, "sketch", { plane: picked }), id: nextFeatureId(doc), name: defaultFeatureName(doc, "sketch") } as Feature & SketchFeature;
  s.set({ sketch: { id: draft.id, isNew: true, draft, index: s.insertIndex() }, choosingPlane: false, selection: [], pickTarget: null });
  s.rebuild(0);
}

export function editSketch(s: Store, id: string) {
  const { doc } = s.state;
  const index = doc.features.findIndex((f) => f.id === id);
  const f = doc.features[index];
  if (f?.type !== "sketch") return;
  s.set({ sketch: { id, isNew: false, draft: structuredClone(f) as Feature & SketchFeature, index }, edit: null, selectedFeature: id, selection: [], pickTarget: null });
  s.rebuild(0);
}

export function updateSketch(s: Store, draft: Feature & SketchFeature) {
  const sk = s.state.sketch;
  if (!sk) return;
  s.set({ sketch: { ...sk, draft } });
}

export function exitSketch(s: Store, save: boolean) {
  const sk = s.state.sketch;
  if (!sk) return;
  s.set({ sketch: null });
  if (!save) { s.rebuild(0); return; }
  const { doc } = s.state;
  if (sk.isNew) {
    const { id: _id, ...rest } = sk.draft;
    s.commit(addFeature(doc, rest as never, sk.index).doc, `Criar ${sk.draft.name}`);
  } else {
    s.commit(updateFeature(doc, sk.id, sk.draft), `Editar ${sk.draft.name}`);
  }
  s.set({ selectedFeature: sk.id });
}

// --- árvore ---

export function deleteFeature(s: Store, id: string) {
  const { doc } = s.state;
  const deps = dependents(doc, id);
  const ids = new Set([id, ...deps]);
  const features = doc.features.filter((f) => !ids.has(f.id));
  const removedBefore = doc.rollback !== undefined ? doc.features.slice(0, doc.rollback).filter((f) => ids.has(f.id)).length : 0;
  const rollback = doc.rollback !== undefined ? doc.rollback - removedBefore : undefined;
  const name = doc.features.find((f) => f.id === id)?.name;
  s.set({ selectedFeature: null });
  s.commit({ ...doc, features, rollback: rollback !== undefined && rollback >= features.length ? undefined : rollback }, `Apagar ${name}${deps.length ? ` e ${deps.length} dependente(s)` : ""}`);
}

export function toggleSuppress(s: Store, id: string) {
  const f = s.state.doc.features.find((x) => x.id === id);
  if (!f) return;
  s.commit(updateFeature(s.state.doc, id, { suppressed: !f.suppressed }), `${f.suppressed ? "Reativar" : "Suprimir"} ${f.name}`);
}

export function rename(s: Store, id: string, name: string) {
  if (!name.trim()) return;
  s.commit(updateFeature(s.state.doc, id, { name: name.trim() }), `Renomear`);
}

export function move(s: Store, id: string, toIndex: number) {
  const r = moveFeature(s.state.doc, id, toIndex);
  if (Array.isArray(r)) { s.set({ message: r[0] }); return; }
  s.commit(r, "Reordenar");
}

export function setRollback(s: Store, index: number | undefined) {
  const n = s.state.doc.features.length;
  s.commit({ ...s.state.doc, rollback: index === undefined || index >= n ? undefined : Math.max(0, index) }, "Rollback");
}

export function setVariables(s: Store, variables: Variable[]) {
  s.commit({ ...s.state.doc, variables }, "Variáveis");
}

export function addImport(s: Store, fileName: string, data: string) {
  const doc = s.state.doc;
  const hasBody = doc.features.some((f) => f.type !== "sketch" && f.type !== "plane" && f.type !== "axis" && f.type !== "csys");
  const r = addFeature(doc, { type: "import", format: "step", fileName, data, op: hasBody ? "new" : "add", name: fileName.replace(/\.(step|stp)$/i, "") });
  s.commit(r.doc, `Importar ${fileName}`);
}

// --- seleção ---

export function pick(s: Store, p: Pick, additive: boolean) {
  const t = s.state.pickTarget;
  if (t) {
    if (t.accept.includes(p.kind)) pickHandlers.get(t.field)?.(p);
    else s.set({ message: `Este campo aceita: ${t.accept.map((k) => ({ face: "faces", edge: "arestas", plane: "planos", axis: "eixos", region: "regiões" })[k]).join(", ")}` });
    return;
  }
  if (p.kind === "region") return; // regiões só se escolhem em campos de feature
  const key = (x: Pick) => (x.kind === "face" || x.kind === "edge" ? `${x.kind}:${x.name}` : x.kind === "region" ? `region:${x.sig.join("+")}` : `${x.kind}:${JSON.stringify(x.ref)}`);
  const sel = s.state.selection;
  const has = sel.some((s) => key(s) === key(p));
  s.set({ selection: additive ? (has ? sel.filter((s) => key(s) !== key(p)) : [...sel, p]) : has && sel.length === 1 ? [] : [p] });
}

export function clearSelection(s: Store) { s.set({ selection: [], contextToolbar: null }); }

/** Substitui (ou soma) a seleção, por exemplo a partir de uma caixa de seleção. */
export function setSelection(s: Store, picks: Pick[], additive: boolean) {
  const t = s.state.pickTarget;
  if (t) { for (const p of picks) if (t.accept.includes(p.kind)) pickHandlers.get(t.field)?.(p); return; }
  const key = (x: Pick) => (x.kind === "face" || x.kind === "edge" ? `${x.kind}:${x.name}` : x.kind === "region" ? `region:${x.sig.join("+")}` : `${x.kind}:${JSON.stringify(x.ref)}`);
  const base = additive ? s.state.selection : [];
  const seen = new Set(base.map(key));
  s.set({ selection: [...base, ...picks.filter((p) => !seen.has(key(p)))], contextToolbar: null });
}
