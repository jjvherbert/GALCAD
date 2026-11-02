// Estado da aplicação: documento, histórico, edição de features/esboços e resultado da reconstrução.
import { useEffect, useReducer, useRef } from "preact/hooks";
import type { AxisRef, CadDocument, Feature, FeatureData, FeatureType, GeoHint, PlaneRef, Publication, SketchFeature, StdAxis, Variable, Vec3 } from "../doc/types.ts";
import { History } from "../doc/history.ts";
import { addFeature, defaultFeatureName, nextFeatureId, updateFeature } from "../doc/io.ts";
import {
  type AssemblyDoc, type CadProject, type Component, type Mate, type MateKind, type MateRef, containsAssembly, type DocKind, type DocRef, type DrawingDoc, type PartDoc, type PartProperties,
  newAssembly, newDrawing, newPart, newProject, parseProject, serializeProject, usages,
  type FeatureTemplate,
} from "../doc/project.ts";
import { dependents, moveFeature, FEATURE_LABELS } from "../doc/features.ts";
import { instantiateTemplate, makeTemplate } from "../doc/knowledge.ts";

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
import type { AssemblyResponse, InterferenceResponse, CombsResponse, ContinuityResponse, CurvatureKind, CurvatureResponse, DeviationResponse, DrawingResponse, ExportFormat, RebuildResponse } from "../kernel/protocol.ts";

/** Análise de superfície ativa no 3D (separador Avaliar). */
export type Analysis =
  | { kind: "zebra" }
  | { kind: "curvature"; mode: CurvatureKind; data?: CurvatureResponse }
  | { kind: "draft"; dir: StdAxis; angle: number }
  | { kind: "deviation"; data?: DeviationResponse }
  | { kind: "continuity"; data?: ContinuityResponse }
  /** Linhas de realce (highlight lines): luzes lineares paralelas a um eixo, fixas no espaço. */
  | { kind: "highlight"; axis: StdAxis; spacing: number; normals?: Float32Array }
  /** Pentes de curvatura das arestas selecionadas (ou de todas as curvas). */
  | { kind: "combs"; edges?: string[]; gain: number; data?: CombsResponse };
import { KernelClient, KernelRestartError } from "./kernel-client.ts";
import { defaultFeature } from "./defaults.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { type Settings, loadSettings, saveSettings } from "./settings.ts";
import { applyTheme } from "./theme.ts";

/** App de ambiente de trabalho (GALCAD para Windows): agente embutido, com endereço e token próprios. */
export const desktopAgent = (): { url: string; token: string } | null => (globalThis as { cadDesktop?: { agent: { url: string; token: string } | null } }).cadDesktop?.agent ?? null;

