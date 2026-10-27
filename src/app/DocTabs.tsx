// Abas dos documentos do projeto (peças, montagens, desenhos), como as janelas de documentos do SolidWorks.
import { useState } from "preact/hooks";
import type { DocKind, DocRef } from "../doc/project.ts";
import { store, useStore } from "./store.ts";

const ICON: Record<DocKind, string> = { part: "▮", assembly: "⧉", drawing: "▭" };
const KIND: Record<DocKind, string> = { part: "Peça", assembly: "Montagem", drawing: "Desenho" };

export function DocTabs() {
  const st = useStore();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const p = st.project;
  const docs: (DocRef & { name: string })[] = [
    ...p.parts.map((d) => ({ kind: "part" as const, id: d.id, name: d.name })),
    ...p.assemblies.map((d) => ({ kind: "assembly" as const, id: d.id, name: d.name })),
    ...p.drawings.map((d) => ({ kind: "drawing" as const, id: d.id, name: d.name })),
  ];
  return (
    <div class="doc-tabs" role="tablist" aria-label="Documentos do projeto">
      {docs.map((d) => {
        const on = st.active.id === d.id;
        return (
          <div key={d.id} role="tab" aria-selected={on} class={`doc-tab ${on ? "on" : ""}`} title={`${KIND[d.kind]} ${d.name}`}
            onClick={() => !on && store.setActive({ kind: d.kind, id: d.id })} onDblClick={() => setRenaming(d.id)}>
            <span class="ic" aria-hidden="true">{ICON[d.kind]}</span>
            {renaming === d.id ? (
              <input class="rename" autoFocus value={d.name}
                onBlur={(e) => { store.renameDocument(d, (e.target as HTMLInputElement).value); setRenaming(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); e.stopPropagation(); }} />
            ) : <span>{d.name}</span>}
            {on && docs.length > 1 && <button class="icon" aria-label={`Apagar ${d.name}`} title="Apagar documento" onClick={(e) => { e.stopPropagation(); if (confirm(`Apagar ${KIND[d.kind].toLowerCase()} "${d.name}"?`)) store.deleteDocument(d); }}>✕</button>}
          </div>
        );
      })}
      <div class="dropdown">
        <button class="doc-new" aria-label="Novo documento" title="Novo documento" onClick={() => setMenu(!menu)}>＋</button>
        {menu && (
          <div class="menu" role="menu" onClick={() => setMenu(false)}>
            <button role="menuitem" onClick={() => store.addDocument("part")}>▮ Nova peça</button>
            <button role="menuitem" onClick={() => store.addDocument("assembly")}>⧉ Nova montagem</button>
            <button role="menuitem" onClick={() => store.addDocument("drawing")}>▭ Novo desenho</button>
          </div>
        )}
      </div>
    </div>
  );
}
