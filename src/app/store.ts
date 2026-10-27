// Estado da aplicação: documento, histórico, edição de features/esboços e resultado da reconstrução.
import { useEffect, useReducer } from "preact/hooks";
import type { AxisRef, CadDocument, Feature, FeatureData, FeatureType, GeoHint, PlaneRef, SketchFeature, StdAxis, Variable, Vec3 } from "../doc/types.ts";
import { History } from "../doc/history.ts";
import { addFeature, defaultFeatureName, newDocument, nextFeatureId, parseDocument, serialize, updateFeature } from "../doc/io.ts";
import { dependents, moveFeature, FEATURE_LABELS } from "../doc/features.ts";
import type { CurvatureKind, CurvatureResponse, RebuildResponse } from "../kernel/protocol.ts";

/** Análise de superfície ativa no 3D (separador Avaliar). */
export type Analysis =
  | { kind: "zebra" }
  | { kind: "curvature"; mode: CurvatureKind; data?: CurvatureResponse }
  | { kind: "draft"; dir: StdAxis; angle: number };
import { KernelClient } from "./kernel-client.ts";
import { defaultFeature } from "./defaults.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { type Settings, loadSettings, saveSettings } from "./settings.ts";

export type Pick =
  /** `body`: "" = corpo sólido, senão o id do corpo de superfície; `point`: ponto clicado. */
  | { kind: "face"; name: string; hint: GeoHint; type: string; body?: string; point?: Vec3 }
  | { kind: "edge"; name: string; hint: GeoHint; type: string }
  | { kind: "plane"; ref: PlaneRef; label: string }
  | { kind: "axis"; ref: AxisRef; label: string }
  | { kind: "region"; sketch: string; sig: string[]; seed: [number, number] };

export type PickKind = Pick["kind"];

/** Campo do painel que está à espera de seleções no 3D (o handler está em `pickHandlers`). */
export interface PickTarget {
  field: string;
  accept: PickKind[];
}

/** Handlers dos campos de seleção, atualizados a cada render (não fazem parte do estado). */
export const pickHandlers = new Map<string, (p: Pick) => void>();

export interface FeatureEdit {
  id: string;
  isNew: boolean;
  draft: Feature;
  /** Índice onde a feature nova será inserida. */
  index: number;
}

export interface SketchEdit {
  id: string;
  isNew: boolean;
  draft: Feature & SketchFeature;
  index: number;
}

export interface State {
  doc: CadDocument;
  edit: FeatureEdit | null;
  sketch: SketchEdit | null;
  /** Escolha do plano antes de criar um esboço. */
  choosingPlane: boolean;
  result: RebuildResponse | null;
  busy: boolean;
  error: string | null;
  message: string | null;
  pickTarget: PickTarget | null;
  /** Seleção no 3D fora de qualquer campo (para pré-preencher comandos). */
  selection: Pick[];
  selectedFeature: string | null;
  showVariables: boolean;
  fileName: string;
  dirty: boolean;
  /** Sobreposições da interface (posições em coordenadas do ecrã). */
  contextMenu: { at: [number, number]; pick: Pick | null } | null;
  contextToolbar: { at: [number, number]; pick: Pick } | null;
  shortcutBar: { at: [number, number] } | null;
  orientationMenu: { at: [number, number] } | null;
  gesture: { at: [number, number]; dir: import("./settings.ts").GestureDir | null } | null;
  /** Feature sob o rato na árvore (realçada no 3D). */
  hoverFeature: string | null;
  settings: Settings;
  /** Último comando executado (Enter repete). */
  lastCommand: string | null;
  analysis: Analysis | null;
}

const AUTOSAVE = "cad-prototipo:autosave";