export type Pick =
  /** `body`: "" = corpo sólido, senão o id do corpo de superfície; `point`: ponto clicado. */
  | { kind: "face"; name: string; hint: GeoHint; type: string; body?: string; point?: Vec3; component?: string }
  | { kind: "edge"; name: string; hint: GeoHint; type: string; component?: string }
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
  /** Projeto aberto (todas as peças, montagens e desenhos). */
  project: CadProject;
  /** Documento ativo. */
  active: DocRef;
  /** Peça ativa (ou a última peça ativa, quando se está numa montagem/desenho). */
  doc: PartDoc;
  /** Resultado da montagem ativa. */
  asmResult: AssemblyResponse | null;
  /** Resultado do desenho ativo. */
  drawingResult: DrawingResponse | null;
  edit: FeatureEdit | null;
  sketch: SketchEdit | null;
  /** Escolha do plano antes de criar um esboço. */
  choosingPlane: boolean;
  /** Última feature confirmada (o 3D mostra um realce que se desvanece). */
  confirmed: { id: string; n: number } | null;
  /** Condição de simulação a destacar no painel (duplo clique numa face com condição). */
  simFocus: { index: number; n: number } | null;
  result: RebuildResponse | null;
  busy: boolean;
  /** O worker do núcleo tem pedidos por responder (reconstrução, exportação, análise…): mostra «Parar». */
  kernelBusy: boolean;
  /** Há uma reconstrução pedida (em espera ou a correr) que ainda não terminou. */
  rebuildPending: boolean;
  error: string | null;
  message: string | null;
  pickTarget: PickTarget | null;
  /** Seleção no 3D fora de qualquer campo (para pré-preencher comandos). */
  selection: Pick[];
  selectedFeature: string | null;
  showVariables: boolean;
  showSettings: boolean;
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
  /** Mate em edição (montagem ativa). */
  mateEdit: { draft: Mate; isNew: boolean } | null;
  /** Componente cujas propriedades (posição, fixo) se editam. */
  componentEdit: string | null;
  /** Interferências calculadas (montagem ativa). */
  interference: InterferenceResponse | null;
  /** Painel lateral alternativo: BOM ou assistente. */
  sidePanel: "bom" | "ai" | "knowledge" | "sim" | "pmi" | "script" | "galkeel" | "calc" | null;
  /** PMI: item selecionado no painel e vista de modelo aplicada (filtra os rótulos no 3D). */
  pmiSel: string | null;
  pmiView: string | null;
  /** Simulação: último resultado do agente local, vista (campo, deformada, ampliação) e ligação ao agente. */
  /** `doc`: id da peça ou montagem do estudo. */
  simResult: { doc: string; studyId: string; result: import("./sim-client.ts").RunResult } | null;
  simView: { field: number; disp: number; scale: number; hidden: string[] };
  simHidden: boolean;
  agent: { url: string; token: string };
  /** Forma livre em edição: polo selecionado e restrição do arrasto. */
  poleSel: [number, number] | null;
  poleAxis: "free" | "X" | "Y" | "Z";
  /**
   * Espaço de trabalho (ao estilo do Fusion): Design (CAD), Simulação FEM, CFD ou Desenho — cada um
   * com a sua barra de comandos, a sua árvore e os seus painéis.
   */
  workspace: Workspace;
  /** Simulação: estudo e secção do modelo em edição (árvore do modelo → painel à direita). */
  simStudy: string | null;
  simSection: SimSection;
  /** Cálculo em curso no agente e opções do estudo de convergência (partilhadas pela barra e pelo painel). */
  simBusy: "run" | "mesh" | null;
  /** Progresso do trabalho em curso no agente: segundos decorridos e cauda do registo do solver. */
  simProgress: { elapsed: number; tail: string } | null;
  /** Ferramenta ativa no editor de desenhos. */
  drawingTool: DrawingTool | null;
  /** Seleção no desenho (vista ou anotação). */
  drawingSel: { kind: "view" | "ann"; id: string } | null;
}

export type Workspace = "design" | "fem" | "cfd" | "drawing";
export type SimSection = "study" | "material" | "conditions" | "contact" | "probes" | "mesh" | "convergence" | "check" | "run" | "results";

export type DrawingTool =
  | { kind: "modelView"; source: { kind: "part" | "assembly"; id: string }; orientation: import("../doc/project.ts").StdView }
  | { kind: "projected" | "section" | "detail" | "auxiliary"; parent?: string; points?: [number, number][]; edge?: string }
  | { kind: "dim" | "note" | "gdt" | "datum" | "surface" | "weld" | "balloon"; picks?: { view: string; edge: string; at: [number, number] }[] }
  | { kind: "bom" };

const AUTOSAVE = "cad-prototipo:autosave";

/** Partes de um desenho que o núcleo usa (as vistas sem posição; as fontes das tabelas de BOM). */
function drawingKernelKey(d: DrawingDoc): string {
  return JSON.stringify([d.views.map(({ at: _a, name: _n, ...v }) => v), d.sheet, d.annotations.filter((a) => a.kind === "bom").map((a) => (a.kind === "bom" ? a.source : ""))]);
}

class Store {
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
  private histories = new Map<string, History<unknown>>();
  /** Último resultado de simulação/desenho de cada documento: trocar de documento não os perde (A3). */
  private simResults = new Map<string, NonNullable<State["simResult"]>>();
  private drawingResults = new Map<string, DrawingResponse>();
  /** Última peça/montagem ativa: ao sair do Desenho volta-se a ela, não à primeira peça. */
  lastModelDoc: DocRef | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;

