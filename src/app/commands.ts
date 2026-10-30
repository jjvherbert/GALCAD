// Registo central de comandos e atalhos de teclado (por defeito, os do SolidWorks).
// Usado pelo teclado, pela barra de atalhos (S), pelos gestos e pelos menus.
import type { FeatureType, PlaneRef, Vec3 } from "../doc/types.ts";
import { FEATURE_ICONS, FEATURE_LABELS, SURFACE_TYPES } from "../doc/features.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { store } from "./store.ts";
import type { Viewport, ViewName } from "./viewport.ts";
import { VIEWS } from "./viewport.ts";
import { EXPORTS, exportAs, exportDrawing, importStep, openProject, saveProject } from "./fileio.ts";
import { autoBalloons, importModelDims, importPmi } from "../drawing/edit.ts";
import { WORKSPACES, openSimSection, setWorkspace } from "./workspaces.ts";
import { addCondition, addProbe, addStudy, patchMesh, runActiveStudy, setStudyMaterial } from "./sim-actions.ts";
import { SIM_MATERIALS } from "../doc/study.ts";

/** Ações do desenho sobre a vista selecionada (ou todas). */
function drawingAction(what: "modelDims" | "balloons" | "pmi") {
  const d = store.activeDrawing();
  if (!d) return;
  if (what === "pmi") {
    const sel = store.state.drawingSel;
    const r = importPmi(d, store.state.drawingResult, sel?.kind === "view" ? sel.id : undefined);
    store.commitDrawing(r.doc, "Importar PMI");
    store.set({ message: `${r.count} item(ns) PMI importado(s) do modelo` });
    return;
  }
  const sel = store.state.drawingSel;
  const ids = sel?.kind === "view" ? [sel.id] : d.views.map((v) => v.id);
  let doc = d, n = 0;
  for (const id of ids) {
    const r = what === "modelDims" ? importModelDims(doc, store.state.drawingResult, id) : autoBalloons(doc, store.state.project, store.state.drawingResult, id);
    doc = r.doc; n += r.count;
  }
  store.commitDrawing(doc, what === "modelDims" ? "Importar cotas" : "Balões");
  store.set({ message: what === "modelDims" ? `${n} cota(s) importada(s) do modelo` : `${n} balão(ões)` });
}

export interface Command {
  id: string;
  label: string;
  group: "Vista" | "Ficheiro" | "Editar" | "Features" | "Superfícies" | "Esboço" | "Referências" | "Avaliar" | "Conhecimento" | "PMI" | "Simulação" | "Automação" | "Módulos" | "Exportar" | "Montagem" | "Desenho";
  /** Atalhos, no formato "Ctrl+Shift+Z", "F", "Space", "ArrowLeft". */
  keys?: string[];
  icon?: string;
  /** Rótulo curto na barra (o `label` completo fica na dica e na paleta de comandos). */
  short?: string;
  run: () => void;
  /** Comando de criação (repetível com Enter). */
  repeatable?: boolean;
}

let viewport: Viewport | null = null;
export const setCommandViewport = (v: Viewport) => { viewport = v; };
/** Visualizador ativo (para painéis que mexem na câmara, como as vistas de modelo PMI). */
export const commandViewport = () => viewport;

const busy = () => !!store.state.edit || !!store.state.sketch;

const STD_FRAMES = { XY: { o: [0, 0, 0], z: [0, 0, 1], y: [0, 1, 0] }, XZ: { o: [0, 0, 0], z: [0, -1, 0], y: [0, 0, 1] }, YZ: { o: [0, 0, 0], z: [1, 0, 0], y: [0, 0, 1] } } as const;

/** Origem, normal e "para cima" de um plano (padrão, de referência ou face plana), para olhar normal a ele. */
export function planeFrame(r: PlaneRef): { o: Vec3; z: Vec3; y?: Vec3 } | null {
  if (r.kind === "std") return STD_FRAMES[r.name] as never;
  if (r.kind === "datum") return (store.state.result?.planes[r.feature] as never) ?? null;
  if (r.kind === "face") return r.ref.hint?.n && r.ref.hint.c ? { o: r.ref.hint.c as Vec3, z: r.ref.hint.n as Vec3 } : null;
  return null;
}

/** "Normal a": face plana ou plano selecionado; sem seleção, a vista padrão mais próxima. */
function normalTo() {
  const v = viewport;
  if (!v) return;
  const sel = store.state.selection[0];
  if (sel?.kind === "face" && sel.hint.n) { v.normalTo(sel.hint.c, sel.hint.n); return; }
  if (sel?.kind === "plane") {
    const fr = planeFrame(sel.ref);
    if (fr) { v.normalTo(fr.o, fr.z, fr.y); return; }
  }
  store.set({ message: "Normal a: selecione uma face plana ou um plano" });
}