class Store {
  history: History<CadDocument>;
  kernel = new KernelClient();
  state: State;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    let doc = newDocument();
    try {
      const saved = localStorage.getItem(AUTOSAVE);
      if (saved) doc = parseDocument(saved);
    } catch { /* sem armazenamento local */ }
    this.history = new History({ state: doc, label: "Abrir" });
    this.state = {
      doc, edit: null, sketch: null, choosingPlane: false, result: null, busy: false, error: null, message: null,
      pickTarget: null, selection: [], selectedFeature: null, showVariables: false, fileName: doc.name, dirty: false,
      contextMenu: null, contextToolbar: null, shortcutBar: null, orientationMenu: null, gesture: null, hoverFeature: null,
      settings: loadSettings(), lastCommand: null, analysis: null,
    };
    this.rebuild(0);
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Documento apresentado: o confirmado com a edição em curso aplicada. */
  displayDoc(): CadDocument {
    const { doc, edit, sketch } = this.state;
    if (sketch) {
      const features = doc.features.slice();
      if (sketch.isNew) features.splice(sketch.index, 0, sketch.draft);
      else features[sketch.index] = sketch.draft;
      return { ...doc, features, rollback: sketch.index + 1 };
    }
    if (edit) {
      const features = doc.features.slice();
      // ao escolher as partes a manter de um aparar, mostra-se a superfície inteira
      const draft = edit.draft.type === "trimSurface" && this.state.pickTarget?.field === "keep" ? { ...edit.draft, suppressed: true } : edit.draft;
      if (edit.isNew) {
        features.splice(edit.index, 0, draft);
        return { ...doc, features, rollback: doc.rollback !== undefined ? edit.index + 1 : undefined };
      }
      features[edit.index] = draft;
      return { ...doc, features };
    }
    return doc;
  }

