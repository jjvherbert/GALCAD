// Painel de knowledgeware da peça ativa (estilo CATIA KWA): regras, verificações, tabela de
// configurações e templates de features (PowerCopy/UDF), com os resultados da última reconstrução.
import { useState } from "preact/hooks";
import type { Check as CheckDef, ConfigTable, Publication, PublishedRef, Rule } from "../doc/types.ts";
import type { FeatureTemplate } from "../doc/project.ts";
import { MEASURE_NAMES, PROP_COL, SUPPRESS_COL, columnLabel, tableFromCSV, tableToCSV } from "../doc/knowledge.ts";
import { FEATURE_LABELS } from "../doc/features.ts";
import { store, useStore } from "./store.ts";
import { download } from "./fileio.ts";
import { Field, RefList, describeName } from "./forms.tsx";

type Tab = "rules" | "checks" | "configs" | "templates" | "pubs";

export function KnowledgePanel() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>("rules");
  return (
    <div class="knowledge-panel">
      <div class="tree-head">
        <b>Conhecimento — {st.doc.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null })}>← Árvore</button>
      </div>
      <div class="row tabs-mini" role="tablist">
        {([["rules", "Regras"], ["checks", "Verificações"], ["configs", "Configurações"], ["templates", "Templates"], ["pubs", "Publicações"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} class={`small ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "rules" && <RulesTab />}
      {tab === "checks" && <ChecksTab />}
      {tab === "configs" && <ConfigsTab />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "pubs" && <PublicationsTab />}
    </div>
  );
}

function RulesTab() {
  const st = useStore();
  const rules = st.doc.rules ?? [];
  const status = st.result?.rules ?? [];
  const vars = st.doc.variables.map((v) => v.name);
  const set = (next: Rule[], label = "Regras") => store.commitDoc("part", { ...st.doc, rules: next }, label, true);
  const up = (i: number, patch: Partial<Rule>) => set(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const assignEditor = (i: number, key: "assign" | "otherwise", label: string) => {
    const list = rules[i][key] ?? [];
    return (
      <fieldset class="checklist">
        <legend class="field-label">{label}</legend>
        {list.map((a, j) => (
          <div class="row" key={j}>
            <select aria-label="Variável" value={a.variable} onChange={(e) => up(i, { [key]: list.map((x, k) => (k === j ? { ...x, variable: (e.target as HTMLSelectElement).value } : x)) })}>
              <option value="">—</option>
              {vars.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>=</span>
            <input aria-label="Expressão" value={a.expr} onChange={(e) => up(i, { [key]: list.map((x, k) => (k === j ? { ...x, expr: (e.target as HTMLInputElement).value } : x)) })} />
            <button class="icon" aria-label="Retirar" onClick={() => up(i, { [key]: list.filter((_, k) => k !== j) })}>✕</button>
          </div>
        ))}
        <button class="small" onClick={() => up(i, { [key]: [...list, { variable: vars[0] ?? "", expr: "0" }] })}>+ atribuição</button>
      </fieldset>
    );
  };
  return (
    <>
      <p class="field-hint">Por ordem: se a condição for verdadeira, as variáveis recebem os valores (as que dependem delas são recalculadas). Ex.: condição <code>L &gt; 100 and t &lt; 3</code>.</p>
      {rules.map((r, i) => {
        const s = status.find((x) => x.name === r.name);
        return (
          <div class="kw-item" key={i}>
            <div class="row">
              <input aria-label="Nome da regra" value={r.name} onChange={(e) => up(i, { name: (e.target as HTMLInputElement).value })} />
              <label class="check"><input type="checkbox" checked={!r.disabled} onChange={(e) => up(i, { disabled: !(e.target as HTMLInputElement).checked })} /> ativa</label>
              <button class="icon" aria-label="Apagar regra" onClick={() => set(rules.filter((_, k) => k !== i), "Apagar regra")}>✕</button>
            </div>
            <Field label="Se (condição; vazia = sempre)"><input aria-label="Condição" value={r.condition ?? ""} onChange={(e) => up(i, { condition: (e.target as HTMLInputElement).value })} /></Field>
            {assignEditor(i, "assign", "Então")}
            {assignEditor(i, "otherwise", "Senão")}
            {s && <p class={s.error ? "error-text" : "muted"}>{s.error ?? (s.fired === null ? "Desativada" : s.fired ? "Condição verdadeira: aplicada" : "Condição falsa")}</p>}
          </div>
        );
      })}
      <button class="small" onClick={() => set([...rules, { name: `Regra${rules.length + 1}`, condition: "", assign: [] }], "Nova regra")}>+ regra</button>
    </>
  );
}

function ChecksTab() {
  const st = useStore();
  const checks = st.doc.checks ?? [];
  const res = st.result?.checks ?? [];
  const set = (next: CheckDef[], label = "Verificações") => store.commitDoc("part", { ...st.doc, checks: next }, label, true);
  const up = (i: number, patch: Partial<CheckDef>) => set(checks.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  return (
    <>
      <p class="field-hint">Expressões que têm de ser verdadeiras depois de cada reconstrução. Além das variáveis: {MEASURE_NAMES.join(", ")} (mm, mm², mm³, g).</p>
      {checks.map((c, i) => {
        const r = res.find((x) => x.name === c.name);
        return (
          <div class={`kw-item ${r ? (r.ok ? "ok" : c.severity) : ""}`} key={i}>
            <div class="row">
              <span class="kw-dot" aria-label={r ? (r.ok ? "Cumpre" : "Não cumpre") : "Sem resultado"}>{r ? (r.ok ? "✓" : "✗") : "·"}</span>
              <input aria-label="Nome da verificação" value={c.name} onChange={(e) => up(i, { name: (e.target as HTMLInputElement).value })} />
              <select aria-label="Gravidade" value={c.severity} onChange={(e) => up(i, { severity: (e.target as HTMLSelectElement).value as CheckDef["severity"] })}>
                <option value="info">Informação</option><option value="warning">Aviso</option><option value="error">Erro</option>
              </select>
              <button class="icon" aria-label="Apagar verificação" onClick={() => set(checks.filter((_, k) => k !== i), "Apagar verificação")}>✕</button>
            </div>
            <Field label="Expressão"><input aria-label="Expressão da verificação" value={c.expr} onChange={(e) => up(i, { expr: (e.target as HTMLInputElement).value })} /></Field>
            <Field label="Mensagem se falhar"><input value={c.message ?? ""} onChange={(e) => up(i, { message: (e.target as HTMLInputElement).value })} /></Field>
            {r && !r.ok && <p class="error-text">{r.error ?? r.message ?? "Não cumpre"}</p>}
          </div>
        );
      })}
      <button class="small" onClick={() => set([...checks, { name: `Verificação${checks.length + 1}`, expr: "massa < 1000", severity: "warning" }], "Nova verificação")}>+ verificação</button>
    </>
  );
}

function ConfigsTab() {
  const st = useStore();
  const t: ConfigTable = st.doc.configurations ?? { columns: [], rows: [] };
  const set = (next: ConfigTable | undefined, label = "Configurações") => store.commitDoc("part", { ...st.doc, configurations: next }, label, true);
  const [col, setCol] = useState("");
  const candidates = [
    ...st.doc.variables.map((v) => [v.name, `Variável ${v.name}`]),
    ...st.doc.features.map((f) => [`${SUPPRESS_COL}${f.id}`, `Suprimir ${f.name}`]),
    ...["number", "description", "material", "density"].map((k) => [`${PROP_COL}${k}`, `Propriedade ${k}`]),
  ].filter(([k]) => !t.columns.includes(k));
  const importCSV = async () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".csv,text/csv";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try { set(tableFromCSV(await f.text(), t.active), "Importar tabela"); } catch (e) { store.set({ error: (e as Error).message }); }
    };
    inp.click();
  };
  return (
    <>
      <p class="field-hint">Cada linha é uma configuração (família de peças). Colunas: variáveis, supressão de features (S = suprimida) e propriedades da peça. Vazio = valor do modelo. Os componentes de uma montagem podem usar configurações diferentes.</p>
      <div class="row">
        <select aria-label="Acrescentar coluna" value={col} onChange={(e) => setCol((e.target as HTMLSelectElement).value)}>
          <option value="">+ coluna…</option>
          {candidates.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button class="small" disabled={!col} onClick={() => { set({ ...t, columns: [...t.columns, col] }); setCol(""); }}>Acrescentar</button>
        <button class="small" onClick={() => {
          const name = `Config${t.rows.length + 1}`;
          set({ ...t, rows: [...t.rows, { name, values: {} }], active: t.active ?? name }, "Nova configuração");
        }}>+ configuração</button>
      </div>
      {t.rows.length > 0 && (
        <div class="bom-scroll">
          <table class="bom-table kw-table">
            <thead><tr><th>Ativa</th><th>Nome</th>{t.columns.map((c) => <th key={c} title={c}>{columnLabel(st.doc, c)} <button class="icon" aria-label={`Retirar coluna ${c}`} onClick={() => set({ ...t, columns: t.columns.filter((x) => x !== c) })}>✕</button></th>)}<th /></tr></thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i}>
                  <td><input type="radio" name="active-config" aria-label={`Ativar ${r.name}`} checked={t.active === r.name} onChange={() => set({ ...t, active: r.name }, `Configuração ${r.name}`)} /></td>
                  <td><input aria-label="Nome da configuração" value={r.name} onChange={(e) => {
                    const name = (e.target as HTMLInputElement).value;
                    set({ ...t, active: t.active === r.name ? name : t.active, rows: t.rows.map((x, k) => (k === i ? { ...x, name } : x)) });
                  }} /></td>
                  {t.columns.map((c) => (
                    <td key={c}><input aria-label={`${r.name}: ${c}`} value={r.values[c] ?? ""} onChange={(e) => set({ ...t, rows: t.rows.map((x, k) => (k === i ? { ...x, values: { ...x.values, [c]: (e.target as HTMLInputElement).value } } : x)) })} /></td>
                  ))}
                  <td><button class="icon" aria-label={`Apagar ${r.name}`} onClick={() => { const rows = t.rows.filter((_, k) => k !== i); set(rows.length ? { ...t, rows, active: t.active === r.name ? rows[0].name : t.active } : undefined, "Apagar configuração"); }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div class="row">
        <button class="small" disabled={!t.rows.length} onClick={() => download(`${st.doc.name}-configuracoes.csv`, "﻿" + tableToCSV(t), "text/csv")}>Exportar CSV</button>
        <button class="small" onClick={() => void importCSV()}>Importar CSV</button>
      </div>
      {st.result?.config && <p class="muted">Configuração aplicada: <b>{st.result.config}</b></p>}
    </>
  );
}

function TemplatesTab() {
  const st = useStore();
  const [sel, setSel] = useState<string[]>([]);
  const [name, setName] = useState("Template1");
  const [inst, setInst] = useState<FeatureTemplate | null>(null);
  const templates = st.project.templates ?? [];
  const importJSON = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try { store.importTemplate(await f.text()); } catch (e) { store.set({ error: (e as Error).message }); }
    };
    inp.click();
  };
  if (inst) return <InstantiateForm tpl={inst} onClose={() => setInst(null)} />;
  return (
    <>
      <p class="field-hint">Um template guarda um grupo de features: as referências a features e faces de fora do grupo passam a entradas (a escolher em cada instância) e as variáveis usadas a parâmetros.</p>
      <fieldset class="checklist">
        <legend class="field-label">Features do novo template</legend>
        {st.doc.features.map((f) => (
          <label key={f.id} class="check">
            <input type="checkbox" checked={sel.includes(f.id)} onChange={(e) => setSel((e.target as HTMLInputElement).checked ? [...sel, f.id] : sel.filter((x) => x !== f.id))} />
            {f.name} <span class="muted">({FEATURE_LABELS[f.type]})</span>
          </label>
        ))}
      </fieldset>
      <div class="row">
        <input aria-label="Nome do template" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="small primary" disabled={!sel.length || !name.trim()} onClick={() => { store.createTemplate(sel, name.trim()); setSel([]); }}>Criar template</button>
      </div>
      <h3>Templates do projeto</h3>
      <ul class="kw-list">
        {templates.map((t) => (
          <li key={t.id}>
            <b>{t.name}</b> <span class="muted">{t.features.length} feature(s) · {t.inputs.length} entrada(s) · {t.parameters.length} parâmetro(s)</span>
            <div class="row">
              <button class="small primary" onClick={() => setInst(t)}>Instanciar…</button>
              <button class="small" onClick={() => download(`${t.name}.cadt.json`, JSON.stringify({ format: "cadp-template", version: 1, template: t }, null, 2), "application/json")}>Exportar</button>
              <button class="small" onClick={() => store.deleteTemplate(t.id)}>Apagar</button>
            </div>
          </li>
        ))}
        {!templates.length && <li class="muted">Nenhum</li>}
      </ul>
      <button class="small" onClick={importJSON}>Importar template…</button>
    </>
  );
}

function InstantiateForm({ tpl, onClose }: { tpl: FeatureTemplate; onClose: () => void }) {
  const st = useStore();
  const [bind, setBind] = useState<Record<string, string>>({});
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(tpl.parameters.map((p) => [p.name, p.expr])));
  return (
    <>
      <h3>Instanciar "{tpl.name}"</h3>
      {tpl.inputs.map((inp) => inp.kind === "feature" ? (
        <Field key={inp.key} label={`${inp.label} (${FEATURE_LABELS[inp.type as keyof typeof FEATURE_LABELS] ?? inp.type})`}>
          <select value={bind[inp.key] ?? ""} onChange={(e) => setBind({ ...bind, [inp.key]: (e.target as HTMLSelectElement).value })}>
            <option value="">— escolher —</option>
            {st.doc.features.filter((f) => f.type === inp.type).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
      ) : (
        <RefList key={inp.key} field={`tpl.${inp.key}`} single label={inp.label} accept={[inp.kind]}
          refs={bind[inp.key] ? [{ kind: inp.kind, name: bind[inp.key] }] : []} onChange={(r) => setBind({ ...bind, [inp.key]: r[0]?.name ?? "" })} />
      ))}
      {tpl.parameters.length > 0 && (
        <fieldset class="checklist">
          <legend class="field-label">Parâmetros (criados como variáveis novas)</legend>
          {tpl.parameters.map((p) => (
            <Field key={p.name} label={p.name}><input value={vals[p.name] ?? ""} onInput={(e) => setVals({ ...vals, [p.name]: (e.target as HTMLInputElement).value })} /></Field>
          ))}
        </fieldset>
      )}
      <div class="row">
        <button class="small primary" disabled={tpl.inputs.some((i) => !bind[i.key])} onClick={() => { if (store.instantiateTemplate(tpl, bind, vals)) onClose(); }}>Instanciar</button>
        <button class="small" onClick={onClose}>Cancelar</button>
      </div>
    </>
  );
}

const PUB_FEATURES = new Set(["plane", "axis", "csys", "sketch", "curve", "surfaceExtrude", "surfaceRevolve", "surfaceSweep", "surfaceLoft", "boundary", "fill", "ruled", "offsetSurface", "knit", "multiSection", "blend", "circleSweep", "freeform"]);

function PublicationsTab() {
  const st = useStore();
  const pubs = st.doc.publications ?? [];
  const [name, setName] = useState("");
  const [feat, setFeat] = useState("");
  const add = (ref: PublishedRef, fallback: string) => {
    const base = (name.trim() || fallback).replace(/\s+/g, "_");
    let nm = base, k = 2;
    while (pubs.some((p) => p.name === nm)) nm = `${base}_${k++}`;
    store.setPublications([...pubs, { name: nm, ref }], `Publicar ${nm}`);
    setName("");
  };
  const label = (p: Publication) => p.ref.kind === "body" ? "Corpo sólido" : p.ref.kind === "feature" ? st.doc.features.find((f) => f.id === (p.ref as { feature: string }).feature)?.name ?? "?" : describeName(st.doc, p.ref.name);
  const users = (n: string) => st.project.parts.filter((p) => p.features.some((f) => f.type === "external" && f.part === st.doc.id && f.publication === n)).map((p) => p.name);
  return (
    <>
      <p class="field-hint">A geometria publicada tem um nome estável: outras peças copiam-na (Referência externa) e os mates referem-na por esse nome, mesmo que a topologia interna mude.</p>
      <Field label="Nome da publicação"><input value={name} placeholder="ex.: Furo_fixação" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></Field>
      <RefList field="pub.pick" single label="Publicar face ou aresta" accept={["face", "edge"]} refs={[]} onChange={(r) => { if (r[0]) add(r[0], r[0].kind === "face" ? "Face" : "Aresta"); }} />
      <div class="row">
        <select aria-label="Feature a publicar" value={feat} onChange={(e) => setFeat((e.target as HTMLSelectElement).value)}>
          <option value="">Publicar feature…</option>
          {st.doc.features.filter((f) => PUB_FEATURES.has(f.type)).map((f) => <option key={f.id} value={f.id}>{f.name} ({FEATURE_LABELS[f.type]})</option>)}
        </select>
        <button class="small" disabled={!feat} onClick={() => { add({ kind: "feature", feature: feat }, st.doc.features.find((f) => f.id === feat)?.name ?? feat); setFeat(""); }}>Publicar</button>
        <button class="small" onClick={() => add({ kind: "body" }, "Corpo")}>Publicar corpo</button>
      </div>
      <ul class="kw-list">
        {pubs.map((p, i) => (
          <li key={p.name}>
            <div class="row">
              <input aria-label="Nome" value={p.name} onChange={(e) => store.setPublications(pubs.map((x, k) => (k === i ? { ...x, name: (e.target as HTMLInputElement).value.replace(/\s+/g, "_") } : x)))} />
              <button class="icon" aria-label={`Retirar ${p.name}`} onClick={() => store.setPublications(pubs.filter((_, k) => k !== i), "Retirar publicação")}>✕</button>
            </div>
            <span class="muted">{label(p)}{users(p.name).length ? ` · usada por ${users(p.name).join(", ")}` : ""}</span>
          </li>
        ))}
        {!pubs.length && <li class="muted">Nenhuma</li>}
      </ul>
    </>
  );
}
