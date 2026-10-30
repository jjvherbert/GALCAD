// Espaços de trabalho ao estilo do Fusion 360: o mesmo modelo, visto e trabalhado por módulo. Cada
// espaço tem a sua barra de comandos (separadores e grupos do CommandManager), a sua árvore à esquerda
// e os seus painéis; mudar de espaço não altera o modelo, só a forma de o trabalhar.
import { PLUGINS } from "../plugins/meta.ts";
import { type SimSection, type Workspace, store } from "./store.ts";
import { DRAWING_TABS } from "./drawing-commands.ts";
import { SIM_MATERIALS } from "../doc/study.ts";

export interface Tab { id: string; label: string; groups: { title: string; ids: string[] }[] }

export interface WorkspaceDef {
  id: Workspace;
  label: string;
  /** Descrição curta no seletor. */
  hint: string;
  icon: string;
  /** Cor de destaque (barra e separador ativo). */
  accent: string;
  docKinds: ("part" | "assembly" | "drawing")[];
}

export const WORKSPACES: WorkspaceDef[] = [
  { id: "design", label: "Design", hint: "Peças, superfícies, montagens, PMI e conhecimento", icon: "◆", accent: "#0a2464", docKinds: ["part", "assembly"] },
  { id: "fem", label: "Simulação FEM", hint: "Estruturas, modal, encurvadura, dinâmica, térmica", icon: "▦", accent: "#018a8a", docKinds: ["part", "assembly"] },
  { id: "cfd", label: "Simulação CFD", hint: "Escoamentos internos e externos (OpenFOAM, SU2)", icon: "≋", accent: "#2563eb", docKinds: ["part"] },
  { id: "drawing", label: "Desenho", hint: "Desenhos 2D com vistas, cotas, GD&T e BOM", icon: "▭", accent: "#5a6673", docKinds: ["drawing"] },
];

const DESIGN_TABS: Tab[] = [
  {
    id: "features", label: "Features",
    groups: [
      { title: "Esboço", ids: ["sketch.new"] },
      { title: "Sólidos", ids: ["feature.extrude", "feature.revolve", "feature.sweep", "feature.loft", "feature.rib", "feature.cut"] },
      { title: "Furos", ids: ["feature.hole"] },
      { title: "Acabamento", ids: ["feature.fillet", "feature.chamfer", "feature.shell", "feature.draft"] },
      { title: "Padrões", ids: ["feature.linearPattern", "feature.circularPattern", "feature.mirror"] },
    ],
  },
  {
    id: "surfaces", label: "Superfícies",
    groups: [
      { title: "Esboço", ids: ["sketch.new"] },
      { title: "Curvas", ids: ["feature.curve"] },
      { title: "Criar", ids: ["feature.surfaceExtrude", "feature.surfaceRevolve", "feature.surfaceSweep", "feature.surfaceLoft", "feature.boundary", "feature.fill", "feature.ruled", "feature.offsetSurface"] },
      { title: "Editar", ids: ["feature.trimSurface", "feature.untrim", "feature.knit", "feature.deleteFace"] },
      { title: "Para sólido", ids: ["feature.thicken", "feature.replaceFace"] },
      { title: "GSD", ids: ["feature.multiSection", "feature.blend", "feature.circleSweep", "feature.extrapolate", "feature.heal"] },
      { title: "Forma livre", ids: ["feature.freeform"] },
      { title: "Análise", ids: ["analysis.zebra", "analysis.curvature", "analysis.draft", "analysis.deviation"] },
      { title: "Classe A", ids: ["analysis.continuity", "analysis.highlight", "analysis.combs"] },
    ],
  },
  { id: "sketch", label: "Esboço", groups: [{ title: "Esboço", ids: ["sketch.new"] }] },
  { id: "refs", label: "Referências", groups: [{ title: "Geometria de referência", ids: ["feature.plane", "feature.axis", "feature.csys"] }] },
  { id: "evaluate", label: "Avaliar", groups: [{ title: "Avaliar", ids: ["edit.variables", "edit.rebuild", "edit.forceRebuild"] }, { title: "Análise de superfícies", ids: ["analysis.zebra", "analysis.curvature", "analysis.draft", "analysis.deviation", "analysis.continuity", "analysis.highlight", "analysis.combs"] }] },
  { id: "knowledge", label: "Conhecimento", groups: [{ title: "Knowledgeware", ids: ["kw.panel", "edit.variables"] }, { title: "Publicação", ids: ["feature.external"] }] },
  { id: "pmi", label: "PMI", groups: [{ title: "PMI 3D e atributos", ids: ["pmi.panel"] }, { title: "Exportar", ids: ["export.step242"] }] },
  { id: "automation", label: "Automação", groups: [{ title: "Scripts", ids: ["script.panel"] }, { title: "Análise integrada", ids: ["galkeel.panel", "calc.panel"] }] },
  { id: "modules", label: "Módulos", groups: [{ title: "Módulos", ids: PLUGINS.flatMap((p) => Object.keys(p.kinds).map((k) => `plugin.${p.id}.${k}`)) }] },
];

const ASM_TABS: Tab[] = [
  { id: "assembly", label: "Montagem", groups: [
    { title: "Mates", ids: ["asm.mate.coincident", "asm.mate.concentric", "asm.mate.parallel", "asm.mate.perpendicular", "asm.mate.distance", "asm.mate.angle", "asm.mate.tangent", "asm.mate.lock"] },
    { title: "Avaliar", ids: ["asm.interference"] },
    { title: "BOM", ids: ["asm.bom"] },
  ] },
  { id: "evaluate", label: "Avaliar", groups: [{ title: "Avaliar", ids: ["edit.rebuild", "edit.forceRebuild", "asm.interference"] }] },
];

