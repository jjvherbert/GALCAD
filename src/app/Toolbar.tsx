// Barra de comandos ao estilo do CommandManager do SolidWorks: menu Ficheiro, ações rápidas e separadores.
import { useState } from "preact/hooks";
import { FILE_EXTENSION } from "../doc/io.ts";
import { commandById, runCommand } from "./commands.ts";
import { EXPORTS } from "./fileio.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { store, useStore } from "./store.ts";
import { DRAWING_TABS } from "./drawing-commands.ts";

type Tab = "features" | "surfaces" | "sketch" | "refs" | "evaluate" | "modules" | "assembly" | "drawing" | "annotate";

const TABS: { id: Tab; label: string; groups: { title: string; ids: string[] }[] }[] = [
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
      { title: "Análise", ids: ["analysis.zebra", "analysis.curvature", "analysis.draft", "analysis.deviation"] },
      { title: "Classe A", ids: ["analysis.continuity", "analysis.highlight", "analysis.combs"] },
    ],
  },
  { id: "sketch", label: "Esboço", groups: [{ title: "Esboço", ids: ["sketch.new"] }] },
  { id: "refs", label: "Referências", groups: [{ title: "Geometria de referência", ids: ["feature.plane", "feature.axis", "feature.csys"] }] },
  { id: "evaluate", label: "Avaliar", groups: [{ title: "Avaliar", ids: ["edit.variables", "edit.rebuild", "edit.forceRebuild"] }, { title: "Análise de superfícies", ids: ["analysis.zebra", "analysis.curvature", "analysis.draft", "analysis.deviation", "analysis.continuity", "analysis.highlight", "analysis.combs"] }] },
  { id: "modules", label: "Módulos", groups: [{ title: "Módulos", ids: PLUGINS.flatMap((p) => Object.keys(p.kinds).map((k) => `plugin.${p.id}.${k}`)) }] },
];

const ASM_TABS: typeof TABS = [
  { id: "assembly", label: "Montagem", groups: [
    { title: "Mates", ids: ["asm.mate.coincident", "asm.mate.concentric", "asm.mate.parallel", "asm.mate.perpendicular", "asm.mate.distance", "asm.mate.angle", "asm.mate.tangent", "asm.mate.lock"] },
    { title: "Avaliar", ids: ["asm.interference"] },
    { title: "BOM", ids: ["asm.bom"] },
  ] },
  { id: "evaluate", label: "Avaliar", groups: [{ title: "Avaliar", ids: ["edit.rebuild", "edit.forceRebuild", "asm.interference"] }] },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (label: string) => cap(label.replace(/^Mate: /, "").replace(/^Vista de /, "").replace(/^Vista (projetada|auxiliar)$/, "$1")).replace("Deteção de interferências", "Interferências").replace("Lista de materiais (BOM) e assistente", "BOM").replace(/^Vista /, "").replace(/^Superfície /, "Sup. ").replace("Análise de inclinação", "Inclinação").replace(/^Análise de desvio.*/, "Desvio").replace(/^Continuidade.*/, "Continuidade").replace(/^Linhas de realce.*/, "Realce").replace(/^Pentes de curvatura.*/, "Pentes").replace("Desaparar superfície", "Desaparar").replace(/^Náutica: /, "").replace("Variáveis globais e equações", "Variáveis").replace("Forçar reconstrução completa", "Forçar reconstr.");

export function Toolbar() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>("features");
  const [menu, setMenu] = useState<"file" | null>(null);
  const busy = !!st.edit || !!st.sketch || !!st.mateEdit;

  const cmdButton = (id: string) => {
    const c = commandById.get(id);
    if (!c) return null;
    const key = c.keys?.[0];
    return (
      <button key={id} class="cmd" title={`${c.label}${key ? ` (${key})` : ""}`} disabled={busy && c.group !== "Editar" && c.group !== "Avaliar"} onClick={() => runCommand(id)}>
        <span class="ic">{c.icon ?? "•"}</span><span class="lb">{short(c.label)}</span>
      </button>
    );
  };

  const tabs = st.active.kind === "assembly" ? ASM_TABS : st.active.kind === "drawing" ? DRAWING_TABS : TABS;
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <header class="toolbar" onClick={() => menu && setMenu(null)}>
      <div class="tb-row">
        <div class="brand">CAD<span>protótipo</span></div>
        <div class="dropdown">
          <button onClick={(e) => { e.stopPropagation(); setMenu(menu === "file" ? null : "file"); }} disabled={busy}>Ficheiro ▾</button>
          {menu === "file" && (
            <div class="menu" role="menu">
              <button role="menuitem" onClick={() => runCommand("file.new")}>Novo <kbd>Ctrl+N</kbd></button>
              <button role="menuitem" onClick={() => runCommand("file.open")}>Abrir projeto ({FILE_EXTENSION})… <kbd>Ctrl+O</kbd></button>
              <button role="menuitem" onClick={() => runCommand("file.save")}>Guardar projeto <kbd>Ctrl+S</kbd></button>
              <button role="menuitem" onClick={() => runCommand("file.import")}>Importar STEP…</button>
              <hr />
              {EXPORTS.map(([f, l]) => <button role="menuitem" key={f} disabled={!st.result?.mesh} onClick={() => runCommand(`export.${f}`)}>Exportar {l}</button>)}
            </div>
          )}
        </div>
        <button title={`Desfazer ${store.history.undoLabel ?? ""} (Ctrl+Z)`} aria-label="Desfazer" disabled={busy || !store.history.canUndo} onClick={() => runCommand("edit.undo")}>↶</button>
        <button title={`Refazer ${store.history.redoLabel ?? ""} (Ctrl+Y)`} aria-label="Refazer" disabled={busy || !store.history.canRedo} onClick={() => runCommand("edit.redo")}>↷</button>
        <button title="Reconstruir (Ctrl+B)" aria-label="Reconstruir" onClick={() => runCommand("edit.rebuild")}>🚦</button>
        <button title="Variáveis globais e equações" disabled={!!st.sketch} onClick={() => runCommand("edit.variables")}>𝑥 = Variáveis</button>
        <button title="Barra de atalhos (S)" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); store.set({ shortcutBar: { at: [r.left, r.bottom + 4] } }); }}>🔍 Comandos <kbd>S</kbd></button>
        <nav class="tabs" role="tablist" aria-label="CommandManager">
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={current.id === t.id} class={current.id === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </nav>
      </div>
      <div class="tb-row commands" role="tabpanel">
        {current.groups.map((g) => (
          <div class="group" key={g.title} aria-label={g.title}>{g.ids.map(cmdButton)}</div>
        ))}
      </div>
    </header>
  );
}
