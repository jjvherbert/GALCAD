// Diálogos: variáveis globais/equações e escolha do plano de esboço.
import { useState } from "preact/hooks";
import type { Variable } from "../doc/types.ts";
import { resolveVariables } from "../doc/variables.ts";
import { store, useStore } from "./store.ts";
import { PlaneSelect } from "./forms.tsx";

const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 6 });

export function VariablesDialog() {
  const st = useStore();
  const [rows, setRows] = useState<Variable[]>(() => structuredClone(st.doc.variables));
  const res = resolveVariables(rows);
  const set = (i: number, patch: Partial<Variable>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const close = () => store.set({ showVariables: false });
  const usable = res.errors.size === 0;
  return (
    <div class="modal-back" onClick={close}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Variáveis globais" onClick={(e) => e.stopPropagation()}>
        <h2>Variáveis globais e equações</h2>
        <p class="muted">Use os nomes em qualquer cota ou parâmetro (ex.: <code>L/2</code>, <code>Espessura + 1</code>). Comprimentos em mm, ângulos em graus; aceita <code>sin cos tan sqrt min max if pi</code> e unidades <code>mm cm m in deg</code>.</p>
        <table class="vars">
          <thead><tr><th>Nome</th><th>Expressão</th><th>Valor</th><th>Comentário</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const err = res.errors.get(r.name);
              return (
                <tr key={i} class={err ? "invalid" : ""}>
                  <td><input value={r.name} aria-label="Nome" onInput={(e) => set(i, { name: (e.target as HTMLInputElement).value })} /></td>
                  <td><input value={r.expr} aria-label="Expressão" spellcheck={false} onInput={(e) => set(i, { expr: (e.target as HTMLInputElement).value })} /></td>
                  <td>{err ? <span class="err" title={err}>{err}</span> : fmt(res.values.get(r.name) ?? NaN)}</td>
                  <td><input value={r.comment ?? ""} aria-label="Comentário" onInput={(e) => set(i, { comment: (e.target as HTMLInputElement).value || undefined })} /></td>
                  <td><button class="icon" aria-label="Apagar" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div class="actions">
          <button onClick={() => {
            let n = rows.length + 1;
            while (rows.some((r) => r.name === `V${n}`)) n++;
            setRows([...rows, { name: `V${n}`, expr: "10" }]);
          }}>+ Variável</button>
          <span class="grow" />
          <button class="primary" disabled={!usable} title={usable ? "" : "Corrija os erros primeiro"} onClick={() => { store.setVariables(rows); close(); }}>Aplicar</button>
          <button onClick={close}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

export function PlaneChooser() {
  const st = useStore();
  const [plane, setPlane] = useState<Parameters<typeof store.startSketch>[0]>({ kind: "std", name: "XY" });
  return (
    <div class="property-panel">
      <header>
        <h2>Novo esboço</h2>
        <div class="actions">
          <button class="primary" onClick={() => store.startSketch(plane)}>Começar</button>
          <button onClick={() => store.set({ choosingPlane: false, pickTarget: null })}>✕</button>
        </div>
      </header>
      <p class="muted">Escolha o plano, ou clique num plano ou numa face plana do modelo.</p>
      {plane && <PlaneSelect field="sketch-plane" label="Plano do esboço" value={plane} before={store.insertIndex()} onChange={(p) => { setPlane(p); }} />}
      {st.pickTarget?.field !== "sketch-plane" && <button class="small" onClick={() => store.set({ pickTarget: { field: "sketch-plane", accept: ["face", "plane"] } })}>Escolher no modelo</button>}
    </div>
  );
}
