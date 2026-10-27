// Registo central de comandos e atalhos de teclado (por defeito, os do SolidWorks).
// Usado pelo teclado, pela barra de atalhos (S), pelos gestos e pelos menus.
import type { FeatureType } from "../doc/types.ts";
import { FEATURE_ICONS, FEATURE_LABELS, SURFACE_TYPES } from "../doc/features.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { store } from "./store.ts";
import type { Viewport, ViewName } from "./viewport.ts";
import { VIEWS } from "./viewport.ts";
import { EXPORTS, exportAs, importStep, openProject, saveProject } from "./fileio.ts";

export interface Command {
  id: string;
  label: string;
  group: "Vista" | "Ficheiro" | "Editar" | "Features" | "Superfícies" | "Esboço" | "Referências" | "Avaliar" | "Módulos" | "Exportar";
  /** Atalhos, no formato "Ctrl+Shift+Z", "F", "Space", "ArrowLeft". */
  keys?: string[];
  icon?: string;
  run: () => void;
  /** Comando de criação (repetível com Enter). */
  repeatable?: boolean;
}

let viewport: Viewport | null = null;
export const setCommandViewport = (v: Viewport) => { viewport = v; };

const busy = () => !!store.state.edit || !!store.state.sketch;

/** "Normal a": face plana ou plano selecionado; sem seleção, a vista padrão mais próxima. */
function normalTo() {
  const v = viewport;
  if (!v) return;
  const sel = store.state.selection[0];
  if (sel?.kind === "face" && sel.hint.n) { v.normalTo(sel.hint.c, sel.hint.n); return; }
  if (sel?.kind === "plane") {
    const r = sel.ref;
    const fr = r.kind === "datum" ? store.state.result?.planes[r.feature] : r.kind === "std" ? { XY: { o: [0, 0, 0], z: [0, 0, 1], y: [0, 1, 0] }, XZ: { o: [0, 0, 0], z: [0, -1, 0], y: [0, 0, 1] }, YZ: { o: [0, 0, 0], z: [1, 0, 0], y: [0, 0, 1] } }[r.name] : undefined;
    if (fr) { v.normalTo(fr.o as never, fr.z as never, fr.y as never); return; }
  }
  store.set({ message: "Normal a: selecione uma face plana ou um plano" });
}

const FEATURE_GROUP: Partial<Record<FeatureType, Command["group"]>> = { sketch: "Esboço", plane: "Referências", axis: "Referências", csys: "Referências" };

function featureCommand(type: FeatureType): Command {
  return {
    id: type === "sketch" ? "sketch.new" : `feature.${type}`,
    label: FEATURE_LABELS[type],
    group: FEATURE_GROUP[type] ?? (SURFACE_TYPES.includes(type) ? "Superfícies" : "Features"),
    icon: FEATURE_ICONS[type],
    repeatable: true,
    run: () => { if (!busy()) store.startFeature(type); },
  };
}