/** Barra do FEM ao estilo do Abaqus/CAE: módulos por ordem de trabalho (Estudo → Propriedades → Interações → Cargas → Malha → Resolver → Resultados). */
const FEM_TABS: Tab[] = [
  { id: "study", label: "Estudo", groups: [
    { title: "Novo estudo", ids: ["sim.new.static", "sim.new.modal", "sim.new.buckling", "sim.new.dynamic", "sim.new.thermal"] },
    { title: "Estudo", ids: ["sim.section.study", "sim.section.run"] },
  ] },
  { id: "property", label: "Propriedades", groups: [
    { title: "Material", ids: ["sim.section.material"] },
    { title: "Biblioteca", ids: SIM_MATERIALS.map((_, i) => `sim.material.${i}`) },
  ] },
  { id: "loads", label: "Cargas e apoios", groups: [
    { title: "Apoios", ids: ["sim.add.fixed", "sim.add.displacement", "sim.add.symmetry"] },
    { title: "Cargas", ids: ["sim.add.force", "sim.add.pointForce", "sim.add.pressure", "sim.add.gravity"] },
    { title: "Térmicas", ids: ["sim.add.temperature", "sim.add.convection", "sim.add.heatFlux"] },
    { title: "Interações", ids: ["sim.section.contact"] },
    { title: "Lista", ids: ["sim.section.conditions"] },
  ] },
  { id: "mesh", label: "Malha", groups: [
    { title: "Elementos", ids: ["sim.mesh.tet", "sim.mesh.hex", "sim.mesh.order"] },
    { title: "Tamanho", ids: ["sim.mesh.finer", "sim.mesh.coarser"] },
    { title: "Controlos", ids: ["sim.section.mesh"] },
    { title: "Verificar", ids: ["sim.mesh.preview"] },
  ] },
  { id: "solve", label: "Resolver", groups: [
    { title: "Sondas", ids: ["sim.add.probe", "sim.section.probes"] },
    { title: "Modelo", ids: ["sim.section.check"] },
    { title: "Solver", ids: ["sim.section.run"] },
    { title: "Calcular", ids: ["sim.mesh.preview", "sim.run"] },
  ] },
  { id: "results", label: "Resultados", groups: [{ title: "Resultados", ids: ["sim.section.results", "sim.toggleResult"] }, { title: "Recalcular", ids: ["sim.run"] }] },
];

const CFD_TABS: Tab[] = [
  { id: "study", label: "Estudo", groups: [{ title: "Novo estudo", ids: ["sim.new.cfdInternal", "sim.new.cfdExternal"] }, { title: "Estudo", ids: ["sim.section.study"] }] },
  { id: "loads", label: "Condições", groups: [{ title: "Fluido e fronteiras", ids: ["sim.section.conditions"] }] },
  { id: "mesh", label: "Malha", groups: [{ title: "Malha", ids: ["sim.section.mesh"] }] },
  { id: "solve", label: "Resolver", groups: [{ title: "Modelo", ids: ["sim.section.check"] }, { title: "Resolver", ids: ["sim.section.run", "sim.run"] }] },
  { id: "results", label: "Resultados", groups: [{ title: "Resultados", ids: ["sim.section.results", "sim.toggleResult"] }] },
];

/** Nos espaços de simulação, cada separador abre a secção do modelo correspondente (como os módulos do Abaqus/CAE). */
export const TAB_SECTION: Record<string, SimSection> = { study: "study", property: "material", loads: "conditions", mesh: "mesh", solve: "run", results: "results" };

/** Separadores do espaço de trabalho ativo (o Design muda com o tipo de documento). */
export function workspaceTabs(ws: Workspace, kind: "part" | "assembly" | "drawing"): Tab[] {
  if (ws === "drawing" || kind === "drawing") return DRAWING_TABS as Tab[];
  if (ws === "fem") return FEM_TABS;
  if (ws === "cfd") return CFD_TABS;
  return kind === "assembly" ? ASM_TABS : DESIGN_TABS;
}

export const workspaceDef = (ws: Workspace) => WORKSPACES.find((w) => w.id === ws)!;

/**
 * Muda de espaço de trabalho. O Desenho abre (ou cria) um desenho; a partir de um desenho, os outros
 * voltam à primeira peça. A CFD só existe nas peças.
 */
export function setWorkspace(ws: Workspace) {
  const st = store.state;
  if (st.edit || st.sketch) { store.set({ error: "Termine primeiro a feature ou o esboço em edição" }); return; }
  if (ws === "drawing") {
    if (st.active.kind !== "drawing") {
      const d = st.project.drawings[0];
      if (d) store.setActive({ kind: "drawing", id: d.id }); else store.addDocument("drawing");
    }
    return;
  }
  if (st.active.kind === "drawing" || (ws === "cfd" && st.active.kind === "assembly")) store.setActive({ kind: "part", id: st.project.parts[0].id });
  const studies = (store.activeAssembly()?.studies ?? store.state.doc.studies ?? []).filter((x) => (ws === "cfd" ? x.physics === "cfd" : x.physics === "fem"));
  const keep = studies.some((x) => x.id === st.simStudy);
  store.set({
    workspace: ws, sidePanel: null, edit: null, mateEdit: null, componentEdit: null, pickTarget: null,
    ...(ws === "fem" || ws === "cfd" ? { simStudy: keep ? st.simStudy : studies[0]?.id ?? null, simSection: keep ? st.simSection : ws === "fem" ? "conditions" : "study" } : {}),
  });
}

/** Abre uma secção do modelo de simulação (árvore → painel). */
export function openSimSection(section: SimSection) {
  store.set({ simSection: section, pickTarget: null });
}
