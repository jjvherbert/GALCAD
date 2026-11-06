// Estado da aplicação: documento, histórico, edição de features/esboços e resultado da reconstrução.
import { useEffect, useReducer, useRef } from "preact/hooks";
import type { CadDocument, Feature, FeatureType, PlaneRef, Publication, SketchFeature, Variable, Vec3 } from "../doc/types.ts";
import { History } from "../doc/history.ts";
import { addFeature, defaultFeatureName, nextFeatureId, updateFeature } from "../doc/io.ts";
import {
  type AssemblyDoc, type CadProject, type Component, type Mate, type MateKind, type MateRef, type DocKind, type DocRef, type DrawingDoc, type PartDoc, type PartProperties,
  newPart, newProject, parseProject, serializeProject,
  type FeatureTemplate,
} from "../doc/project.ts";
import { dependents, moveFeature, FEATURE_LABELS } from "../doc/features.ts";

import type { DrawingResponse, ExportFormat, RebuildResponse } from "../kernel/protocol.ts";
import {
  type Analysis, type AnySubStore, type DocKey, type Pick, type SessionKey, type State, type StateGroup, type StateSlice, type UiKey,
  DOC_KEYS, GROUP_OF, SESSION_KEYS, SubStore, UI_KEYS, pickHandlers, pickState,
} from "./store-state.ts";
export * from "./store-state.ts";

import { KernelClient, KernelRestartError } from "./kernel-client.ts";
import * as asmOps from "./store-assembly.ts";
import * as docOps from "./store-docs.ts";
import * as featOps from "./store-features.ts";
import { externalParts } from "./store-features.ts";
export { externalParts } from "./store-features.ts";
import { defaultFeature } from "./defaults.ts";
import { type Settings, loadSettings, saveSettings } from "./settings.ts";
import { applyTheme } from "./theme.ts";

/** App de ambiente de trabalho (GALCAD para Windows): agente embutido, com endereço e token próprios. */
export const desktopAgent = (): { url: string; token: string } | null => (globalThis as { cadDesktop?: { agent: { url: string; token: string } | null } }).cadDesktop?.agent ?? null;

export class Store {
  kernel = new KernelClient({
    timeoutMs: () => this.state.settings.kernelTimeout * 1000,
    // sem reconstrução automática: repetiria o que o utilizador acabou de cancelar (ou entraria em ciclo
    // com um limite de tempo); o worker novo está vazio até à próxima reconstrução
    onRestart: (i) => {
      this.kernelStale = true;
      if (i.aborted) this.set({ message: "Operação do núcleo cancelada (Ctrl+Q reconstrói)", error: null });
      else this.set({ error: `${i.why} — Ctrl+Q reconstrói` });
    },
    // só é chamado a partir de pedidos, nunca durante a construção (this.state já existe)
    // «Núcleo ocupado»/Parar só aparece se a operação passar de ~300 ms: as rápidas não piscam
    onBusy: (b) => {
      if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
      if (b) this.busyTimer = setTimeout(() => { this.busyTimer = null; this.set({ kernelBusy: true }); }, 300);
      else if (this.state.kernelBusy) this.set({ kernelBusy: false });
    },
  });
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  /** true depois de o worker ser reiniciado: o modelo do núcleo perdeu-se até à próxima reconstrução. */
  private kernelStale = false;
  /** Resolve a promessa da reconstrução agendada que ainda não arrancou. */
  private settleRebuild: (() => void) | null = null;
  state: State;
  histories = new Map<string, History<unknown>>();
  /** Último resultado de simulação/desenho de cada documento: trocar de documento não os perde (A3). */
  simResults = new Map<string, NonNullable<State["simResult"]>>();
  drawingResults = new Map<string, DrawingResponse>();
  /** Última peça/montagem ativa: ao sair do Desenho volta-se a ela, não à primeira peça. */
  lastModelDoc: DocRef | null = null;
  readonly docStore: SubStore<DocKey>;
  readonly sessionStore: SubStore<SessionKey>;
  readonly uiStore: SubStore<UiKey>;
  readonly stores: Record<StateGroup, AnySubStore>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;

