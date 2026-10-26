// Barra de comandos: ficheiro, desfazer/refazer, features por grupo, vistas e plugins.
import { useRef, useState } from "preact/hooks";
import type { FeatureType } from "../doc/types.ts";
import { FILE_EXTENSION, serialize } from "../doc/io.ts";
import type { ExportFormat } from "../kernel/protocol.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { store, useStore } from "./store.ts";

const GROUPS: { title: string; items: { type: FeatureType; label: string; icon: string; hint: string }[] }[] = [
  { title: "Esboço", items: [{ type: "sketch", label: "Esboço", icon: "✎", hint: "Novo esboço num plano ou face plana" }] },
  {
    title: "Sólidos",
    items: [
      { type: "extrude", label: "Extrusão", icon: "▮", hint: "Extrusão ou corte extrudido de um esboço" },
      { type: "revolve", label: "Revolução", icon: "◐", hint: "Revolução de um esboço em torno de um eixo" },
      { type: "sweep", label: "Varrimento", icon: "〰", hint: "Perfil varrido ao longo de um caminho" },
      { type: "loft", label: "Loft", icon: "⟁", hint: "Sólido entre várias secções" },
      { type: "rib", label: "Nervura", icon: "⊿", hint: "Nervura a partir de um contorno aberto" },
      { type: "hole", label: "Furo", icon: "⊚", hint: "Furo ISO: passagem, roscado, rebaixo, escareado" },
    ],
  },
  {
    title: "Acabamento",
    items: [
      { type: "fillet", label: "Filete", icon: "◜", hint: "Arredondar arestas (selecione-as primeiro, opcional)" },
      { type: "chamfer", label: "Chanfro", icon: "◸", hint: "Chanfrar arestas" },
      { type: "shell", label: "Casca", icon: "▢", hint: "Esvaziar o corpo com espessura de parede" },
      { type: "draft", label: "Inclinação", icon: "⏢", hint: "Ângulo de saída em faces" },
    ],
  },
  {
    title: "Padrões",
    items: [
      { type: "linearPattern", label: "Linear", icon: "⁞", hint: "Padrão linear de features" },
      { type: "circularPattern", label: "Circular", icon: "✲", hint: "Padrão circular de features" },
      { type: "mirror", label: "Espelho", icon: "⇋", hint: "Espelhar features ou o corpo" },
    ],
  },
  {
    title: "Referências",
    items: [
      { type: "plane", label: "Plano", icon: "▱", hint: "Plano de referência (desvio/ângulo)" },
      { type: "axis", label: "Eixo", icon: "┆", hint: "Eixo de referência" },
      { type: "csys", label: "Sist. coord.", icon: "⌖", hint: "Sistema de coordenadas" },
    ],
  },
];

const EXPORTS: [ExportFormat, string][] = [["step", "STEP (AP214) — sólido exato"], ["stl", "STL binário — impressão 3D"], ["3mf", "3MF — impressão 3D"], ["obj", "OBJ — malha"], ["glb", "glTF binário (.glb) — visualização"]];

/** Nome de ficheiro portável: sem acentos nem caracteres especiais (alguns browsers rejeitam-nos). */
export const safeFileName = (n: string) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_") || "peca";