export const COMMANDS: Command[] = [
  // vistas (Ctrl+1…8 como no SolidWorks)
  ...(Object.keys(VIEWS) as ViewName[]).map((n): Command => ({ id: `view.${n}`, label: `Vista ${VIEWS[n].label}`, group: "Vista", keys: [VIEWS[n].key], run: () => viewport?.view(n) })),
  { id: "view.normal", label: "Normal a", group: "Vista", keys: ["Ctrl+8"], icon: "⊥", run: normalTo },
  { id: "view.fit", label: "Ajustar ao ecrã", group: "Vista", keys: ["F"], icon: "⤢", run: () => viewport?.fit() },
  { id: "view.zoomIn", label: "Aproximar", group: "Vista", keys: ["Shift+Z"], run: () => viewport?.zoomAt(1 / 1.25) },
  { id: "view.zoomOut", label: "Afastar", group: "Vista", keys: ["Z"], run: () => viewport?.zoomAt(1.25) },
  { id: "view.previous", label: "Vista anterior", group: "Vista", keys: ["Ctrl+Shift+Z"], icon: "⟲", run: () => viewport?.previousView() },
  { id: "view.orientation", label: "Orientação da vista…", group: "Vista", keys: ["Space"], icon: "⬚", run: () => store.set({ orientationMenu: { at: lastPointer } }) },
  { id: "view.rotLeft", label: "Rodar para a esquerda", group: "Vista", keys: ["ArrowLeft"], run: () => viewport?.rotateBy(-store.state.settings.arrowStep, 0) },
  { id: "view.rotRight", label: "Rodar para a direita", group: "Vista", keys: ["ArrowRight"], run: () => viewport?.rotateBy(store.state.settings.arrowStep, 0) },
  { id: "view.rotUp", label: "Rodar para cima", group: "Vista", keys: ["ArrowUp"], run: () => viewport?.rotateBy(0, -store.state.settings.arrowStep) },
  { id: "view.rotDown", label: "Rodar para baixo", group: "Vista", keys: ["ArrowDown"], run: () => viewport?.rotateBy(0, store.state.settings.arrowStep) },
  { id: "view.rot90Left", label: "Rodar 90° para a esquerda", group: "Vista", keys: ["Shift+ArrowLeft"], run: () => viewport?.rotateBy(-90, 0) },
  { id: "view.rot90Right", label: "Rodar 90° para a direita", group: "Vista", keys: ["Shift+ArrowRight"], run: () => viewport?.rotateBy(90, 0) },
  { id: "view.rot90Up", label: "Rodar 90° para cima", group: "Vista", keys: ["Shift+ArrowUp"], run: () => viewport?.rotateBy(0, -90) },
  { id: "view.rot90Down", label: "Rodar 90° para baixo", group: "Vista", keys: ["Shift+ArrowDown"], run: () => viewport?.rotateBy(0, 90) },
  { id: "view.rollLeft", label: "Rolar para a esquerda", group: "Vista", keys: ["Alt+ArrowLeft"], run: () => viewport?.roll(-store.state.settings.arrowStep) },
  { id: "view.rollRight", label: "Rolar para a direita", group: "Vista", keys: ["Alt+ArrowRight"], run: () => viewport?.roll(store.state.settings.arrowStep) },
  { id: "view.panLeft", label: "Deslocar para a esquerda", group: "Vista", keys: ["Ctrl+ArrowLeft"], run: () => viewport?.panBy(-40, 0) },
  { id: "view.panRight", label: "Deslocar para a direita", group: "Vista", keys: ["Ctrl+ArrowRight"], run: () => viewport?.panBy(40, 0) },
  { id: "view.panUp", label: "Deslocar para cima", group: "Vista", keys: ["Ctrl+ArrowUp"], run: () => viewport?.panBy(0, -40) },
  { id: "view.panDown", label: "Deslocar para baixo", group: "Vista", keys: ["Ctrl+ArrowDown"], run: () => viewport?.panBy(0, 40) },
  { id: "view.styleEdges", label: "Sombreado com arestas", group: "Vista", run: () => setStyle("shadedEdges") },
  { id: "view.styleShaded", label: "Sombreado", group: "Vista", run: () => setStyle("shaded") },
  { id: "view.styleWire", label: "Arestas (fio de arame)", group: "Vista", run: () => setStyle("wireframe") },
  { id: "view.planes", label: "Mostrar/ocultar planos", group: "Vista", run: () => { store.updateSettings({ showPlanes: !store.state.settings.showPlanes }); store.rebuild(0); } },
  // ficheiro e edição
  { id: "file.new", label: "Novo", group: "Ficheiro", keys: ["Ctrl+N"], run: () => { if (!busy() && (!store.state.dirty || confirm("Descartar as alterações por guardar?"))) store.newDoc(); } },
  { id: "file.open", label: "Abrir projeto…", group: "Ficheiro", keys: ["Ctrl+O"], run: () => { if (!busy()) void openProject(); } },
  { id: "file.save", label: "Guardar projeto", group: "Ficheiro", keys: ["Ctrl+S"], run: () => { if (!busy()) saveProject(); } },
  { id: "file.import", label: "Importar STEP…", group: "Ficheiro", run: () => { if (!busy()) void importStep(); } },
  ...EXPORTS.map(([f, l]): Command => ({ id: `export.${f}`, label: `Exportar ${l}`, group: "Exportar", run: () => void exportAs(f) })),
  { id: "edit.undo", label: "Desfazer", group: "Editar", keys: ["Ctrl+Z"], run: () => store.undo() },
  { id: "edit.redo", label: "Refazer", group: "Editar", keys: ["Ctrl+Y"], run: () => store.redo() },
  { id: "edit.delete", label: "Apagar feature selecionada", group: "Editar", keys: ["Delete"], run: () => { const id = store.state.selectedFeature; if (id && !busy()) store.deleteFeature(id); } },
  { id: "edit.rebuild", label: "Reconstruir", group: "Editar", keys: ["Ctrl+B"], icon: "🚦", run: () => store.rebuild(0) },
  { id: "edit.forceRebuild", label: "Forçar reconstrução completa", group: "Editar", keys: ["Ctrl+Q"], run: () => store.rebuild(0, true) },
  { id: "edit.repeat", label: "Repetir último comando", group: "Editar", keys: ["Enter"], run: repeatLast },
  { id: "edit.variables", label: "Variáveis globais e equações", group: "Editar", icon: "𝑥", run: () => { if (!store.state.sketch) store.set({ showVariables: true }); } },
  { id: "ui.shortcutBar", label: "Barra de atalhos", group: "Editar", keys: ["S"], run: () => store.set({ shortcutBar: { at: lastPointer } }) },
  { id: "edit.escape", label: "Cancelar / limpar seleção", group: "Editar", keys: ["Escape"], run: escape },
  // features
  ...(["sketch", "extrude", "revolve", "sweep", "loft", "rib", "hole", "fillet", "chamfer", "shell", "draft", "linearPattern", "circularPattern", "mirror", "plane", "axis", "csys"] as FeatureType[]).map(featureCommand),
  ...SURFACE_TYPES.map(featureCommand),
  // análises (Avaliar)
  { id: "analysis.zebra", label: "Riscas de zebra", group: "Avaliar", icon: "▥", run: () => store.setAnalysis(store.state.analysis?.kind === "zebra" ? null : { kind: "zebra" }) },
  { id: "analysis.curvature", label: "Curvatura", group: "Avaliar", icon: "◍", run: () => void store.setAnalysis(store.state.analysis?.kind === "curvature" ? null : { kind: "curvature", mode: "gauss" }) },
  { id: "analysis.draft", label: "Análise de inclinação", group: "Avaliar", icon: "⏣", run: () => store.setAnalysis(store.state.analysis?.kind === "draft" ? null : { kind: "draft", dir: "Z", angle: 1 }) },
  { id: "analysis.deviation", label: "Análise de desvio (tangência nas arestas)", group: "Avaliar", icon: "∡", run: () => void store.setAnalysis(store.state.analysis?.kind === "deviation" ? null : { kind: "deviation" }) },
  { id: "analysis.off", label: "Desligar análise", group: "Avaliar", run: () => store.setAnalysis(null) },
  { id: "feature.cut", label: "Corte extrudido", group: "Features", icon: "▯", repeatable: true, run: () => { if (!busy()) { store.startFeature("extrude"); store.updateDraft({ op: "cut", end: { type: "throughAll" } } as never); } } },
  ...PLUGINS.flatMap((p) => Object.entries(p.kinds).map(([k, kind]): Command => ({
    id: `plugin.${p.id}.${k}`, label: `${p.name}: ${kind.label}`, group: "Módulos", icon: "⧉", repeatable: true,
    run: () => { if (!busy()) store.startFeature("plugin", { plugin: p.id, kind: k }); },
  }))),
];

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