  constructor() {
    let project = newProject();
    try {
      const saved = localStorage.getItem(docOps.AUTOSAVE);
      if (saved) project = parseProject(saved);
    } catch { /* sem armazenamento local ou autosave inválido */ }
    if (!project.parts.length) project = { ...project, parts: [newPart(project)] };
    const doc = project.parts[0];
    const settings = loadSettings();
    applyTheme(settings.theme);
    this.state = {
      project, active: { kind: "part", id: doc.id }, doc, asmResult: null, drawingResult: null,
      edit: null, sketch: null, choosingPlane: false, confirmed: null, simFocus: null, result: null, busy: false, kernelBusy: false, rebuildPending: false, error: null, message: null,
      pickTarget: null, selection: [], selectedFeature: null, showVariables: false, showSettings: false, fileName: project.name, dirty: false,
      contextMenu: null, contextToolbar: null, shortcutBar: null, orientationMenu: null, gesture: null, hoverFeature: null,
      settings, lastCommand: null, analysis: null, mateEdit: null, componentEdit: null, interference: null, sidePanel: null, pmiSel: null, pmiView: null, drawingTool: null, drawingSel: null, poleSel: null, poleAxis: "free",
      workspace: "design", simStudy: null, simSection: "study", simBusy: null, simProgress: null,
      simResult: null, simView: { field: 0, disp: 0, scale: 0, hidden: [] }, simHidden: false, agent: desktopAgent() ?? { url: settings.agentUrl, token: "" },
    };
    this.docStore = new SubStore(DOC_KEYS, this.state);
    this.sessionStore = new SubStore(SESSION_KEYS, this.state);
    this.uiStore = new SubStore(UI_KEYS, this.state);
    this.stores = { doc: this.docStore, session: this.sessionStore, ui: this.uiStore };
    this.rebuild(0);
  }

  /** Histórico de desfazer do documento ativo. */
  get history(): History<unknown> {
    const { active } = this.state;
    let h = this.histories.get(active.id);
    if (!h) { h = new History<unknown>({ state: this.activeDoc(), label: "Abrir" }); this.histories.set(active.id, h); }
    return h;
  }

  activeDoc(): PartDoc | AssemblyDoc | DrawingDoc {
    const { project, active } = this.state;
    const list = active.kind === "part" ? project.parts : active.kind === "assembly" ? project.assemblies : project.drawings;
    return list.find((d) => d.id === active.id) ?? project.parts[0];
  }
  activeAssembly(): AssemblyDoc | undefined { return this.state.active.kind === "assembly" ? this.state.project.assemblies.find((a) => a.id === this.state.active.id) : undefined; }
  activeDrawing(): DrawingDoc | undefined { return this.state.active.kind === "drawing" ? this.state.project.drawings.find((d) => d.id === this.state.active.id) : undefined; }