function download(name: string, data: BlobPart, mime: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data], { type: mime })), download: safeFileName(name), hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function Toolbar({ onView }: { onView: (v: "iso" | "front" | "top" | "right" | "fit") => void }) {
  const st = useStore();
  const openRef = useRef<HTMLInputElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<"file" | "export" | "plugins" | null>(null);
  const busyEdit = !!st.edit || !!st.sketch;

  const readFile = (input: HTMLInputElement, fn: (name: string, text: string) => void) => {
    const f = input.files?.[0];
    if (!f) return;
    f.text().then((t) => fn(f.name, t)).catch((e) => store.set({ error: String(e) }));
    input.value = "";
  };

  const doExport = async (format: ExportFormat) => {
    setMenu(null);
    try {
      const r = await store.kernel.export(format, st.doc.name);
      download(`${st.fileName || st.doc.name}.${r.ext}`, r.data as BlobPart, r.mime);
      store.set({ message: `Exportado ${r.ext.toUpperCase()} (${Math.round(r.data.length / 1024)} kB, mm)` });
    } catch (e) { store.set({ error: (e as Error).message }); }
  };

  return (
    <header class="toolbar" onClick={() => menu && setMenu(null)}>
      <div class="brand">CAD<span>protótipo</span></div>
      <div class="group">
        <div class="dropdown">
          <button onClick={(e) => { e.stopPropagation(); setMenu(menu === "file" ? null : "file"); }} disabled={busyEdit}>Ficheiro ▾</button>
          {menu === "file" && (
            <div class="menu" role="menu">
              <button role="menuitem" onClick={() => { if (!st.dirty || confirm("Descartar as alterações por guardar?")) store.newDoc(); }}>Novo</button>
              <button role="menuitem" onClick={() => openRef.current?.click()}>Abrir projeto ({FILE_EXTENSION})…</button>
              <button role="menuitem" onClick={() => { download(`${st.fileName || st.doc.name}${FILE_EXTENSION}`, serialize(st.doc), "application/json"); store.set({ dirty: false, message: "Projeto guardado" }); }}>Guardar projeto</button>
              <button role="menuitem" onClick={() => stepRef.current?.click()}>Importar STEP…</button>
            </div>
          )}
        </div>
        <div class="dropdown">
          <button onClick={(e) => { e.stopPropagation(); setMenu(menu === "export" ? null : "export"); }} disabled={!st.result?.mesh}>Exportar ▾</button>
          {menu === "export" && (
            <div class="menu" role="menu">{EXPORTS.map(([f, l]) => <button role="menuitem" key={f} onClick={() => doExport(f)}>{l}</button>)}</div>
          )}
        </div>
        <button title={`Desfazer ${store.history.undoLabel ?? ""} (Ctrl+Z)`} disabled={busyEdit || !store.history.canUndo} onClick={() => store.undo()}>↶</button>
        <button title={`Refazer ${store.history.redoLabel ?? ""} (Ctrl+Y)`} disabled={busyEdit || !store.history.canRedo} onClick={() => store.redo()}>↷</button>
        <button title="Variáveis globais e equações" disabled={!!st.sketch} onClick={() => store.set({ showVariables: true })}>𝑥 = Variáveis</button>
      </div>
      {GROUPS.map((g) => (
        <div class="group" key={g.title} aria-label={g.title}>
          {g.items.map((it) => (
            <button key={it.type} class="cmd" title={it.hint} disabled={busyEdit} onClick={() => store.startFeature(it.type)}>
              <span class="ic">{it.icon}</span><span class="lb">{it.label}</span>
            </button>
          ))}
        </div>
      ))}
      <div class="group">
        <div class="dropdown">
          <button class="cmd" disabled={busyEdit} onClick={(e) => { e.stopPropagation(); setMenu(menu === "plugins" ? null : "plugins"); }}><span class="ic">⧉</span><span class="lb">Módulos ▾</span></button>
          {menu === "plugins" && (
            <div class="menu" role="menu">
              {PLUGINS.flatMap((p) => Object.entries(p.kinds).map(([k, kind]) => (
                <button role="menuitem" key={`${p.id}/${k}`} onClick={() => store.startFeature("plugin", { plugin: p.id, kind: k })}>{p.name}: {kind.label}</button>
              )))}
            </div>
          )}
        </div>
      </div>
      <div class="group views" aria-label="Vistas">
        <button title="Isométrica" onClick={() => onView("iso")}>Iso</button>
        <button title="Frente" onClick={() => onView("front")}>Frente</button>
        <button title="Topo" onClick={() => onView("top")}>Topo</button>
        <button title="Direita" onClick={() => onView("right")}>Direita</button>
        <button title="Ajustar ao ecrã (F)" onClick={() => onView("fit")}>⤢</button>
      </div>
      <input ref={openRef} type="file" accept=".json,.cadp.json,application/json" hidden onChange={(e) => readFile(e.target as HTMLInputElement, (name, text) => {
        try { store.open(text, name); } catch (err) { store.set({ error: (err as Error).message }); }
      })} />
      <input ref={stepRef} type="file" accept=".step,.stp" hidden onChange={(e) => readFile(e.target as HTMLInputElement, (name, text) => store.addImport(name, text))} />
    </header>
  );
}
