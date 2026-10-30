// Barra de comandos: marca, seletor do espaço de trabalho (como no Fusion), menu Ficheiro, ações rápidas
// e os separadores do CommandManager (como no SolidWorks) do espaço de trabalho ativo.
import { useRef, useState } from "preact/hooks";
import { FILE_EXTENSION } from "../doc/io.ts";
import { commandById, runCommand } from "./commands.ts";
import { FeatureTip, HELP } from "./featurehelp.tsx";
import { EXPORTS } from "./fileio.ts";
import { store, useStore } from "./store.ts";
import { TAB_SECTION, WORKSPACES, openSimSection, setWorkspace, workspaceDef, workspaceTabs } from "./workspaces.ts";
import logo from "../../desktop/brand/splash-logo.png";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (label: string) => cap(label.replace(/^Mate: /, "").replace(/^Vista de /, "").replace(/^Vista (projetada|auxiliar)$/, "$1")).replace("Deteção de interferências", "Interferências").replace("Lista de materiais (BOM) e assistente", "BOM").replace(/^Vista /, "").replace(/^Superfície /, "Sup. ").replace("Análise de inclinação", "Inclinação").replace(/^Análise de desvio.*/, "Desvio").replace(/^Continuidade.*/, "Continuidade").replace(/^Linhas de realce.*/, "Realce").replace(/^Pentes de curvatura.*/, "Pentes").replace(/^Conhecimento:.*/, "Regras e configs.").replace(/^Simulação:.*/, "Estudos").replace(/^PMI:.*/, "Anotações PMI").replace(/^Exportar STEP AP242.*/, "STEP AP242").replace(/^Scripts:.*/, "Scripts").replace(/^Galkeel:.*/, "Painéis Galkeel").replace(/^Cálculos:.*/, "Cálculos e perfis").replace("Desaparar superfície", "Desaparar").replace(/^Náutica: /, "").replace("Variáveis globais e equações", "Variáveis").replace("Forçar reconstrução completa", "Forçar reconstr.");

export function Toolbar() {
  const st = useStore();
  const [tabs0, setTab] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<"file" | "ws" | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<number>(0);
  const showTip = (id: string, el: HTMLElement) => {
    clearTimeout(tipTimer.current);
    if (!HELP[id]) return;
    tipTimer.current = window.setTimeout(() => { const r = el.getBoundingClientRect(); setTip({ id, x: r.left, y: r.bottom + 6 }); }, 550);
  };
  const hideTip = () => { clearTimeout(tipTimer.current); setTip(null); };
  const busy = !!st.edit || !!st.sketch || !!st.mateEdit;

  const cmdButton = (id: string) => {
    const c = commandById.get(id);
    if (!c) return null;
    const key = c.keys?.[0];
    return (
      <button key={id} class="cmd" title={HELP[id] ? undefined : `${c.label}${key ? ` (${key})` : ""}`} aria-label={`${c.label}${key ? ` (${key})` : ""}`} disabled={busy && c.group !== "Editar" && c.group !== "Avaliar"} onMouseEnter={(e) => showTip(id, e.currentTarget)} onMouseLeave={hideTip} onFocus={(e) => showTip(id, e.currentTarget)} onBlur={hideTip} onClick={() => { hideTip(); runCommand(id); }}>
        <span class="ic">{c.icon ?? "•"}</span><span class="lb">{c.short ?? short(c.label)}</span>
      </button>
    );
  };

  const ws = workspaceDef(st.workspace);
  const tabs = workspaceTabs(st.workspace, st.active.kind);
  // separador escolhido por espaço de trabalho (cada espaço lembra o seu)
  const key = `${st.workspace}:${st.active.kind}`;
  const current = tabs.find((t) => t.id === tabs0[key]) ?? (st.workspace === "fem" ? tabs.find((t) => t.id === "loads") : undefined) ?? tabs[0];
  return (
    <header class="toolbar" style={{ "--ws-accent": ws.accent }} onClick={() => menu && setMenu(null)}>
      <div class="tb-row">
        <div class="brand" title="GALCAD — Galkeel"><img src={logo} alt="" /><b>GALCAD</b></div>
        <div class="dropdown ws-switch">
          <button class="ws-button" aria-label="Espaço de trabalho" aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setMenu(menu === "ws" ? null : "ws"); }} disabled={busy}>
            <span class="ws-ic">{ws.icon}</span><span class="ws-lb">{ws.label.toUpperCase()}</span><span class="ws-car">▾</span>
          </button>
          {menu === "ws" && (
            <div class="menu ws-menu" role="menu">
              {WORKSPACES.map((w, k) => (
                <button key={w.id} role="menuitem" class={w.id === st.workspace ? "on" : ""} style={{ "--ws-accent": w.accent }} onClick={() => { setMenu(null); setWorkspace(w.id); }}>
                  <span class="ws-ic">{w.icon}</span><span><b>{w.label}</b><small>{w.hint}</small></span><kbd>Ctrl+Alt+{k + 1}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
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
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={current.id === t.id} class={current.id === t.id ? "on" : ""} onClick={() => { setTab({ ...tabs0, [key]: t.id }); const sec = TAB_SECTION[t.id]; if ((st.workspace === "fem" || st.workspace === "cfd") && sec) openSimSection(sec); }}>{t.label}</button>)}
        </nav>
      </div>
      {/* a chave refaz o painel a cada mudança: os grupos entram com a animação de transição */}
      <div class="tb-row commands" role="tabpanel" key={`${key}:${current.id}`}>
        {current.groups.map((g) => (
          <div class="group" key={g.title} aria-label={g.title}>{g.ids.map(cmdButton)}</div>
        ))}
      </div>
      {tip && HELP[tip.id] && <FeatureTip h={{ ...HELP[tip.id], what: `${HELP[tip.id].what}${commandById.get(tip.id)?.keys?.[0] ? ` Atalho: ${commandById.get(tip.id)!.keys![0]}.` : ""}` }} x={tip.x} y={tip.y} />}
    </header>
  );
}
