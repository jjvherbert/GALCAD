// Sobreposições de interação ao estilo do SolidWorks: menu de contexto, barra de contexto,
// barra de atalhos (S), orientação da vista (Espaço), guia dos gestos e barra de vista.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { COMMANDS, commandById, runCommand } from "./commands.ts";
import { type Pick, store, useStore } from "./store.ts";
import type { GestureDir } from "./settings.ts";
import { VIEWS, type ViewName } from "./viewport.ts";
import { describeName } from "./forms.tsx";

/** Feature que criou uma face/aresta (pelo primeiro id do nome topológico). */
export function featureOfPick(p: Pick | null): string | null {
  if (!p || (p.kind !== "face" && p.kind !== "edge")) return null;
  const m = /f\d+(?=:)/.exec(p.name);
  return m ? m[0] : null;
}

function clampTo(at: [number, number], w: number, h: number): { left: string; top: string } {
  return { left: `${Math.max(4, Math.min(at[0], innerWidth - w - 4))}px`, top: `${Math.max(4, Math.min(at[1], innerHeight - h - 4))}px` };
}

function Popup({ at, w = 240, h = 320, children, label }: { at: [number, number]; w?: number; h?: number; children: ComponentChildren; label: string }) {
  return (
    <div class="popup" role="menu" aria-label={label} style={clampTo(at, w, h)} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

const Item = ({ label, keys, onClick, disabled }: { label: string; keys?: string; onClick: () => void; disabled?: boolean }) => (
  <button role="menuitem" disabled={disabled} onClick={() => { store.closeOverlays(); onClick(); }}>
    <span>{label}</span>{keys && <kbd>{keys}</kbd>}
  </button>
);

/** Usa a peça clicada como seleção antes de executar um comando de criação. */
function withPick(p: Pick | null, id: string) {
  if (p) store.set({ selection: [p] });
  runCommand(id);
}

export function ContextMenu() {
  const st = useStore();
  const m = st.contextMenu!;
  const p = m.pick;
  const fid = featureOfPick(p);
  const feature = fid ? st.doc.features.find((f) => f.id === fid) : undefined;
  const planarFace = p?.kind === "face" && p.type === "plane";
  return (
    <Popup at={m.at} label="Menu de contexto">
      {p && p.kind !== "region" && <div class="popup-title" title={p.kind === "plane" || p.kind === "axis" ? p.label : p.name}>{p.kind === "plane" || p.kind === "axis" ? p.label : describeName(st.doc, p.name)}</div>}
      {(planarFace || p?.kind === "plane") && <Item label="Esboço aqui" onClick={() => withPick(p, "sketch.new")} />}
      {(planarFace || p?.kind === "plane") && <Item label="Normal a" keys="Ctrl+8" onClick={() => withPick(p, "view.normal")} />}
      {feature && <Item label={`Editar ${feature.name}`} onClick={() => store.editFeature(feature.id)} />}
      {feature && "sketch" in feature && typeof feature.sketch === "string" && <Item label="Editar esboço" onClick={() => store.editSketch((feature as { sketch: string }).sketch)} />}
      {feature && <Item label="Selecionar na árvore" onClick={() => store.set({ selectedFeature: feature.id })} />}
      {(p?.kind === "edge" || p?.kind === "face") && <Item label="Filete" onClick={() => withPick(p, "feature.fillet")} />}
      {(p?.kind === "edge" || p?.kind === "face") && <Item label="Chanfro" onClick={() => withPick(p, "feature.chamfer")} />}
      {p?.kind === "face" && <Item label="Casca (remover esta face)" onClick={() => withPick(p, "feature.shell")} />}
      {(planarFace || p?.kind === "plane") && <Item label="Plano de referência paralelo" onClick={() => withPick(p, "feature.plane")} />}
      {!p && <Item label="Esboço" onClick={() => runCommand("sketch.new")} />}
      <Item label="Ajustar ao ecrã" keys="F" onClick={() => runCommand("view.fit")} />
      <Item label="Orientação da vista…" keys="Espaço" onClick={() => store.set({ orientationMenu: { at: m.at } })} />
      <Item label="Vista anterior" keys="Ctrl+Shift+Z" onClick={() => runCommand("view.previous")} />
      {st.lastCommand && <Item label={`Repetir: ${commandById.get(st.lastCommand)?.label}`} keys="Enter" onClick={() => runCommand(st.lastCommand!)} />}
    </Popup>
  );
}

/** Barra de contexto que aparece junto à seleção (como no SolidWorks). */
export function ContextToolbar() {
  const st = useStore();
  const t = st.contextToolbar!;
  const p = t.pick;
  const fid = featureOfPick(p);
  const planar = p.kind === "plane" || (p.kind === "face" && p.type === "plane");
  const btn = (icon: string, title: string, fn: () => void) => <button title={title} aria-label={title} onClick={() => { store.closeOverlays(); fn(); }}>{icon}</button>;
  return (
    <div class="context-toolbar" style={clampTo([t.at[0] + 12, t.at[1] - 44], 200, 40)} onPointerDown={(e) => e.stopPropagation()}>
      {planar && btn("✎", "Esboço", () => runCommand("sketch.new"))}
      {planar && btn("⊥", "Normal a", () => runCommand("view.normal"))}
      {fid && btn("⚙", "Editar feature", () => store.editFeature(fid))}
      {(p.kind === "edge" || p.kind === "face") && btn("◜", "Filete", () => runCommand("feature.fillet"))}
      {(p.kind === "edge" || p.kind === "face") && btn("◸", "Chanfro", () => runCommand("feature.chamfer"))}
    </div>
  );
}

/** Barra de atalhos (tecla S): pesquisa de comandos junto ao cursor. */
export function ShortcutBar() {
  const st = useStore();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const base = COMMANDS.filter((c) => c.id !== "ui.shortcutBar" && c.id !== "edit.escape");
    const found = n ? base.filter((c) => norm(c.label).includes(n) || c.id.includes(n)) : base.filter((c) => c.group === "Features" || c.group === "Esboço" || c.id === "view.normal" || c.id === "view.fit");
    return found.slice(0, 14);
  }, [q]);
  return (
    <Popup at={st.shortcutBar!.at} w={300} h={420} label="Barra de atalhos">
      <input ref={input} class="search" placeholder="Pesquisar comandos…" value={q} aria-label="Pesquisar comandos"
        onInput={(e) => { setQ((e.target as HTMLInputElement).value); setI(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setI(Math.min(list.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setI(Math.max(0, i - 1)); }
          else if (e.key === "Enter" && list[i]) runCommand(list[i].id);
          else if (e.key === "Escape") store.closeOverlays();
          e.stopPropagation();
        }} />
      <div class="cmd-list">
        {list.map((c, k) => (
          <button key={c.id} role="menuitem" class={k === i ? "active" : ""} onMouseEnter={() => setI(k)} onClick={() => runCommand(c.id)}>
            <span class="ic">{c.icon ?? ""}</span><span>{c.label}</span><span class="muted">{c.group}</span>{c.keys && <kbd>{c.keys[0]}</kbd>}
          </button>
        ))}
        {!list.length && <p class="muted">Nenhum comando</p>}
      </div>
    </Popup>
  );
}

/** Orientação da vista (Espaço). */
export function OrientationMenu() {
  const st = useStore();
  const v = (n: ViewName) => <button key={n} role="menuitem" onClick={() => runCommand(`view.${n}`)}><span>{VIEWS[n].label}</span><kbd>{VIEWS[n].key}</kbd></button>;
  return (
    <Popup at={st.orientationMenu!.at} w={260} h={300} label="Orientação da vista">
      <div class="popup-title">Orientação da vista</div>
      <div class="orient-grid">{(Object.keys(VIEWS) as ViewName[]).map(v)}</div>
      <Item label="Normal a" keys="Ctrl+8" onClick={() => runCommand("view.normal")} />
      <Item label="Vista anterior" keys="Ctrl+Shift+Z" onClick={() => runCommand("view.previous")} />
    </Popup>
  );
}

const GESTURE_POS: Record<GestureDir, [number, number]> = {
  up: [0, -1], upRight: [0.71, -0.71], right: [1, 0], downRight: [0.71, 0.71], down: [0, 1], downLeft: [-0.71, 0.71], left: [-1, 0], upLeft: [-0.71, -0.71],
};

/** Guia dos gestos do rato (arrastar com o botão direito). */
export function GestureHud() {
  const st = useStore();
  const g = st.gesture!;
  return (
    <div class="gesture-hud" style={{ left: `${g.at[0]}px`, top: `${g.at[1]}px` }} aria-hidden="true">
      {(Object.keys(GESTURE_POS) as GestureDir[]).map((d) => {
        const [x, y] = GESTURE_POS[d];
        const c = commandById.get(st.settings.gestures[d]);
        return <span key={d} class={g.dir === d ? "on" : ""} style={{ transform: `translate(calc(${x * 80}px - 50%), calc(${y * 64}px - 50%))` }}>{c?.label.replace(/^Vista /, "") ?? "—"}</span>;
      })}
    </div>
  );
}

/** Barra de vista sobre o 3D (heads-up): ajustar, vista anterior, orientação, estilo, planos. */
export function HeadsUpToolbar() {
  const st = useStore();
  const [open, setOpen] = useState<"style" | null>(null);
  const style = st.settings.displayStyle;
  return (
    <div class="heads-up" role="toolbar" aria-label="Vista">
      <button title="Ajustar ao ecrã (F)" onClick={() => runCommand("view.fit")}>⤢</button>
      <button title="Vista anterior (Ctrl+Shift+Z)" onClick={() => runCommand("view.previous")}>⟲</button>
      <button title="Orientação da vista (Espaço)" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); store.set({ orientationMenu: { at: [r.left, r.bottom + 4] } }); }}>⬚</button>
      <button title="Normal a (Ctrl+8)" onClick={() => runCommand("view.normal")}>⊥</button>
      <div class="dropdown">
        <button title="Estilo de visualização" onClick={() => setOpen(open === "style" ? null : "style")}>{style === "shadedEdges" ? "◼" : style === "shaded" ? "●" : "▢"} ▾</button>
        {open === "style" && (
          <div class="menu" role="menu" onClick={() => setOpen(null)}>
            <button role="menuitem" class={style === "shadedEdges" ? "on" : ""} onClick={() => runCommand("view.styleEdges")}>◼ Sombreado com arestas</button>
            <button role="menuitem" class={style === "shaded" ? "on" : ""} onClick={() => runCommand("view.styleShaded")}>● Sombreado</button>
            <button role="menuitem" class={style === "wireframe" ? "on" : ""} onClick={() => runCommand("view.styleWire")}>▢ Arestas (fio de arame)</button>
          </div>
        )}
      </div>
      <button class={st.settings.showPlanes ? "on" : ""} title="Mostrar/ocultar planos" onClick={() => runCommand("view.planes")}>▱</button>
    </div>
  );
}