  rebuild(delay = 60, force = false) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.set({ busy: true });
      try {
        const r = await this.kernel.rebuild(this.displayDoc(), force);
        if (r) { this.set({ result: r, busy: false, error: null }); void this.refreshAnalysis(); }
      } catch (e) {
        this.set({ busy: false, error: (e as Error).message });
      }
    }, delay);
  }

  /** Liga/desliga uma análise; a curvatura é calculada no núcleo (exata, por vértice). */
  async setAnalysis(a: Analysis | null) {
    this.set({ analysis: a });
    await this.refreshAnalysis();
  }

  private async refreshAnalysis() {
    const a = this.state.analysis;
    if (a?.kind !== "curvature" || !this.state.result?.mesh) return;
    try {
      const data = await this.kernel.curvature(a.mode);
      if (this.state.analysis === a) this.set({ analysis: { ...a, data } });
    } catch (e) {
      this.set({ error: (e as Error).message });
    }
  }

  private autosave(doc: CadDocument) {
    try { localStorage.setItem(AUTOSAVE, serialize(doc)); } catch { /* quota/privado: ignorar */ }
  }

  commit(doc: CadDocument, label: string, merge = false) {
    this.history.push(doc, label, merge);
    this.set({ doc, dirty: true });
    this.autosave(doc);
    this.rebuild();
  }

  undo() {
    if (this.state.edit || this.state.sketch) return;
    const d = this.history.undo();
    if (d) { this.set({ doc: d, message: `Desfeito` }); this.autosave(d); this.rebuild(0); }
  }
  redo() {
    if (this.state.edit || this.state.sketch) return;
    const d = this.history.redo();
    if (d) { this.set({ doc: d, message: `Refeito` }); this.autosave(d); this.rebuild(0); }
  }

  // --- ficheiros -------------------------------------------------------------

  newDoc() {
    const d = newDocument();
    this.history.reset(d, "Novo");
    this.set({ doc: d, edit: null, sketch: null, selection: [], selectedFeature: null, fileName: d.name, dirty: false, pickTarget: null });
    this.autosave(d);
    this.rebuild(0);
  }

  open(text: string, fileName: string) {
    const d = parseDocument(text);
    this.history.reset(d, "Abrir");
    this.set({ doc: d, edit: null, sketch: null, selection: [], selectedFeature: null, fileName: fileName.replace(/\.cadp\.json$|\.json$/i, ""), dirty: false });
    this.autosave(d);
    this.rebuild(0);
  }

  // --- features --------------------------------------------------------------

  insertIndex() { return this.state.doc.rollback ?? this.state.doc.features.length; }

  startFeature(type: FeatureType, opts: Parameters<typeof defaultFeature>[2] = {}) {
    if (this.state.sketch) return;
    if (type === "sketch") { this.startSketch(opts.plane); return; }
    const doc = this.state.doc;
    const data = this.prefill(defaultFeature(doc, type, opts));
    let name = defaultFeatureName(doc, type);
    if (data.type === "plugin") {
      const label = PLUGINS.find((p) => p.id === data.plugin)?.kinds[data.kind]?.label.split(" ")[0] ?? "Plugin";
      const names = new Set(doc.features.map((f) => f.name));
      for (let i = 1; ; i++) if (!names.has(`${label}${i}`)) { name = `${label}${i}`; break; }
    }
    const draft = { ...data, id: nextFeatureId(doc), name } as Feature;
    this.set({ edit: { id: draft.id, isNew: true, draft, index: this.insertIndex() }, choosingPlane: false, pickTarget: null });
    this.rebuild();
  }

  /** Usa a seleção atual no 3D para pré-preencher a feature (ex.: arestas para um filete). */
  private prefill(f: FeatureData): FeatureData {
    const sel = this.state.selection;
    const refs = sel.filter((p): p is Extract<Pick, { kind: "face" | "edge" }> => p.kind === "face" || p.kind === "edge").map((p) => ({ kind: p.kind, name: p.name, hint: p.hint }));
    const faces = refs.filter((r) => r.kind === "face");
    if ((f.type === "fillet" || f.type === "chamfer") && refs.length) return { ...f, refs };
    if ((f.type === "shell" || f.type === "draft" || f.type === "offsetSurface" || f.type === "deleteFace") && faces.length) return { ...f, faces };
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

  editFeature(id: string) {
    const { doc } = this.state;
    const index = doc.features.findIndex((f) => f.id === id);
    if (index < 0 || this.state.sketch) return;
    const f = doc.features[index];
    if (f.type === "sketch") { this.editSketch(id); return; }
    this.set({ edit: { id, isNew: false, draft: structuredClone(f), index }, selectedFeature: id, pickTarget: null });
    this.rebuild();
  }

  updateDraft(patch: Partial<Feature>) {
    const e = this.state.edit;
    if (!e) return;
    this.set({ edit: { ...e, draft: { ...e.draft, ...patch } as Feature } });
    this.rebuild();
  }

  confirmEdit() {
    const e = this.state.edit;
    if (!e) return;
    const { doc } = this.state;
    let next: CadDocument;
    if (e.isNew) {
      const { id: _id, ...rest } = e.draft;
      next = addFeature(doc, rest as never, e.index).doc;
    } else {
      next = updateFeature(doc, e.id, e.draft);
    }
    this.set({ edit: null, pickTarget: null, selection: [], selectedFeature: e.id });
    this.commit(next, `${e.isNew ? "Criar" : "Editar"} ${e.draft.name}`);
  }

  cancelEdit() {
    this.set({ edit: null, pickTarget: null, choosingPlane: false });
    this.rebuild(0);
  }

  // --- esboços ---------------------------------------------------------------

  startSketch(plane?: PlaneRef) {
    const sel = this.state.selection;
    const picked = plane ?? (sel[0]?.kind === "plane" ? sel[0].ref : sel[0]?.kind === "face" && sel[0].type === "plane" ? { kind: "face" as const, ref: { kind: "face" as const, name: sel[0].name, hint: sel[0].hint } } : undefined);
    if (!picked) { this.set({ choosingPlane: true, edit: null }); return; }
    const doc = this.state.doc;
    const draft = { ...defaultFeature(doc, "sketch", { plane: picked }), id: nextFeatureId(doc), name: defaultFeatureName(doc, "sketch") } as Feature & SketchFeature;
    this.set({ sketch: { id: draft.id, isNew: true, draft, index: this.insertIndex() }, choosingPlane: false, selection: [], pickTarget: null });
    this.rebuild(0);
  }

  editSketch(id: string) {
    const { doc } = this.state;
    const index = doc.features.findIndex((f) => f.id === id);
    const f = doc.features[index];
    if (f?.type !== "sketch") return;
    this.set({ sketch: { id, isNew: false, draft: structuredClone(f) as Feature & SketchFeature, index }, edit: null, selectedFeature: id, selection: [], pickTarget: null });
    this.rebuild(0);
  }

  updateSketch(draft: Feature & SketchFeature) {
    const s = this.state.sketch;
    if (!s) return;
    this.set({ sketch: { ...s, draft } });
  }

  exitSketch(save: boolean) {
    const s = this.state.sketch;
    if (!s) return;
    this.set({ sketch: null });
    if (!save) { this.rebuild(0); return; }
    const { doc } = this.state;
    if (s.isNew) {
      const { id: _id, ...rest } = s.draft;
      this.commit(addFeature(doc, rest as never, s.index).doc, `Criar ${s.draft.name}`);
    } else {
      this.commit(updateFeature(doc, s.id, s.draft), `Editar ${s.draft.name}`);
    }
    this.set({ selectedFeature: s.id });
  }

  // --- árvore ----------------------------------------------------------------

  deleteFeature(id: string) {
    const { doc } = this.state;
    const deps = dependents(doc, id);
    const ids = new Set([id, ...deps]);
    const features = doc.features.filter((f) => !ids.has(f.id));
    const removedBefore = doc.rollback !== undefined ? doc.features.slice(0, doc.rollback).filter((f) => ids.has(f.id)).length : 0;
    const rollback = doc.rollback !== undefined ? doc.rollback - removedBefore : undefined;
    const name = doc.features.find((f) => f.id === id)?.name;
    this.set({ selectedFeature: null });
    this.commit({ ...doc, features, rollback: rollback !== undefined && rollback >= features.length ? undefined : rollback }, `Apagar ${name}${deps.length ? ` e ${deps.length} dependente(s)` : ""}`);
  }

  toggleSuppress(id: string) {
    const f = this.state.doc.features.find((x) => x.id === id);
    if (!f) return;
    this.commit(updateFeature(this.state.doc, id, { suppressed: !f.suppressed }), `${f.suppressed ? "Reativar" : "Suprimir"} ${f.name}`);
  }

  rename(id: string, name: string) {
    if (!name.trim()) return;
    this.commit(updateFeature(this.state.doc, id, { name: name.trim() }), `Renomear`);
  }

  move(id: string, toIndex: number) {
    const r = moveFeature(this.state.doc, id, toIndex);
    if (Array.isArray(r)) { this.set({ message: r[0] }); return; }
    this.commit(r, "Reordenar");
  }

  setRollback(index: number | undefined) {
    const n = this.state.doc.features.length;
    this.commit({ ...this.state.doc, rollback: index === undefined || index >= n ? undefined : Math.max(0, index) }, "Rollback");
  }

  setVariables(variables: Variable[]) {
    this.commit({ ...this.state.doc, variables }, "Variáveis");
  }

  addImport(fileName: string, data: string) {
    const doc = this.state.doc;
    const hasBody = doc.features.some((f) => f.type !== "sketch" && f.type !== "plane" && f.type !== "axis" && f.type !== "csys");
    const r = addFeature(doc, { type: "import", format: "step", fileName, data, op: hasBody ? "new" : "add", name: fileName.replace(/\.(step|stp)$/i, "") });
    this.commit(r.doc, `Importar ${fileName}`);
  }

  // --- seleção ---------------------------------------------------------------

  pick(p: Pick, additive: boolean) {
    const t = this.state.pickTarget;
    if (t) {
      if (t.accept.includes(p.kind)) pickHandlers.get(t.field)?.(p);
      else this.set({ message: `Este campo aceita: ${t.accept.map((k) => ({ face: "faces", edge: "arestas", plane: "planos", axis: "eixos", region: "regiões" })[k]).join(", ")}` });
      return;
    }
    if (p.kind === "region") return; // regiões só se escolhem em campos de feature
    const key = (x: Pick) => (x.kind === "face" || x.kind === "edge" ? `${x.kind}:${x.name}` : x.kind === "region" ? `region:${x.sig.join("+")}` : `${x.kind}:${JSON.stringify(x.ref)}`);
    const sel = this.state.selection;
    const has = sel.some((s) => key(s) === key(p));
    this.set({ selection: additive ? (has ? sel.filter((s) => key(s) !== key(p)) : [...sel, p]) : has && sel.length === 1 ? [] : [p] });
  }

  clearSelection() { this.set({ selection: [], contextToolbar: null }); }

  /** Substitui (ou soma) a seleção, por exemplo a partir de uma caixa de seleção. */
  setSelection(picks: Pick[], additive: boolean) {
    const t = this.state.pickTarget;
    if (t) { for (const p of picks) if (t.accept.includes(p.kind)) pickHandlers.get(t.field)?.(p); return; }
    const key = (x: Pick) => (x.kind === "face" || x.kind === "edge" ? `${x.kind}:${x.name}` : x.kind === "region" ? `region:${x.sig.join("+")}` : `${x.kind}:${JSON.stringify(x.ref)}`);
    const base = additive ? this.state.selection : [];
    const seen = new Set(base.map(key));
    this.set({ selection: [...base, ...picks.filter((p) => !seen.has(key(p)))], contextToolbar: null });
  }

  updateSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch };
    saveSettings(settings);
    this.set({ settings });
  }

  /** Fecha as sobreposições temporárias (menus, barra de atalhos, barra de contexto). */
  closeOverlays() {
    if (this.state.contextMenu || this.state.contextToolbar || this.state.shortcutBar || this.state.orientationMenu) {
      this.set({ contextMenu: null, contextToolbar: null, shortcutBar: null, orientationMenu: null });
    }
  }
}

export const store = new Store();

export function useStore(): State {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(() => force(undefined as never)), []);
  return store.state;
}

export const featureLabelOf = (t: FeatureType) => FEATURE_LABELS[t];