  set(patch: Partial<State>) {
    // os resultados ficam também guardados por documento (o do documento ativo depois do patch)
    const id = (patch.active ?? this.state.active).id;
    if ("simResult" in patch) {
      const r = patch.simResult;
      if (r) this.simResults.set(r.doc, r); else this.simResults.delete(id);
    }
    if ("drawingResult" in patch) {
      const r = patch.drawingResult;
      if (r) this.drawingResults.set(id, r); else this.drawingResults.delete(id);
    }
    // só os grupos com algum campo realmente diferente são atualizados e avisados
    const changed = new Set<StateGroup>();
    for (const k of Object.keys(patch) as (keyof State)[]) {
      if (k in GROUP_OF && !Object.is(patch[k], this.state[k])) changed.add(GROUP_OF[k]);
    }
    this.state = { ...this.state, ...patch };
    const notify = new Set<() => void>();
    for (const g of changed) {
      const sub = this.stores[g];
      sub.sync(this.state);
      for (const l of sub.listeners) notify.add(l);
    }
    for (const l of notify) l();
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

  /**
   * Agenda uma reconstrução. A promessa resolve quando ela termina (com ou sem erro); se for
   * substituída antes de arrancar, resolve quando terminar a que a substituiu.
   */
  rebuild(delay = 60, force = false): Promise<void> {
    clearTimeout(this.timer);
    // só o pedido mais recente limpa `busy`/`rebuildPending`: um pedido substituído (o kernel devolve
    // null) ou feito para outro documento não pode dar a reconstrução por terminada
    const gen = ++this.gen;
    if (!this.state.rebuildPending) this.set({ rebuildPending: true });
    const superseded = this.settleRebuild;
    let settle!: () => void;
    const done = new Promise<void>((r) => { settle = r; });
    this.settleRebuild = settle;
    if (superseded) void done.then(superseded);
    this.timer = setTimeout(async () => {
      if (this.settleRebuild === settle) this.settleRebuild = null;
      this.set({ busy: true });
      const active = this.state.active;
      try {
        if (active.kind === "part") {
          const doc = this.displayDoc();
          const r = await this.kernel.rebuild(doc, force, externalParts(this.state.project, doc));
          if (r) this.kernelStale = false;
          if (r && this.state.active === active) { this.set({ result: r, error: null }); void this.refreshAnalysis(); }
        } else if (active.kind === "assembly") {
          const r = await this.kernel.assembly(this.displayProject(), active.id, force);
          if (r) this.kernelStale = false;
          if (r && this.state.active === active) this.set({ asmResult: r, error: null });
        } else {
          const r = await this.kernel.drawing(this.state.project, active.id, force);
          if (r) this.kernelStale = false;
          if (r && this.state.active === active) this.set({ drawingResult: r, error: null });
        }
      } catch (e) {
        // um reinício do núcleo já é comunicado por onRestart
        if (gen === this.gen && !(e instanceof KernelRestartError)) this.set({ error: (e as Error).message });
      } finally {
        if (gen === this.gen) this.set({ busy: false, rebuildPending: false });
        settle();
      }
    }, delay);
    return done;
  }

  /** Depois de um reinício o worker não tem o modelo: reconstrói antes de pedir algo que dependa dele. */
  async ensureBuilt() {
    if (!this.kernelStale) return;
    await this.rebuild(0, true);
    if (this.kernelStale) throw new Error("O núcleo não tem o modelo carregado; reconstrói com Ctrl+Q");
  }

  /** Botão «Parar»: cancela a operação do núcleo em curso (o worker é reiniciado). */
  cancelKernel() {
    if (!this.kernel.abort()) this.set({ message: "Nada para cancelar no núcleo" });
  }

  /** Exportação do modelo ativo (o worker tem de ter o modelo carregado). */
  async exportModel(format: ExportFormat, name: string) {
    await this.ensureBuilt();
    return this.kernel.export(format, name);
  }

  /** Projeto com o mate em edição aplicado (pré-visualização na montagem). */
  displayProject(): CadProject { return asmOps.displayProject(this); }

  // --- montagens (store-assembly.ts) ----------------------------------------------

  insertComponent(ref: { kind: "part" | "assembly"; id: string }) { asmOps.insertComponent(this, ref); }
  updateComponent(id: string, patch: Partial<Component>) { asmOps.updateComponent(this, id, patch); }
  deleteComponent(id: string) { asmOps.deleteComponent(this, id); }
  /** Começa um mate novo; usa as duas primeiras seleções de componentes, se houver. */
  startMate(kind: MateKind = "coincident") { asmOps.startMate(this, kind); }
  /** Referência de mate a partir de uma seleção no 3D da montagem. */
  mateRefOf(p: Pick): MateRef | null { return asmOps.mateRefOf(p); }
  editMate(id: string) { asmOps.editMate(this, id); }
  updateMateDraft(patch: Partial<Mate>) { asmOps.updateMateDraft(this, patch); }
  confirmMate() { asmOps.confirmMate(this); }
  cancelMate() { asmOps.cancelMate(this); }
  deleteMate(id: string) { asmOps.deleteMate(this, id); }
  toggleMate(id: string) { asmOps.toggleMate(this, id); }
  checkInterference() { return asmOps.checkInterference(this); }

  // --- projeto e documentos (store-docs.ts) ---------------------------------------

  /** Grava um documento no projeto (com desfazer). */
  commitDoc(kind: DocKind, doc: PartDoc | AssemblyDoc | DrawingDoc, label: string, merge = false) { docOps.commitDoc(this, kind, doc, label, merge); }
  commitAssembly(a: AssemblyDoc, label: string, merge = false) { this.commitDoc("assembly", a, label, merge); }
  commitDrawing(d: DrawingDoc, label: string, merge = false) { this.commitDoc("drawing", d, label, merge); }
  setActive(ref: DocRef) { docOps.setActive(this, ref); }
  addDocument(kind: DocKind) { docOps.addDocument(this, kind); }
  deleteDocument(ref: DocRef) { docOps.deleteDocument(this, ref); }
  renameDocument(ref: DocRef, name: string) { docOps.renameDocument(this, ref, name); }
  setPartProperties(props: PartProperties) { docOps.setPartProperties(this, props); }
  /** Liga/desliga uma análise; a curvatura é calculada no núcleo (exata, por vértice). */
  setAnalysis(a: Analysis | null) { return docOps.setAnalysis(this, a); }
  /** Resultado a que pertencem as normais exatas das linhas de realce. */
  normalsFor: RebuildResponse | null = null;
  refreshAnalysis() { return docOps.refreshAnalysis(this); }
  autosave() { docOps.autosave(this); }
  /** Grava a peça ativa. */
  commit(doc: CadDocument, label: string, merge = false) { docOps.commit(this, doc, label, merge); }
  undo() { docOps.undo(this); }
  redo() { docOps.redo(this); }
  newDoc() { docOps.newDoc(this); }
  open(text: string, fileName: string) { docOps.open(this, text, fileName); }

  /** Texto do projeto para guardar. */
  serialized(): string { return serializeProject(this.state.project); }

  // --- features, templates e publicações (store-features.ts) ---------------------

  insertIndex() { return this.state.doc.rollback ?? this.state.doc.features.length; }
  startFeature(type: FeatureType, opts: Parameters<typeof defaultFeature>[2] = {}) { featOps.startFeature(this, type, opts); }
  editFeature(id: string) { featOps.editFeature(this, id); }
  createTemplate(ids: string[], name: string) { featOps.createTemplate(this, ids, name); }
  deleteTemplate(id: string) { featOps.deleteTemplate(this, id); }
  importTemplate(text: string) { featOps.importTemplate(this, text); }
  instantiateTemplate(tpl: FeatureTemplate, bindings: Record<string, string>, values: Record<string, string>): boolean { return featOps.instantiateTemplate(this, tpl, bindings, values); }
  setPublications(publications: Publication[], label = "Publicações") { featOps.setPublications(this, publications, label); }
  /** Congela a referência externa em edição (guarda a geometria atual da origem). */
  freezeExternal() { return featOps.freezeExternal(this); }
  /** Lê a posição relativa de duas instâncias numa montagem para a referência externa em edição. */
  readPlacement(asmId: string, from: string, to: string) { return featOps.readPlacement(this, asmId, from, to); }
  /** Acrescenta um deslocamento a um polo da forma livre em edição (soma ao que já tiver). */
  movePole(i: number, j: number, d: Vec3, absolute = false) { featOps.movePole(this, i, j, d, absolute); }
  updateDraft(patch: Partial<Feature>) { featOps.updateDraft(this, patch); }
  confirmEdit() { featOps.confirmEdit(this); }
  cancelEdit() { featOps.cancelEdit(this); }

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
    applyTheme(settings.theme);
    this.set({ settings });
  }