  constructor() {
    let project = newProject();
    try {
      const saved = localStorage.getItem(AUTOSAVE);
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

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
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
  private async ensureBuilt() {
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
  displayProject(): CadProject {
    const { project, mateEdit, active } = this.state;
    if (!mateEdit || active.kind !== "assembly") return project;
    return {
      ...project,
      assemblies: project.assemblies.map((a) => a.id !== active.id ? a : {
        ...a, mates: mateEdit.isNew ? [...a.mates, mateEdit.draft] : a.mates.map((m) => (m.id === mateEdit.draft.id ? mateEdit.draft : m)),
      }),
    };
  }

  // --- montagens -----------------------------------------------------------------

  private asm(): AssemblyDoc { const a = this.activeAssembly(); if (!a) throw new Error("Nenhuma montagem ativa"); return a; }

  insertComponent(ref: { kind: "part" | "assembly"; id: string }) {
    const a = this.asm();
    if (ref.kind === "assembly" && containsAssembly(this.state.project, ref.id, a.id)) { this.set({ error: "Uma montagem não pode conter-se a si própria" }); return; }
    const src = ref.kind === "part" ? this.state.project.parts.find((p) => p.id === ref.id) : this.state.project.assemblies.find((x) => x.id === ref.id);
    if (!src) return;
    const n = a.components.filter((c) => c.ref.id === ref.id).length + 1;
    const ids = a.components.map((c) => Number(c.id.slice(1)) || 0);
    const id = `c${Math.max(0, ...ids) + 1}`;
    // ao lado do que já existe, para não sobrepor
    const box = this.state.asmResult?.mass?.bbox;
    const x = box && a.components.length ? box.max[0] + 20 : 0;
    const c: Component = { id, name: `${src.name}<${n}>`, ref, placement: { t: [x, 0, 0], r: [0, 0, 0] }, fixed: a.components.length === 0 ? true : undefined };
    this.commitAssembly({ ...a, components: [...a.components, c] }, `Inserir ${c.name}`);
  }

  updateComponent(id: string, patch: Partial<Component>) {
    const a = this.asm();
    this.commitAssembly({ ...a, components: a.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, "Componente");
  }

  deleteComponent(id: string) {
    const a = this.asm();
    const c = a.components.find((x) => x.id === id);
    const mates = a.mates.filter((m) => m.a.component !== id && m.b.component !== id);
    this.commitAssembly({ ...a, components: a.components.filter((x) => x.id !== id), mates }, `Apagar ${c?.name}${mates.length < a.mates.length ? ` e ${a.mates.length - mates.length} mate(s)` : ""}`);
  }

  /** Começa um mate novo; usa as duas primeiras seleções de componentes, se houver. */
  startMate(kind: MateKind = "coincident") {
    const a = this.asm();
    const ids = a.mates.map((m) => Number(m.id.slice(1)) || 0);
    const refs = this.state.selection.flatMap((p) => this.mateRefOf(p) ?? []);
    const labels: Record<MateKind, string> = { coincident: "Coincidente", concentric: "Concêntrico", parallel: "Paralelo", perpendicular: "Perpendicular", distance: "Distância", angle: "Ângulo", tangent: "Tangente", lock: "Fixar" };
    const n = a.mates.filter((m) => m.kind === kind).length + 1;
    const draft: Mate = { id: `m${Math.max(0, ...ids) + 1}`, name: `${labels[kind]}${n}`, kind, a: refs[0] ?? { component: "", std: "XY" }, b: refs[1] ?? { component: "", std: "XY" } };
    this.set({ mateEdit: { draft, isNew: true }, selection: [], pickTarget: refs.length < 2 ? { field: refs.length ? "mateB" : "mateA", accept: ["face", "edge"] } : null });
    this.rebuild();
  }

  /** Referência de mate a partir de uma seleção no 3D da montagem. */
  mateRefOf(p: Pick): MateRef | null {
    if ((p.kind !== "face" && p.kind !== "edge") || !p.component) return null;
    return { component: p.component, ref: { kind: p.kind, name: p.name, hint: p.hint } };
  }

  editMate(id: string) {
    const m = this.asm().mates.find((x) => x.id === id);
    if (m) { this.set({ mateEdit: { draft: structuredClone(m), isNew: false }, pickTarget: null }); this.rebuild(); }
  }

  updateMateDraft(patch: Partial<Mate>) {
    const e = this.state.mateEdit;
    if (!e) return;
    this.set({ mateEdit: { ...e, draft: { ...e.draft, ...patch } } });
    this.rebuild();
  }

  confirmMate() {
    const e = this.state.mateEdit;
    if (!e) return;
    const a = this.asm();
    this.set({ mateEdit: null, pickTarget: null });
    this.commitAssembly({ ...a, mates: e.isNew ? [...a.mates, e.draft] : a.mates.map((m) => (m.id === e.draft.id ? e.draft : m)) }, `${e.isNew ? "Criar" : "Editar"} ${e.draft.name}`);
  }

  cancelMate() { this.set({ mateEdit: null, pickTarget: null }); this.rebuild(0); }

  deleteMate(id: string) {
    const a = this.asm();
    this.commitAssembly({ ...a, mates: a.mates.filter((m) => m.id !== id) }, "Apagar mate");
  }

  toggleMate(id: string) {
    const a = this.asm();
    this.commitAssembly({ ...a, mates: a.mates.map((m) => (m.id === id ? { ...m, suppressed: !m.suppressed } : m)) }, "Suprimir mate");
  }

  /** Aplica a posição resolvida pelos mates às posições iniciais (o solver parte daí da próxima vez). */
  async checkInterference() {
    try {
      await this.ensureBuilt();
      this.set({ busy: true });
      const r = await this.kernel.interference();
      this.set({ interference: r, busy: false, message: r.pairs.length ? `${r.pairs.length} interferência(s)` : "Sem interferências" });
    } catch (e) {
      // um reinício do núcleo já foi anunciado em onRestart
      this.set(e instanceof KernelRestartError ? { busy: false } : { busy: false, error: (e as Error).message });
    }
  }

  // --- projeto e documentos ------------------------------------------------------

  /** Grava um documento no projeto (com desfazer). */
  commitDoc(kind: DocKind, doc: PartDoc | AssemblyDoc | DrawingDoc, label: string, merge = false) {
    const p = this.state.project;
    const project: CadProject = kind === "part" ? { ...p, parts: p.parts.map((x) => (x.id === doc.id ? (doc as PartDoc) : x)) }
      : kind === "assembly" ? { ...p, assemblies: p.assemblies.map((x) => (x.id === doc.id ? (doc as AssemblyDoc) : x)) }
      : { ...p, drawings: p.drawings.map((x) => (x.id === doc.id ? (doc as DrawingDoc) : x)) };
    if (this.state.active.id === doc.id) this.history.push(doc, label, merge);
    const before = kind === "drawing" ? p.drawings.find((x) => x.id === doc.id) : undefined;
    this.set({ project, dirty: true, ...(kind === "part" && this.state.doc.id === doc.id ? { doc: doc as PartDoc } : {}) });
    this.autosave();
    // num desenho, mover vistas ou editar anotações não muda as projeções: não é preciso o núcleo
    if (kind === "drawing" && before && drawingKernelKey(before) === drawingKernelKey(doc as DrawingDoc) && this.state.drawingResult) return;
    this.rebuild();
  }

  commitAssembly(a: AssemblyDoc, label: string, merge = false) { this.commitDoc("assembly", a, label, merge); }
  commitDrawing(d: DrawingDoc, label: string, merge = false) { this.commitDoc("drawing", d, label, merge); }

  setActive(ref: DocRef) {
    if (this.state.edit || this.state.sketch) { this.set({ message: "Termine primeiro a edição em curso" }); return; }
    const doc = ref.kind === "part" ? this.state.project.parts.find((p) => p.id === ref.id) : undefined;
    this.set({
      active: ref, ...(doc ? { doc, result: null } : {}), selection: [], selectedFeature: null, pickTarget: null, analysis: null,
      // o espaço de trabalho segue o documento: desenhos no Desenho; peças e montagens fora dele (CFD só em peças)
      workspace: ref.kind === "drawing" ? "drawing" : this.state.workspace === "drawing" || (ref.kind === "assembly" && this.state.workspace === "cfd") ? "design" : this.state.workspace,
      asmResult: ref.kind === "assembly" ? this.state.asmResult : null, contextToolbar: null,
      mateEdit: null, componentEdit: null, interference: null, drawingTool: null, drawingSel: null,
      // os resultados do documento novo voltam (A3); o rebuild a seguir atualiza o desenho se o modelo mudou
      simResult: this.simResults.get(ref.id) ?? null,
      drawingResult: ref.kind === "drawing" ? this.drawingResults.get(ref.id) ?? null : null,
    });
    if (ref.kind !== "drawing") this.lastModelDoc = ref;
    this.rebuild(0);
  }

  addDocument(kind: DocKind) {
    const p = this.state.project;
    let project: CadProject, id: string;
    if (kind === "part") { const d = newPart(p); project = { ...p, parts: [...p.parts, d] }; id = d.id; }
    else if (kind === "assembly") { const d = newAssembly(p); project = { ...p, assemblies: [...p.assemblies, d] }; id = d.id; }
    else { const d = newDrawing(p); project = { ...p, drawings: [...p.drawings, d] }; id = d.id; }
    this.set({ project, dirty: true });
    this.autosave();
    this.setActive({ kind, id });
  }

  deleteDocument(ref: DocRef) {
    const p = this.state.project;
    const used = usages(p, ref.id);
    if (used.length) { this.set({ error: `Não é possível apagar: usado em ${used.join(", ")}` }); return; }
    if (ref.kind === "part" && p.parts.length === 1) { this.set({ error: "O projeto tem de ter pelo menos uma peça" }); return; }
    const project: CadProject = {
      ...p,
      parts: p.parts.filter((x) => x.id !== ref.id),
      assemblies: p.assemblies.filter((x) => x.id !== ref.id),
      drawings: p.drawings.filter((x) => x.id !== ref.id),
    };
    this.histories.delete(ref.id);
    this.simResults.delete(ref.id);
    this.drawingResults.delete(ref.id);
    if (this.lastModelDoc?.id === ref.id) this.lastModelDoc = null;
    this.set({ project, dirty: true });
    this.autosave();
    if (this.state.active.id === ref.id) this.setActive({ kind: "part", id: project.parts[0].id });
  }

  renameDocument(ref: DocRef, name: string) {
    if (!name.trim()) return;
    const p = this.state.project;
    const list = ref.kind === "part" ? p.parts : ref.kind === "assembly" ? p.assemblies : p.drawings;
    const d = list.find((x) => x.id === ref.id);
    if (d) this.commitDoc(ref.kind, { ...d, name: name.trim() } as never, "Renomear");
  }

  setPartProperties(props: PartProperties) {
    this.commitDoc("part", { ...this.state.doc, properties: props }, "Propriedades");
  }

  /** Liga/desliga uma análise; a curvatura é calculada no núcleo (exata, por vértice). */
  async setAnalysis(a: Analysis | null) {
    this.set({ analysis: a });
    await this.refreshAnalysis();
  }

  /** Resultado a que pertencem as normais exatas das linhas de realce. */
  private normalsFor: RebuildResponse | null = null;

  private async refreshAnalysis() {
    const a = this.state.analysis;
    if (a?.kind === "highlight" && this.state.result?.mesh && (!a.normals || this.normalsFor !== this.state.result)) {
      try {
        await this.ensureBuilt();
        const res = this.state.result;
        const { normals } = await this.kernel.normals();
        this.normalsFor = res;
        if (this.state.analysis === a) this.set({ analysis: { ...a, normals } });
      } catch (e) { if (!(e instanceof KernelRestartError)) this.set({ error: (e as Error).message }); }
      return;
    }
    if ((a?.kind !== "curvature" && a?.kind !== "deviation" && a?.kind !== "continuity" && a?.kind !== "combs") || !this.state.result?.mesh) return;
    try {
      await this.ensureBuilt();
      const data = a.kind === "curvature" ? await this.kernel.curvature(a.mode)
        : a.kind === "continuity" ? await this.kernel.continuity()
        : a.kind === "combs" ? await this.kernel.combs(a.edges)
        : await this.kernel.deviation();
      if (this.state.analysis === a) this.set({ analysis: { ...a, data } as Analysis });
    } catch (e) {
      if (!(e instanceof KernelRestartError)) this.set({ error: (e as Error).message });
    }
  }

  private autosave() {
    try { localStorage.setItem(AUTOSAVE, serializeProject(this.state.project)); } catch { /* quota/privado: ignorar */ }
  }

  /** Grava a peça ativa. */
  commit(doc: CadDocument, label: string, merge = false) {
    this.commitDoc("part", { ...doc, id: this.state.doc.id, properties: this.state.doc.properties } as PartDoc, label, merge);
  }

  private restore(d: unknown, message: string) {
    const kind = this.state.active.kind;
    const p = this.state.project;
    const doc = d as PartDoc & AssemblyDoc & DrawingDoc;
    const project: CadProject = kind === "part" ? { ...p, parts: p.parts.map((x) => (x.id === doc.id ? doc : x)) }
      : kind === "assembly" ? { ...p, assemblies: p.assemblies.map((x) => (x.id === doc.id ? doc : x)) }
      : { ...p, drawings: p.drawings.map((x) => (x.id === doc.id ? doc : x)) };
    this.set({ project, message, ...(kind === "part" ? { doc } : {}) });
    this.autosave();
    this.rebuild(0);
  }

  undo() {
    if (this.state.edit || this.state.sketch) return;
    const d = this.history.undo();
    if (d) this.restore(d, "Desfeito");
  }
  redo() {
    if (this.state.edit || this.state.sketch) return;
    const d = this.history.redo();
    if (d) this.restore(d, "Refeito");
  }

  // --- ficheiros -------------------------------------------------------------

  newDoc() {
    const project = newProject();
    this.histories.clear();
    this.simResults.clear();
    this.drawingResults.clear();
    this.lastModelDoc = null;
    this.set({ project, active: { kind: "part", id: project.parts[0].id }, doc: project.parts[0], result: null, asmResult: null, drawingResult: null, simResult: null, edit: null, sketch: null, selection: [], selectedFeature: null, fileName: project.name, dirty: false, pickTarget: null });
    this.autosave();
    this.rebuild(0);
  }

  open(text: string, fileName: string) {
    const project = parseProject(text);
    if (!project.parts.length) project.parts.push(newPart(project));
    this.histories.clear();
    this.simResults.clear();
    this.drawingResults.clear();
    this.lastModelDoc = null;
    const name = fileName.replace(/\.cadp\.json$|\.json$/i, "");
    this.set({ project: { ...project, name: project.name || name }, active: { kind: "part", id: project.parts[0].id }, doc: project.parts[0], result: null, asmResult: null, drawingResult: null, simResult: null, edit: null, sketch: null, selection: [], selectedFeature: null, fileName: name, dirty: false });
    this.autosave();
    this.rebuild(0);
  }

  /** Texto do projeto para guardar. */
  serialized(): string { return serializeProject(this.state.project); }

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

  editFeature(id: string) {
    const { doc } = this.state;
    const index = doc.features.findIndex((f) => f.id === id);
    if (index < 0 || this.state.sketch) return;
    const f = doc.features[index];
    if (f.type === "sketch") { this.editSketch(id); return; }
    this.set({ edit: { id, isNew: false, draft: structuredClone(f), index }, selectedFeature: id, pickTarget: null });
    this.rebuild();
  }

  // --- templates de features (knowledgeware) ------------------------------------

  private setTemplates(templates: FeatureTemplate[], message: string) {
    this.set({ project: { ...this.state.project, templates }, dirty: true, message });
    this.autosave();
  }

  createTemplate(ids: string[], name: string) {
    try {
      const all = this.state.project.templates ?? [];
      const n = all.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0);
      const t = makeTemplate(this.state.doc, ids, name, `t${n + 1}`);
      this.setTemplates([...all, t], `Template "${name}": ${t.inputs.length} entrada(s), ${t.parameters.length} parâmetro(s)`);
    } catch (e) {
      this.set({ error: (e as Error).message });
    }
  }

  deleteTemplate(id: string) {
    this.setTemplates((this.state.project.templates ?? []).filter((t) => t.id !== id), "Template apagado");
  }

  importTemplate(text: string) {
    const j = JSON.parse(text) as { format?: string; template?: FeatureTemplate };
    if (j.format !== "cadp-template" || !j.template?.features) throw new Error("Ficheiro de template inválido");
    const all = this.state.project.templates ?? [];
    const n = all.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0);
    this.setTemplates([...all, { ...j.template, id: `t${n + 1}` }], `Template "${j.template.name}" importado`);
  }

  instantiateTemplate(tpl: FeatureTemplate, bindings: Record<string, string>, values: Record<string, string>): boolean {
    try {
      const { doc, created } = instantiateTemplate(this.state.doc, tpl, bindings, values);
      this.commitDoc("part", doc as PartDoc, `Instância de ${tpl.name}`);
      this.set({ message: `${created.length} feature(s) criadas a partir de "${tpl.name}"` });
      return true;
    } catch (e) {
      this.set({ error: (e as Error).message });
      return false;
    }
  }

  // --- publicações e referências externas ---------------------------------------

  setPublications(publications: Publication[], label = "Publicações") {
    this.commitDoc("part", { ...this.state.doc, publications }, label, true);
  }

  /** Congela a referência externa em edição (guarda a geometria atual da origem). */
  async freezeExternal() {
    const e = this.state.edit;
    if (!e || e.draft.type !== "external") return;
    try {
      const doc = { ...this.state.doc, features: this.state.doc.features.map((f) => (f.id === e.draft.id ? e.draft : f)) };
      if (!doc.features.some((f) => f.id === e.draft.id)) doc.features = [...doc.features, e.draft];
      const snap = await this.kernel.snapshot(doc, externalParts(this.state.project, doc), e.draft.id);
      this.updateDraft({ mode: "frozen", frozen: snap } as Partial<Feature>);
      this.set({ message: "Referência congelada: a cópia guardada já não acompanha a origem" });
    } catch (err) {
      this.set({ error: (err as Error).message });
    }
  }

  /**
   * Lê a posição relativa de duas instâncias numa montagem (origem → esta peça) para a referência
   * externa em edição: M = (M_destino)⁻¹ · M_origem.
   */
  async readPlacement(asmId: string, from: string, to: string) {
    const e = this.state.edit;
    if (!e || e.draft.type !== "external") return;
    try {
      const r = await this.kernel.assembly(this.state.project, asmId, false);
      if (!r) return;
      const A = r.instances.find((i) => i.path === from), B = r.instances.find((i) => i.path === to);
      if (!A || !B) throw new Error("Instâncias não encontradas na montagem");
      const m = relativeMatrix(B.matrix, A.matrix).map((x) => Math.round(x * 1e9) / 1e9);
      this.updateDraft({ placement: { m, assembly: asmId, from, to } } as Partial<Feature>);
      if (!r.ok) this.set({ message: "A montagem tem mates por resolver: a posição lida pode não ser a final" });
    } catch (err) {
      this.set({ error: (err as Error).message });
    }
  }

  /** Acrescenta um deslocamento a um polo da forma livre em edição (soma ao que já tiver). */
  movePole(i: number, j: number, d: Vec3, absolute = false) {
    const e = this.state.edit;
    if (!e || e.draft.type !== "freeform") return;
    const moves = e.draft.moves.slice();
    const k = moves.findIndex((m) => m.i === i && m.j === j);
    const prev = k >= 0 ? moves[k].d : [0, 0, 0];
    const nd = (absolute ? d : [prev[0] + d[0], prev[1] + d[1], prev[2] + d[2]]).map((x) => Math.round(x * 1000) / 1000) as Vec3;
    if (k >= 0) moves.splice(k, 1);
    if (nd.some((x) => x !== 0)) moves.push({ i, j, d: nd });
    this.set({ poleSel: [i, j] });
    this.updateDraft({ moves } as Partial<Feature>);
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
    this.set({ edit: null, pickTarget: null, selection: [], selectedFeature: e.id, confirmed: { id: e.id, n: (this.state.confirmed?.n ?? 0) + 1 } });
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
 * Sem argumentos devolve o estado todo e re-renderiza a cada alteração (comportamento antigo).
 * Com `selector`, só re-renderiza quando o valor selecionado muda segundo `eq` (por defeito `Object.is`;
 * use `shallowEqual` para seletores que montam objetos ou arrays novos).
 */
export function useStore(): State;
export function useStore<T>(selector: (s: State) => T, eq?: (a: T, b: T) => boolean): T;
export function useStore<T>(selector?: (s: State) => T, eq: (a: T, b: T) => boolean = Object.is): State | T {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const value = selector ? selector(store.state) : store.state;
  // o seletor, a comparação e o último valor ficam em refs: a subscrição usa sempre os do último render
  const latest = useRef({ selector, eq, value });
  latest.current = { selector, eq, value };
  useEffect(() => store.subscribe(() => {
    const { selector: sel, eq: same, value: prev } = latest.current;
    if (!sel || !same(prev as T, sel(store.state))) force(undefined as never);
  }), []);
  return value;
}

/*
 * Fachada por domínio. O estado continua num só `Store` (as ações não mudam), mas cada campo pertence a
 * um de três grupos e os componentes subscrevem só os campos que usam:
 * - documento: o projeto e o que dele se calcula (resultados, ficheiro, alterações por guardar);
 * - sessão: o que se está a editar ou selecionar (feature, esboço, mate, picks, estudo/desenho em edição);
 * - interface: painéis, sobreposições, estado de trabalho, mensagens e definições.
 */
export const DOC_KEYS = [
  "project", "active", "doc", "result", "asmResult", "drawingResult", "simResult", "interference", "analysis", "fileName", "dirty",
] as const satisfies readonly (keyof State)[];
export const SESSION_KEYS = [
  "edit", "sketch", "choosingPlane", "confirmed", "simFocus", "pickTarget", "selection", "selectedFeature", "hoverFeature",
  "lastCommand", "mateEdit", "componentEdit", "pmiSel", "poleSel", "poleAxis", "simStudy", "simSection", "drawingTool", "drawingSel",
] as const satisfies readonly (keyof State)[];
export const UI_KEYS = [
  "workspace", "sidePanel", "busy", "kernelBusy", "rebuildPending", "error", "message", "showVariables", "showSettings",
  "contextMenu", "contextToolbar", "shortcutBar", "orientationMenu", "gesture", "settings", "pmiView", "simView", "simHidden",
  "agent", "simBusy", "simProgress",
] as const satisfies readonly (keyof State)[];
export type DocKey = (typeof DOC_KEYS)[number];
export type SessionKey = (typeof SESSION_KEYS)[number];
export type UiKey = (typeof UI_KEYS)[number];
// um campo novo em `State` que não entre num grupo falha a compilação aqui (a disjunção verifica-se nos testes)
type Ungrouped = Exclude<keyof State, DocKey | SessionKey | UiKey>;
export const ALL_GROUPED: [Ungrouped] extends [never] ? true : Ungrouped = true;

/** Parte do estado com só os campos `K` (o `Pick` deste módulo é a seleção no viewport, não o utilitário do TS). */
export type StateSlice<K extends keyof State> = { [P in K]: State[P] };

/** Objeto só com os campos `keys` do estado. */
export function pickState<K extends keyof State>(s: State, keys: readonly K[]): StateSlice<K> {
  const out = {} as StateSlice<K>;
  for (const k of keys) out[k] = s[k];
  return out;
}

/** Subscreve só os campos indicados: re-renderiza quando algum deles muda (por referência). */
export function useStoreKeys<K extends keyof State>(...keys: K[]): StateSlice<K> {
  return useStore((s) => pickState(s, keys), shallowEqual);
}
export const useDocState = <K extends DocKey>(...keys: K[]) => useStoreKeys(...keys);
export const useSessionState = <K extends SessionKey>(...keys: K[]) => useStoreKeys(...keys);
export const useUiState = <K extends UiKey>(...keys: K[]) => useStoreKeys(...keys);

export const featureLabelOf = (t: FeatureType) => FEATURE_LABELS[t];
