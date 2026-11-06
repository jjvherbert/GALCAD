// Tipos do estado da aplicação e a sua divisão em grupos (documento, sessão, interface), cada um com o seu store.
import type { AxisRef, Feature, GeoHint, PlaneRef, SketchFeature, StdAxis, Vec3 } from "../doc/types.ts";
import type { CadProject, DocRef, Mate, PartDoc } from "../doc/project.ts";
import type { AssemblyResponse, InterferenceResponse, CombsResponse, ContinuityResponse, CurvatureKind, CurvatureResponse, DeviationResponse, DrawingResponse, RebuildResponse } from "../kernel/protocol.ts";
import type { Settings } from "./settings.ts";

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

/*
 * Stores por domínio. Cada campo do estado pertence a um de três grupos, cada grupo tem o seu store
 * (`docStore`, `sessionStore`, `uiStore`) e só os subscritores de um grupo alterado são avisados:
 * - documento: o projeto e o que dele se calcula (resultados, ficheiro, alterações por guardar);
 * - sessão: o que se está a editar ou selecionar (feature, esboço, mate, picks, estudo/desenho em edição);
 * - interface: painéis, sobreposições, estado de trabalho, mensagens e definições.
 * As ações do `Store` continuam a ler `this.state`, a vista unida dos três, que `set` mantém em sincronia.
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

export type StateGroup = "doc" | "session" | "ui";
/** Grupo de cada campo do estado. */
export const GROUP_OF = Object.fromEntries([
  ...DOC_KEYS.map((k) => [k, "doc"]), ...SESSION_KEYS.map((k) => [k, "session"]), ...UI_KEYS.map((k) => [k, "ui"]),
]) as Record<keyof State, StateGroup>;

/** Parte do estado com só os campos `K` (o `Pick` deste módulo é a seleção no viewport, não o utilitário do TS). */
export type StateSlice<K extends keyof State> = { [P in K]: State[P] };

/** Objeto só com os campos `keys` do estado. */
export function pickState<K extends keyof State>(s: State, keys: readonly K[]): StateSlice<K> {
  const out = {} as StateSlice<K>;
  for (const k of keys) out[k] = s[k];
  return out;
}

/** Store de um domínio: guarda só os seus campos e avisa só quem o subscreveu. Escreve-se via `Store.set`. */
export class SubStore<K extends keyof State> {
  readonly keys: readonly K[];
  state: StateSlice<K>;
  readonly listeners = new Set<() => void>();
  constructor(keys: readonly K[], full: State) { this.keys = keys; this.state = pickState(full, keys); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** Volta a tirar a sua parte do estado unido (chamado por `Store.set` quando um campo do grupo muda). */
  sync(full: State) { this.state = pickState(full, this.keys); }
}
export type AnySubStore = SubStore<DocKey> | SubStore<SessionKey> | SubStore<UiKey>;
