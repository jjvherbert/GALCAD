// Árvore de features (equivalente ao FeatureManager): estado, edição, supressão, ordem e rollback.
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { Feature } from "../doc/types.ts";
import { dependents, featureLabel } from "../doc/features.ts";
import { store, useStore } from "./store.ts";

const ICONS: Record<Feature["type"], string> = {
  sketch: "✎", extrude: "▮", revolve: "◐", sweep: "〰", loft: "⟁", hole: "⊚", fillet: "◜", chamfer: "◸", shell: "▢",
  draft: "⏢", rib: "⊿", linearPattern: "⁞", circularPattern: "✲", mirror: "⇋", plane: "▱", axis: "┆", csys: "⌖", import: "⇩", plugin: "⧉",
};

export function FeatureTree() {
  const st = useStore();
  const { doc, result, selectedFeature } = st;
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const rb = doc.rollback ?? doc.features.length;

  const row = (f: Feature, i: number) => {
    const s = result?.status[f.id];
    const state = f.suppressed ? "suppressed" : i >= rb ? "rolledBack" : s?.state ?? "pending";
    const sketchOf = "sketch" in f && typeof f.sketch === "string" ? f.sketch : f.type === "sweep" ? f.profile : undefined;
    return (
      <li key={f.id}
        class={`feat ${state} ${selectedFeature === f.id ? "selected" : ""} ${dragId === f.id ? "dragging" : ""}`}
        draggable
        onDragStart={() => setDragId(f.id)}
        onDragEnd={() => setDragId(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== f.id) store.move(dragId, i); setDragId(null); }}
        onClick={() => store.set({ selectedFeature: f.id })}
        onMouseEnter={() => store.set({ hoverFeature: f.id })}
        onMouseLeave={() => store.set({ hoverFeature: null })}
        onDblClick={() => store.editFeature(f.id)}
        title={s?.error ?? s?.warnings.join("\n") ?? ""}>
        <span class="ic" aria-hidden="true">{ICONS[f.type]}</span>
        {renaming === f.id ? (
          <input class="rename" autoFocus value={f.name}
            onKeyDown={(e) => { if (e.key === "Enter") { store.rename(f.id, (e.target as HTMLInputElement).value); setRenaming(null); } if (e.key === "Escape") setRenaming(null); }}
            onBlur={(e) => { store.rename(f.id, (e.target as HTMLInputElement).value); setRenaming(null); }} />
        ) : (
          <span class="name">{f.name}<span class="kind"> · {featureLabel(f)}</span></span>
        )}
        {state === "error" && <span class="badge err" aria-label="Erro">✕</span>}
        {state === "warning" && <span class="badge warn" aria-label="Aviso">⚠</span>}
        {s?.ms !== undefined && s.ms > 200 && <span class="ms">{s.ms} ms</span>}
        <button class="icon menu-btn" aria-label={`Ações de ${f.name}`} onClick={(e) => { e.stopPropagation(); setMenu(menu === f.id ? null : f.id); }}>⋯</button>
        {menu === f.id && (
          <div class="menu" role="menu" onClick={(e) => { e.stopPropagation(); setMenu(null); }}>
            <button role="menuitem" onClick={() => store.editFeature(f.id)}>Editar</button>
            {sketchOf && <button role="menuitem" onClick={() => store.editSketch(sketchOf)}>Editar esboço</button>}
            <button role="menuitem" onClick={() => setRenaming(f.id)}>Renomear</button>
            <button role="menuitem" onClick={() => store.toggleSuppress(f.id)}>{f.suppressed ? "Reativar" : "Suprimir"}</button>
            <button role="menuitem" onClick={() => store.setRollback(i)}>Rollback para antes desta</button>
            <button role="menuitem" disabled={i === 0} onClick={() => store.move(f.id, i - 1)}>Mover para cima</button>
            <button role="menuitem" disabled={i === doc.features.length - 1} onClick={() => store.move(f.id, i + 1)}>Mover para baixo</button>
            <button role="menuitem" class="danger" onClick={() => {
              const deps = dependents(doc, f.id);
              const names = deps.map((d) => doc.features.find((x) => x.id === d)?.name).join(", ");
              if (!deps.length || confirm(`Apagar "${f.name}" apaga também: ${names}. Continuar?`)) store.deleteFeature(f.id);
            }}>Apagar</button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div class="tree" onClick={() => setMenu(null)}>
      <ul aria-label="Árvore de features">
        <li class="feat origin"><span class="ic">⌖</span><span class="name">Origem · planos XY, XZ, YZ</span></li>
        {doc.features.map((f, i) => (
          <Fragment key={f.id}>
            {i === rb && <RollbackBar />}
            {row(f, i)}
          </Fragment>
        ))}
        {rb >= doc.features.length && doc.features.length > 0 && <RollbackBar end />}
      </ul>
      {!doc.features.length && <p class="muted empty">Comece por um <b>Esboço</b> num plano, ou importe um STEP.</p>}
    </div>
  );
}

function RollbackBar({ end }: { end?: boolean }) {
  return (
    <li class={`rollback ${end ? "end" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      title="Barra de rollback: as features abaixo não são reconstruídas; as novas entram aqui">
      <span>Barra de rollback</span>
      {!end && <button class="small" onClick={() => store.setRollback(undefined)}>Avançar até ao fim</button>}
    </li>
  );
}
