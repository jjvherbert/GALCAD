// Diálogos: variáveis globais/equações e escolha do plano de esboço.
import { useEffect, useRef, useState } from "preact/hooks";
import type { PlaneRef, Variable } from "../doc/types.ts";
import { resolveVariables } from "../doc/variables.ts";
import { store, useStore } from "./store.ts";
import { PlaneSelect, usePickTarget } from "./forms.tsx";
import { commandViewport, planeFrame } from "./commands.ts";

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

const STD_PLANES = [
  { name: "XY", label: "Planta", hint: "plano horizontal (XY)" },
  { name: "XZ", label: "Frente", hint: "plano vertical de frente (XZ)" },
  { name: "YZ", label: "Lateral", hint: "plano vertical lateral (YZ)" },
] as const;
const planeKey = (name: string) => `plane:${JSON.stringify({ kind: "std", name })}`;

/**
 * Escolha do plano do esboço como no SolidWorks: os três planos aparecem no 3D, realçam-se ao passar
 * o rato (ou no botão) e, ao escolher um plano ou uma face plana, a vista roda para ficar normal a ele
 * e só então abre o esboço.
 */
export function PlaneChooser() {
  const [plane, setPlane] = useState<PlaneRef>({ kind: "std", name: "XY" });
  const begin = (p: PlaneRef) => {
    const v = commandViewport();
    const fr = planeFrame(p);
    v?.setHoverKey(null);
    if (v && fr && v.animate) {
      v.normalTo(fr.o, fr.z, fr.y);
      v.returnAfterSketch = true; // ao sair do esboço, a vista volta à de antes (como no SolidWorks)
      setTimeout(() => { if (store.state.choosingPlane) store.startSketch(p); else v.returnAfterSketch = false; }, 340);
    } else store.startSketch(p);
  };
  usePickTarget("sketch-start", (p) => {
    if (p.kind === "plane") begin(p.ref);
    else if (p.kind === "face") {
      if (p.type !== "plane") { store.set({ message: "Escolha uma face plana" }); return; }
      begin({ kind: "face", ref: { kind: "face", name: p.name, hint: p.hint } });
    }
  });
  const planeRef = useRef(plane);
  planeRef.current = plane;
  useEffect(() => {
    store.set({ pickTarget: { field: "sketch-start", accept: ["face", "plane"] } });
    // 1, 2, 3 escolhem Planta, Frente, Lateral; Enter começa no plano escolhido (menos cliques)
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.altKey || e.metaKey || (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i >= 0) { e.stopImmediatePropagation(); e.preventDefault(); begin({ kind: "std", name: STD_PLANES[i].name }); }
      else if (e.key === "Enter") { e.stopImmediatePropagation(); e.preventDefault(); begin(planeRef.current); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); commandViewport()?.setHoverKey(null); };
  }, []);
  return (
    <div class="property-panel plane-chooser">
      <header>
        <h2>Novo esboço</h2>
        <div class="actions">
          <button class="primary" onClick={() => begin(plane)} title="Começar o esboço no plano escolhido">✓ Começar</button>
          <button onClick={() => store.set({ choosingPlane: false, pickTarget: null })} title="Cancelar (Esc)">✕</button>
        </div>
      </header>
      <p class="muted">Clique num plano ou numa face plana do modelo, ou carregue em 1, 2 ou 3 (Enter = Planta).</p>
      <div class="plane-cards">
        {STD_PLANES.map((p) => (
          <button key={p.name} class="plane-card" title={`Esboço no ${p.hint}`}
            onMouseEnter={() => commandViewport()?.setHoverKey(planeKey(p.name))} onMouseLeave={() => commandViewport()?.setHoverKey(null)}
            onFocus={() => commandViewport()?.setHoverKey(planeKey(p.name))} onBlur={() => commandViewport()?.setHoverKey(null)}
            onClick={() => begin({ kind: "std", name: p.name })}>
            <svg viewBox="0 0 40 30" aria-hidden="true"><polygon class={`pl pl-${p.name}`} points={p.name === "XY" ? "4,18 20,10 36,18 20,26" : p.name === "XZ" ? "8,22 8,6 24,12 24,28" : "36,22 36,6 20,12 20,28"} /></svg>
            <b>{p.label}</b><small>{p.name} · tecla {STD_PLANES.indexOf(p) + 1}</small>
          </button>
        ))}
      </div>
      {plane && <PlaneSelect field="sketch-plane" label="Outro plano (referência, sistema de coordenadas)" value={plane} before={store.insertIndex()} onChange={(p) => { setPlane(p); }} />}
    </div>
  );
}