  /** Endereço do agente (browser): usa-o já e guarda-o nas Definições se for válido; o token fica só em memória. */
  setAgentUrl(url: string) {
    const clean = url.trim().replace(/\/+$/, "");
    this.set({ agent: { ...this.state.agent, url: clean } });
    if (/^https?:\/\/\S+$/.test(clean) && clean !== this.state.settings.agentUrl) this.updateSettings({ agentUrl: clean });
  }

  /** Fecha as sobreposições temporárias (menus, barra de atalhos, barra de contexto). */
  closeOverlays() {
    if (this.state.contextMenu || this.state.contextToolbar || this.state.shortcutBar || this.state.orientationMenu) {
      this.set({ contextMenu: null, contextToolbar: null, shortcutBar: null, orientationMenu: null });
    }
  }
}

export const store = new Store();

/** Compara dois valores e, se forem objetos/arrays, os seus campos de primeiro nível com `Object.is`. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Subscreve só os campos indicados: re-renderiza quando algum deles muda (por referência). Só escuta os
 * stores de domínio a que esses campos pertencem, por isso um `set` noutro domínio nem chega a comparar.
 */
export function useStoreKeys<K extends keyof State>(...keys: K[]): StateSlice<K> {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const value = pickState(store.state, keys);
  // as chaves e o último valor ficam numa ref: a subscrição usa sempre os do último render
  const latest = useRef({ keys, value });
  latest.current = { keys, value };
  const groups = [...new Set(keys.map((k) => GROUP_OF[k]))].sort().join(",");
  useEffect(() => {
    let alive = true;
    const check = () => {
      const { keys: ks, value: prev } = latest.current;
      if (alive && !shallowEqual(prev, pickState(store.state, ks))) force(undefined as never);
    };
    const offs = groups ? groups.split(",").map((g) => store.stores[g as StateGroup].subscribe(check)) : [];
    check(); // uma alteração entre o render e a subscrição não se perde
    return () => { alive = false; for (const off of offs) off(); };
  }, [groups]);
  return value;
}
export const useDocState = <K extends DocKey>(...keys: K[]) => useStoreKeys(...keys);
export const useSessionState = <K extends SessionKey>(...keys: K[]) => useStoreKeys(...keys);
export const useUiState = <K extends UiKey>(...keys: K[]) => useStoreKeys(...keys);

export const featureLabelOf = (t: FeatureType) => FEATURE_LABELS[t];
