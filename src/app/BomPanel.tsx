// Painel de BOM da montagem ativa: tabela (topo / só peças / indentada), exportação CSV e XLSX e o
// assistente (sugestões locais e, opcionalmente, do Claude) que o utilizador aceita ou ignora.
import { useMemo, useState } from "preact/hooks";
import { BOM_COLUMNS, type BomMode, bomCell, computeBom, customColumns } from "../assembly/bom.ts";
import { type CostRates, DEFAULT_RATES, type Suggestion, localSuggestions } from "../ai/bom-assistant.ts";
import { toCSV, toXLSX } from "../io/table.ts";
import { store, useStore } from "./store.ts";
import { download } from "./fileio.ts";

const KIND_LABEL: Record<Suggestion["kind"], string> = {
  standard: "Normalizado", description: "Descrição", process: "Processo", material: "Material", duplicate: "Duplicado",
  missing: "Em falta", consistency: "Coerência", cost: "Custo", supplier: "Fornecedor",
};

export function BomPanel() {
  const st = useStore();
  const a = store.activeAssembly();
  const [mode, setMode] = useState<BomMode>("top");
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState<"" | "local" | "claude">("");
  const [rates, setRates] = useState<CostRates>(DEFAULT_RATES);
  const [showRates, setShowRates] = useState(false);
  // a chave fica só neste componente (memória); não é guardada nem enviada para outro lado
  const [apiKey, setApiKey] = useState("");
  const volumes = useMemo(() => Object.fromEntries(Object.entries(st.asmResult?.partMass ?? {}).map(([k, v]) => [k, v.volume])), [st.asmResult]);
  if (!a) return null;
  const rows = computeBom(st.project, a.id, mode, volumes);
  const cols = [...BOM_COLUMNS, ...customColumns(rows).map((k) => ({ key: k, label: k }))];
  const table = () => ({ header: cols.map((c) => c.label), body: rows.map((r) => cols.map((c) => bomCell(r, c.key))) });

  const analyse = async (withClaude: boolean) => {
    setBusy(withClaude ? "claude" : "local");
    try {
      const sig = await store.kernel.signatures(st.project);
      let list = localSuggestions(st.project, sig.parts, rates, a.id);
      if (withClaude) {
        const { claudeSuggestions } = await import("../ai/claude.ts");
        list = [...(await claudeSuggestions(apiKey.trim(), st.project, a.id, sig.parts)), ...list];
      }
      setSugs(list);
      store.set({ message: `${list.length} sugestão(ões)` });
    } catch (e) {
      store.set({ error: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  const accept = (s: Suggestion) => {
    const p = st.project.parts.find((x) => x.id === s.part);
    if (p && s.patch) store.commitDoc("part", { ...p, properties: s.patch }, `Sugestão: ${s.title}`);
    setSugs(sugs.filter((x) => x.id !== s.id));
  };
  const partName = (id: string) => st.project.parts.find((p) => p.id === id)?.name ?? "";

  return (
    <div class="bom-panel">
      <div class="tree-head">
        <b>BOM — {a.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null })}>← Árvore</button>
      </div>
      <div class="row">
        <select aria-label="Tipo de BOM" value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as BomMode)}>
          <option value="top">Só o nível de topo</option>
          <option value="parts">Só peças (achatada)</option>
          <option value="indented">Indentada</option>
        </select>
        <button class="small" onClick={() => { const t = table(); download(`BOM-${a.name}.csv`, toCSV(t.header, t.body), "text/csv"); }}>CSV</button>
        <button class="small" onClick={() => { const t = table(); download(`BOM-${a.name}.xlsx`, toXLSX("BOM", t.header, t.body) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); }}>XLSX</button>
      </div>
      <div class="bom-scroll">
        <table class="bom-table">
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item}>{cols.map((c) => <td key={c.key} style={c.key === "description" ? { paddingLeft: `${4 + r.level * 12}px` } : undefined}>{bomCell(r, c.key)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="field-hint">Número, descrição e material vêm das propriedades de cada peça (abra a peça → Propriedades da peça). Massas: volume × massa volúmica.</p>

      <h3>Assistente de BOM</h3>
      <p class="field-hint">Sugestões para validar, uma a uma — nada muda sem "Aceitar". As designações de normalizados vêm da geometria e de tabelas nominais: confirme na norma/catálogo.</p>
      <div class="row">
        <button class="small" disabled={!!busy} onClick={() => void analyse(false)}>{busy === "local" ? "A analisar…" : "Analisar (local)"}</button>
        <button class="small" onClick={() => setShowRates(!showRates)}>€/kg…</button>
      </div>
      {showRates && (
        <div class="rates">
          {(["steel", "stainless", "aluminium", "copper", "plastic", "composite"] as const).map((k) => (
            <label key={k} class="row"><span>{{ steel: "Aço", stainless: "Inox", aluminium: "Alumínio", copper: "Cobre/latão", plastic: "Plástico", composite: "Compósito" }[k]} (€/kg)</span>
              <input type="number" step="0.1" value={rates[k]} onChange={(e) => setRates({ ...rates, [k]: Number((e.target as HTMLInputElement).value) || 0 })} /></label>
          ))}
          <p class="field-hint">Valores indicativos de matéria-prima, para comparar alternativas; não substituem uma cotação.</p>
        </div>
      )}
      <details class="claude-box">
        <summary>Sugestões com o Claude (opcional)</summary>
        <p class="field-hint">Envia para a API da Anthropic a BOM (nomes, propriedades, quantidades) e um resumo da geometria — não os ficheiros. A chave API fica só em memória nesta página.</p>
        <input type="password" aria-label="Chave API da Anthropic" placeholder="sk-ant-…" value={apiKey} autocomplete="off" onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
        <button class="small" disabled={!apiKey.trim() || !!busy} onClick={() => void analyse(true)}>{busy === "claude" ? "A pedir ao Claude…" : "Pedir sugestões"}</button>
      </details>
      <ul class="suggestions">
        {sugs.map((s) => (
          <li key={s.id} class={`sug ${s.kind}`}>
            <div class="sug-head">
              <span class="tag">{KIND_LABEL[s.kind]}</span>
              {s.source === "claude" && <span class="tag claude">Claude</span>}
              <span class="muted">{Math.round(s.confidence * 100)}%</span>
            </div>
            <b>{s.title}</b>
            <p>{s.detail}</p>
            {s.part && <p class="muted">Peça: {partName(s.part)}</p>}
            <div class="row">
              {s.patch && <button class="small primary" onClick={() => accept(s)}>Aceitar</button>}
              <button class="small" onClick={() => setSugs(sugs.filter((x) => x.id !== s.id))}>Ignorar</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