/** Executa um comando pelo id (e memoriza-o para "repetir", se for de criação). */
export function runCommand(id: string) {
  const c = commandById.get(id);
  if (!c) return;
  store.closeOverlays();
  if (c.repeatable) store.set({ lastCommand: id });
  c.run();
}

function repeatLast() {
  const st = store.state;
  if (st.edit) { store.confirmEdit(); return; } // Enter num painel aberto confirma, como o OK
  if (st.lastCommand) runCommand(st.lastCommand);
}

function escape() {
  const st = store.state;
  if (st.contextMenu || st.shortcutBar || st.orientationMenu || st.contextToolbar) store.closeOverlays();
  else if (st.pickTarget) store.set({ pickTarget: null });
  else if (st.edit) store.cancelEdit();
  else if (st.choosingPlane) store.set({ choosingPlane: false });
  else store.clearSelection();
}

function setStyle(s: "shadedEdges" | "shaded" | "wireframe") {
  store.updateSettings({ displayStyle: s });
  viewport?.setDisplayStyle(s);
}

/** Última posição do rato (para abrir menus junto ao cursor). */
let lastPointer: [number, number] = [innerWidth / 2, innerHeight / 2];
addEventListener("pointermove", (e: PointerEvent) => { lastPointer = [e.clientX, e.clientY]; }, { passive: true });

/** Texto normalizado de uma tecla ("Ctrl+Shift+Z"). Meta (Cmd) conta como Ctrl. */
export function keyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  if (!["Control", "Shift", "Alt", "Meta"].includes(k)) parts.push(k);
  return parts.join("+");
}

const byKey = new Map<string, Command>();
for (const c of COMMANDS) for (const k of c.keys ?? []) byKey.set(k, c);

/** Trata uma tecla fora de campos de texto; devolve true se houver comando. */
export function handleKey(e: KeyboardEvent): boolean {
  const c = byKey.get(keyString(e));
  if (!c) return false;
  e.preventDefault();
  runCommand(c.id);
  return true;
}
