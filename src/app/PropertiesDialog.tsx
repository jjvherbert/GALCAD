// Propriedades da peça (BOM e legenda): número, descrição, material, massa volúmica, acabamento, fornecedor.
import { useState } from "preact/hooks";
import type { PartProperties } from "../doc/project.ts";
import { DEFAULT_DENSITY } from "../doc/project.ts";
import { store, useStore } from "./store.ts";

/** Materiais comuns com a massa volúmica típica (g/cm³), como sugestão; o utilizador pode escrever outro. */
export const MATERIALS: [string, number][] = [
  ["Aço S235JR", 7.85], ["Aço S355J2", 7.85], ["Aço C45", 7.85], ["Aço inox 1.4301 (AISI 304)", 7.9], ["Aço inox 1.4404 (AISI 316L)", 8.0],
  ["Alumínio EN AW-6082 T6", 2.7], ["Alumínio EN AW-5083 H111", 2.66], ["Latão CuZn39Pb3", 8.47], ["Bronze CuSn12", 8.7],
  ["Ferro fundido EN-GJL-250", 7.2], ["POM-C", 1.41], ["PA6", 1.14], ["PE-HD", 0.95], ["PRFV (laminado E-glass/poliéster)", 1.7],
];

export function PartPropertiesDialog({ onClose }: { onClose: () => void }) {
  const st = useStore();
  const [p, setP] = useState<PartProperties>(() => ({ density: DEFAULT_DENSITY, ...st.doc.properties }));
  const [custom, setCustom] = useState<[string, string][]>(() => Object.entries(st.doc.properties?.custom ?? {}));
  const field = (key: keyof Omit<PartProperties, "custom" | "density">, label: string) => (
    <label class="row"><span>{label}</span><input value={(p[key] as string) ?? ""} onInput={(e) => setP({ ...p, [key]: (e.target as HTMLInputElement).value })} /></label>
  );
  const save = () => {
    const c = Object.fromEntries(custom.filter(([k]) => k.trim()));
    store.setPartProperties({ ...p, custom: Object.keys(c).length ? c : undefined });
    onClose();
  };
  return (
    <div class="modal-back" onClick={onClose}>
      <div class="modal props" role="dialog" aria-modal="true" aria-label="Propriedades da peça" onClick={(e) => e.stopPropagation()}>
        <h2>Propriedades da peça — {st.doc.name}</h2>
        {field("number", "Número / referência")}
        {field("description", "Descrição")}
        <label class="row"><span>Material</span>
          <input list="materials" value={p.material ?? ""} onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            const known = MATERIALS.find(([m]) => m === v);
            setP({ ...p, material: v, ...(known ? { density: known[1] } : {}) });
          }} />
          <datalist id="materials">{MATERIALS.map(([m]) => <option key={m} value={m} />)}</datalist>
        </label>
        <label class="row"><span>Massa volúmica (g/cm³)</span><input type="number" step="0.01" value={p.density ?? DEFAULT_DENSITY} onInput={(e) => setP({ ...p, density: Number((e.target as HTMLInputElement).value) || DEFAULT_DENSITY })} /></label>
        {field("finish", "Acabamento")}
        {field("supplier", "Fornecedor")}
        <h3>Propriedades personalizadas</h3>
        {custom.map(([k, v], i) => (
          <div class="row" key={i}>
            <input aria-label="Nome da propriedade" value={k} onInput={(e) => setCustom(custom.map((x, j) => (j === i ? [(e.target as HTMLInputElement).value, x[1]] : x)))} />
            <input aria-label="Valor" value={v} onInput={(e) => setCustom(custom.map((x, j) => (j === i ? [x[0], (e.target as HTMLInputElement).value] : x)))} />
            <button class="icon" aria-label="Retirar" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button class="small" onClick={() => setCustom([...custom, ["", ""]])}>+ propriedade</button>
        <p class="muted">A massa volúmica dos materiais da lista é um valor típico de referência; confirme com a ficha do fornecedor.</p>
        <div class="actions"><button class="primary" onClick={save}>Guardar</button><button onClick={onClose}>Cancelar</button></div>
      </div>
    </div>
  );
}