const FEATURE_GROUP: Partial<Record<FeatureType, Command["group"]>> = { sketch: "Esboço", plane: "Referências", axis: "Referências", csys: "Referências" };

const MATE_NAMES = { coincident: "coincidente", concentric: "concêntrico", parallel: "paralelo", perpendicular: "perpendicular", distance: "distância", angle: "ângulo", tangent: "tangente", lock: "fixar" } as const;
const MATE_ICON = { coincident: "⊼", concentric: "◎", parallel: "∥", perpendicular: "⟂", distance: "↔", angle: "∠", tangent: "◠", lock: "🔒" } as const;

function featureCommand(type: FeatureType): Command {
  return {
    id: type === "sketch" ? "sketch.new" : `feature.${type}`,
    label: FEATURE_LABELS[type],
    group: FEATURE_GROUP[type] ?? (SURFACE_TYPES.includes(type) ? "Superfícies" : "Features"),
    icon: FEATURE_ICONS[type],
    repeatable: true,
    run: () => { if (busy()) return; if (store.state.active.kind !== "part") { store.set({ message: "Abra uma peça para usar features" }); return; } store.startFeature(type); },
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
  featureCommand("external"),
  // análises (Avaliar)
  { id: "analysis.zebra", label: "Riscas de zebra", group: "Avaliar", icon: "▥", run: () => store.setAnalysis(store.state.analysis?.kind === "zebra" ? null : { kind: "zebra" }) },
  { id: "analysis.curvature", label: "Curvatura", group: "Avaliar", icon: "◍", run: () => void store.setAnalysis(store.state.analysis?.kind === "curvature" ? null : { kind: "curvature", mode: "gauss" }) },
  { id: "analysis.draft", label: "Análise de inclinação", group: "Avaliar", icon: "⏣", run: () => store.setAnalysis(store.state.analysis?.kind === "draft" ? null : { kind: "draft", dir: "Z", angle: 1 }) },
  { id: "analysis.deviation", label: "Análise de desvio (tangência nas arestas)", group: "Avaliar", icon: "∡", run: () => void store.setAnalysis(store.state.analysis?.kind === "deviation" ? null : { kind: "deviation" }) },
  { id: "analysis.continuity", label: "Continuidade G0–G3 (classe A)", group: "Avaliar", icon: "≋", run: () => void store.setAnalysis(store.state.analysis?.kind === "continuity" ? null : { kind: "continuity" }) },
  { id: "analysis.highlight", label: "Linhas de realce (highlight)", group: "Avaliar", icon: "☰", run: () => void store.setAnalysis(store.state.analysis?.kind === "highlight" ? null : { kind: "highlight", axis: "X", spacing: 10 }) },
  {
    id: "analysis.combs", label: "Pentes de curvatura (porcupine)", group: "Avaliar", icon: "⫶",
    run: () => {
      if (store.state.analysis?.kind === "combs") return void store.setAnalysis(null);
      const edges = store.state.selection.filter((s) => s.kind === "edge").map((s) => s.name);
      void store.setAnalysis({ kind: "combs", edges: edges.length ? edges : undefined, gain: 1 });
    },
  },
  // montagem
  ...(["coincident", "concentric", "parallel", "perpendicular", "distance", "angle", "tangent", "lock"] as const).map((k): Command => ({
    id: `asm.mate.${k}`, label: `Mate: ${MATE_NAMES[k]}`, group: "Montagem", icon: MATE_ICON[k], repeatable: true,
    run: () => { if (store.state.active.kind === "assembly" && !store.state.mateEdit) store.startMate(k); },
  })),
  { id: "galkeel.panel", label: "Galkeel: escantilhonamento de painéis (ISO 12215-5 pela galkeel-calculadora) e relatório", group: "Automação", icon: "⚓", run: () => { if (store.state.active.kind === "part") store.set({ sidePanel: store.state.sidePanel === "galkeel" ? null : "galkeel", edit: null }); } },
  { id: "calc.panel", label: "Cálculos: atmosfera, asa finita, perfis NACA e XFOIL, colunas, placas", group: "Automação", icon: "∫", run: () => { if (store.state.active.kind === "part") store.set({ sidePanel: store.state.sidePanel === "calc" ? null : "calc", edit: null }); } },
  { id: "script.panel", label: "Scripts: automação, estudos paramétricos e copiloto", group: "Automação", icon: "{}", run: () => { if (store.state.active.kind === "part") store.set({ sidePanel: store.state.sidePanel === "script" ? null : "script", edit: null }); } },
  { id: "pmi.panel", label: "PMI: cotas, tolerâncias geométricas, referências, vistas de modelo e atributos", group: "PMI", icon: "⌖", run: () => { if (store.state.active.kind === "part") store.set({ sidePanel: store.state.sidePanel === "pmi" ? null : "pmi", edit: null }); } },
  { id: "sim.panel", label: "Simulação: estudos FEM/CFD, malha e solvers abertos", group: "Simulação", icon: "≋", run: () => setWorkspace("fem") },
  // espaços de trabalho (Fusion)
  ...WORKSPACES.map((w): Command => ({ id: `ws.${w.id}`, label: `Espaço de trabalho: ${w.label}`, group: "Vista", icon: w.icon, keys: [`Ctrl+Alt+${WORKSPACES.indexOf(w) + 1}`], run: () => setWorkspace(w.id) })),
  // simulação: novos estudos, secções do modelo, malha, cálculo e resultados
  ...([["static", "Estático", "▤"], ["modal", "Modal", "∿"], ["buckling", "Encurvadura", "⌇"], ["dynamic", "Dinâmico", "⏱"], ["thermal", "Térmico", "♨"]] as const).map(([analysis, label, icon]): Command => ({
    id: `sim.new.${analysis}`, label: `Novo estudo ${label.toLowerCase()}`, short: label, group: "Simulação", icon,
    run: () => { if (store.state.workspace !== "fem") setWorkspace("fem"); addStudy("fem", { analysis, ...(analysis === "dynamic" ? { dynamic: { scheme: "implicit", duration: 0.01, load: "step" } } : {}) } as never); },
  })),
  { id: "sim.new.cfdInternal", label: "Novo estudo CFD interno (conduta)", short: "Interno", group: "Simulação", icon: "⇉", run: () => { if (store.state.workspace !== "cfd") setWorkspace("cfd"); addStudy("cfd", { regime: "internal" } as never); } },
  { id: "sim.new.cfdExternal", label: "Novo estudo CFD externo (corpo)", short: "Externo", group: "Simulação", icon: "➶", run: () => { if (store.state.workspace !== "cfd") setWorkspace("cfd"); addStudy("cfd", { regime: "external" } as never); } },
  ...([["study", "Estudo: análise e solver", "⚙"], ["material", "Material", "◧"], ["conditions", "Cargas e apoios", "⤓"], ["contact", "Contacto entre corpos", "⧉"], ["mesh", "Malha: elementos, seeds e controlos", "▦"], ["probes", "Sondas", "⌖"], ["run", "Resolver: solver e convergência", "▶"], ["results", "Resultados", "◑"]] as const).map(([section, label, icon]): Command => ({
    id: `sim.section.${section}`, label, short: label.split(":")[0].replace(" entre corpos", ""), group: "Simulação", icon, run: () => openSimSection(section),
  })),
  // cargas, apoios e sondas a partir da barra: abre a secção com a seleção de faces ativa
  ...([["fixed", "Encastramento (apoio fixo nas faces)", "Encastrar", "⊥"], ["displacement", "Deslocamento imposto nas faces", "Deslocam.", "⇥"], ["force", "Força total distribuída nas faces", "Força", "↓"], ["pressure", "Pressão normal nas faces", "Pressão", "⇊"], ["gravity", "Gravidade (peso próprio)", "Gravidade", "g"], ["temperature", "Temperatura imposta nas faces", "Temperatura", "🌡"], ["convection", "Convecção nas faces (h, T do fluido)", "Convecção", "≈"], ["heatFlux", "Fluxo de calor nas faces", "Fluxo", "⇶"]] as const).map(([kind, label, short, icon]): Command => ({
    id: `sim.add.${kind}`, label, short, group: "Simulação", icon, run: () => { if (store.state.workspace !== "fem") setWorkspace("fem"); addCondition(kind); },
  })),
  { id: "sim.add.probe", label: "Sonda (grandeza média em faces ou num ponto)", short: "Sonda", group: "Simulação", icon: "⌖", run: () => { if (store.state.workspace !== "fem") setWorkspace("fem"); addProbe(); } },
  ...SIM_MATERIALS.map((m, i): Command => ({
    id: `sim.material.${i}`, label: `Material: ${m.name}`, short: m.name.replace(/^Alumínio EN AW-/, "Al ").replace(/^Aço inox AISI /, "Inox ").replace(/^Aço /, "Aço ").replace(/ \(.*$/, ""), group: "Simulação", icon: "◧", run: () => setStudyMaterial(m.name),
  })),
  { id: "sim.mesh.tet", label: "Malha de tetraedros (livre, qualquer geometria)", short: "Tetraedros", group: "Simulação", icon: "△", run: () => patchMesh(() => ({ element: "tet" })) },
  { id: "sim.mesh.hex", label: "Malha de hexaedros (mapeada onde a geometria permite)", short: "Hexaedros", group: "Simulação", icon: "⬛", run: () => patchMesh(() => ({ element: "hex" })) },
  { id: "sim.mesh.order", label: "Alternar elementos lineares / quadráticos", short: "Ordem 1/2", group: "Simulação", icon: "²", run: () => patchMesh((m) => ({ order: m.order === 2 ? 1 : 2 })) },
  { id: "sim.mesh.finer", label: "Refinar a malha (tamanho × 0,7)", short: "Refinar", group: "Simulação", icon: "⊞", run: () => patchMesh((m) => ({ size: typeof m.size === "number" ? Number((m.size * 0.7).toPrecision(3)) : m.size })) },
  { id: "sim.mesh.coarser", label: "Engrossar a malha (tamanho × 1,4)", short: "Engrossar", group: "Simulação", icon: "⊟", run: () => patchMesh((m) => ({ size: typeof m.size === "number" ? Number((m.size * 1.4).toPrecision(3)) : m.size })) },
  { id: "sim.mesh.preview", label: "Pré-visualizar a malha e a qualidade dos elementos", short: "Gerar malha", group: "Simulação", icon: "⬚", run: () => void runActiveStudy(true) },
  { id: "sim.run", label: "Calcular no agente local", short: "Calcular", group: "Simulação", icon: "▶", keys: ["F5"], run: () => void runActiveStudy(false) },
  { id: "sim.toggleResult", label: "Mostrar/esconder o resultado no 3D", short: "Mostrar/esconder", group: "Simulação", icon: "◐", run: () => store.set({ simHidden: !store.state.simHidden }) },
  { id: "kw.panel", label: "Conhecimento: regras, verificações, configurações e templates", group: "Conhecimento", icon: "⚙", run: () => { if (store.state.active.kind === "part") store.set({ sidePanel: store.state.sidePanel === "knowledge" ? null : "knowledge" }); } },
  { id: "asm.bom", label: "Lista de materiais (BOM) e assistente", group: "Montagem", icon: "☰", run: () => { if (store.state.active.kind === "assembly") store.set({ sidePanel: store.state.sidePanel === "bom" ? null : "bom", mateEdit: null, componentEdit: null }); } },
  { id: "asm.interference", label: "Deteção de interferências", group: "Montagem", icon: "⧯", run: () => { if (store.state.active.kind === "assembly") void store.checkInterference(); } },
  // desenho
  ...([
    ["dr.view.projected", "Vista projetada", "⊞", "projected"], ["dr.view.section", "Vista de corte", "⊟", "section"], ["dr.view.detail", "Vista de pormenor", "⊙", "detail"], ["dr.view.aux", "Vista auxiliar", "⟋", "auxiliary"],
    ["dr.dim", "Cota inteligente", "↔", "dim"], ["dr.note", "Nota", "A", "note"], ["dr.gdt", "Tolerância geométrica", "⌖", "gdt"], ["dr.datum", "Referência (datum)", "▣", "datum"],
    ["dr.surface", "Estado de superfície", "√", "surface"], ["dr.weld", "Símbolo de soldadura", "⌳", "weld"], ["dr.balloon", "Balão", "①", "balloon"], ["dr.bom", "Tabela de BOM", "☰", "bom"],
  ] as const).map(([id, label, icon, kind]): Command => ({
    id, label, group: "Desenho", icon, repeatable: true,
    run: () => {
      if (store.state.active.kind !== "drawing") return;
      const sel = store.state.drawingSel;
      const parent = sel?.kind === "view" && (kind === "projected" || kind === "section" || kind === "detail") ? sel.id : undefined;
      store.set({ drawingTool: { kind, ...(parent ? { parent, points: [] } : {}) } as never });
    },
  })),
  { id: "dr.modelDims", label: "Importar cotas do modelo", group: "Desenho", icon: "⇲", run: () => drawingAction("modelDims") },
  { id: "dr.pmi", label: "Importar PMI do modelo (cotas com tolerância, GD&T, referências, rugosidade, notas)", group: "Desenho", icon: "⌖", run: () => drawingAction("pmi") },
  { id: "dr.autoBalloon", label: "Balões automáticos", group: "Desenho", icon: "⑳", run: () => drawingAction("balloons") },
  ...(["pdf", "dxf", "svg"] as const).map((f): Command => ({ id: `dr.export.${f}`, label: `Exportar ${f.toUpperCase()}`, group: "Desenho", icon: "⇪", run: () => { if (store.state.active.kind === "drawing") exportDrawing(f); } })),
  { id: "analysis.off", label: "Desligar análise", group: "Avaliar", run: () => store.setAnalysis(null) },
  { id: "feature.cut", label: "Corte extrudido", group: "Features", icon: "▯", repeatable: true, run: () => { if (!busy() && store.state.active.kind === "part") { store.startFeature("extrude"); store.updateDraft({ op: "cut", end: { type: "throughAll" } } as never); } } },
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
