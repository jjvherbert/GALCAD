// Painel de scripts (automação): editor JavaScript com a API cad.*, exemplos gerados a partir do
// modelo, execução num worker isolado com consola em direto, tabelas com CSV, aplicar as alterações
// ao modelo, scripts guardados na peça e copiloto (Claude) para gerar, corrigir e interpretar.
import { useRef, useState } from "preact/hooks";
import { API_DOC, type ScriptOutput, tableCSV } from "../script/api.ts";
import { type CopilotInterpretation, type CopilotScript, copilotInterpret, copilotScript, scriptContext } from "../ai/copilot.ts";
import { store, useStore } from "./store.ts";
import { download } from "./fileio.ts";
import { type ScriptRun, runScriptInWorker } from "./script-client.ts";

function examples(st: ReturnType<typeof useStore>): [string, string][] {
  const v = st.doc.variables[0]?.name ?? "L";
  const val = Number(st.result?.variables.values[v] ?? 100) || 100;
  const fem = (st.doc.studies ?? []).find((s) => s.physics === "fem");
  const sid = fem?.id ?? "s1";
  const probe = fem?.physics === "fem" && fem.probes?.length ? "probe1" : "umax";
  const a = +(val * 0.8).toPrecision(3), b = +(val * 1.2).toPrecision(3);
  return [
    ["Varrimento paramétrico (massa e dimensões)", `// Varre a variável ${v} e regista massa e dimensões
const linhas = [];
for (const ${v} of cad.linspace(${a}, ${b}, 5)) {
  cad.set("${v}", ${v});
  const r = await cad.rebuild();
  if (!r.ok) { cad.log("falhou em ${v} =", ${v}, r.errors[0]?.message); continue; }
  linhas.push({ ${v}, massa_kg: r.measures.massa / 1000, volume_cm3: r.measures.volume / 1000, dimZ: r.measures.dimZ });
}
cad.table(linhas, "Varrimento de ${v}");
return linhas.length;`],
    ["Simulações em série + superfície de resposta", `// Corre o estudo "${fem?.name ?? sid}" para vários valores de ${v} (cada corrida usa o solver real)
const linhas = [];
for (const ${v} of [${a}, ${val}, ${b}]) {
  cad.set("${v}", ${v});
  const r = await cad.rebuild();
  const s = await cad.simulate("${sid}");
  linhas.push({ ${v}, massa_kg: r.measures.massa / 1000, resultado: s.metrics.${probe}, elementos: s.cells });
  cad.log(${v}, s.metrics.${probe});
}
cad.table(linhas, "Estudo paramétrico");
// modelo de ordem reduzida para explorar entre os pontos (verificar sempre com o modelo completo)
const m = cad.surrogate(linhas, ["${v}"], "resultado");
return { previsao_no_meio: m.predict({ ${v}: ${+((a + val) / 2).toPrecision(3)} }), erro_tipico: m.looRmse };`],
    ["Convergência automática da malha", `// Refina a malha até o GCI da grandeza seguida ficar abaixo de 1 %
const s = await cad.simulate("${sid}", { convergence: { ratio: 1.5, target: 0.01, maxLevels: 5 } });
cad.table(s.convergence ?? [], "Convergência");
cad.log(s.warnings.join("\\n"));
return s.convergence?.find((x) => x.key === "${probe}");`],
    ["Verificações do modelo", `// Reconstrói e lista verificações, erros e PMI com problemas
const r = await cad.rebuild();
cad.table(r.checks, "Verificações");
cad.table(r.pmi.filter((p) => p.errors.length), "PMI com erros");
return { ok: r.ok, falhas: r.checks.filter((c) => !c.ok).length, massa_kg: r.measures.massa / 1000 };`],
  ];
}

export function ScriptPanel() {
  const st = useStore();
  const saved = st.doc.scripts ?? [];
  const ex = examples(st);
  const [code, setCode] = useState(saved[0]?.code ?? ex[0][1]);
  const [name, setName] = useState(saved[0]?.name ?? "Script 1");
  const [live, setLive] = useState<string[]>([]);
  const [out, setOut] = useState<ScriptOutput | null>(null);
  const [err, setErr] = useState("");
  const run = useRef<ScriptRun | null>(null);
  const [busy, setBusy] = useState(false);
  // copiloto
  const [apiKey, setApiKey] = useState("");
  const [ask, setAsk] = useState("");
  const [ai, setAi] = useState<CopilotScript | null>(null);
  const [aiRead, setAiRead] = useState<CopilotInterpretation | null>(null);
  const [aiBusy, setAiBusy] = useState("");

  const start = async () => {
    setBusy(true); setLive([]); setOut(null); setErr("");
    const r = runScriptInWorker(code, (line) => setLive((l) => [...l.slice(-499), line]));
    run.current = r;
    try {
      const o = await r.promise;
      setOut(o);
      if (o.error) setErr(o.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      run.current = null;
      setBusy(false);
      store.rebuild();
    }
  };
  const save = () => {
    const next = saved.some((x) => x.name === name) ? saved.map((x) => (x.name === name ? { name, code } : x)) : [...saved, { name, code }];
    store.commitDoc("part", { ...st.doc, scripts: next }, `Guardar script ${name}`, true);
  };
  const context = () => scriptContext(st.doc, st.result?.variables.values ?? {}, st.result?.mass ? { volume: st.result.mass.volume, area: st.result.mass.area } : {});
  const generate = async (fix: boolean) => {
    setAiBusy(fix ? "fix" : "gen"); setAiRead(null);
    try {
      const r = await copilotScript(apiKey.trim(), fix ? ask || "Corrige o script para correr sem erros" : ask, context(), fix ? { code, error: err || out?.error, logs: out?.logs ?? live } : undefined);
      setAi(r);
      setCode(r.code);
    } catch (e) { store.set({ error: (e as Error).message }); } finally { setAiBusy(""); }
  };
  const interpret = async () => {
    if (!out) return;
    setAiBusy("read");
    try { setAiRead(await copilotInterpret(apiKey.trim(), context(), code, out)); } catch (e) { store.set({ error: (e as Error).message }); } finally { setAiBusy(""); }
  };

  return (
    <div class="knowledge-panel script-panel">
      <div class="tree-head">
        <b>Scripts — {st.doc.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null })}>← Árvore</button>
      </div>
      <div class="row">
        <select aria-label="Scripts guardados e exemplos" value="" onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          const s = saved.find((x) => `s:${x.name}` === v);
          const x = ex.find(([t]) => `e:${t}` === v);
          if (s) { setName(s.name); setCode(s.code); } else if (x) { setName(x[0]); setCode(x[1]); }
        }}>
          <option value="">Abrir…</option>
          {saved.length > 0 && <optgroup label="Guardados na peça">{saved.map((x) => <option key={x.name} value={`s:${x.name}`}>{x.name}</option>)}</optgroup>}
          <optgroup label="Exemplos">{ex.map(([t]) => <option key={t} value={`e:${t}`}>{t}</option>)}</optgroup>
        </select>
        <input aria-label="Nome do script" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="small" onClick={save}>Guardar</button>
      </div>
      <textarea class="script-editor" aria-label="Código do script" spellcheck={false} value={code} onInput={(e) => setCode((e.target as HTMLTextAreaElement).value)} />
      <div class="row">
        <button class="small primary" disabled={busy} onClick={() => void start()}>{busy ? "A correr…" : "Correr script"}</button>
        {busy && <button class="small" onClick={() => run.current?.stop()}>Parar</button>}
        <details class="api-doc"><summary>API</summary><pre>{API_DOC}</pre></details>
      </div>
      {(live.length > 0 || err) && <pre class="script-console" aria-label="Consola do script">{live.join("\n")}{err && `\n✗ ${err}`}</pre>}
      {out && (
        <div class={`kw-item ${out.ok ? "ok" : "bad"}`}>
          <b>{out.ok ? "Concluído" : "Terminou com erro"}</b> <span class="muted">· {out.seconds.toFixed(1)} s</span>
          {out.value !== undefined && <pre class="script-value">{JSON.stringify(out.value, null, 1)}</pre>}
          {out.tables.map((t) => (
            <details open key={t.name}>
              <summary>{t.name} ({t.rows.length})</summary>
              <ResultTable rows={t.rows} />
              <button class="small" onClick={() => download(`${t.name.replace(/[^\w-]+/g, "_")}.csv`, tableCSV(t.rows), "text/csv")}>CSV</button>
            </details>
          ))}
          {out.changed && (
            <div class="row">
              <span class="muted">O script alterou a cópia do modelo.</span>
              <button class="small" onClick={() => { store.commitDoc("part", { ...st.doc, ...out.doc }, `Script ${name}`); setOut({ ...out, changed: false }); }}>Aplicar ao modelo</button>
            </div>
          )}
        </div>
      )}
      <details class="claude-box">
        <summary>Copiloto (Claude)</summary>
        <p class="field-hint">Escreva o que quer automatizar; o Claude gera o script com a API e o contexto do modelo (variáveis, features, estudos — sem a geometria). O código fica no editor para rever antes de correr. A chave fica só em memória.</p>
        <input type="password" aria-label="Chave API da Anthropic" placeholder="sk-ant-…" autocomplete="off" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
        <textarea aria-label="Pedido ao copiloto" rows={3} placeholder="Ex.: varre a espessura t de 2 a 6 mm e encontra a mais leve com tensão de von Mises abaixo de 150 MPa" value={ask} onInput={(e) => setAsk((e.target as HTMLTextAreaElement).value)} />
        <div class="row">
          <button class="small" disabled={!apiKey.trim() || !ask.trim() || !!aiBusy} onClick={() => void generate(false)}>{aiBusy === "gen" ? "A gerar…" : "Gerar script"}</button>
          <button class="small" disabled={!apiKey.trim() || !(err || out) || !!aiBusy} onClick={() => void generate(true)}>{aiBusy === "fix" ? "A corrigir…" : "Corrigir com o erro"}</button>
          <button class="small" disabled={!apiKey.trim() || !out?.ok || !!aiBusy} onClick={() => void interpret()}>{aiBusy === "read" ? "A ler…" : "Interpretar resultados"}</button>
        </div>
        {ai && (
          <div class="kw-item">
            <p>{ai.explanation}</p>
            {ai.assumptions.length > 0 && <><b>Hipóteses</b><ul>{ai.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></>}
            {ai.warnings.length > 0 && <><b>Avisos</b><ul>{ai.warnings.map((x) => <li key={x}>{x}</li>)}</ul></>}
          </div>
        )}
        {aiRead && (
          <div class="kw-item">
            <p>{aiRead.summary}</p>
            <b>Observações</b><ul>{aiRead.findings.map((x) => <li key={x}>{x}</li>)}</ul>
            <b>Limites</b><ul>{aiRead.caveats.map((x) => <li key={x}>{x}</li>)}</ul>
            <b>Próximos passos</b><ul>{aiRead.next.map((x) => <li key={x}>{x}</li>)}</ul>
            <p class="field-hint">Leitura assistida por IA: confirmar os números e as conclusões antes de usar.</p>
          </div>
        )}
      </details>
      <p class="field-hint">Os scripts correm num worker sem acesso à rede, ao disco nem à interface; trabalham numa cópia da peça. Em lote: <code>node tools/cad-script.ts projeto.cadp.json script.js</code>.</p>
    </div>
  );
}

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12);
  const f = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : String(+v.toPrecision(6))) : typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
  return (
    <div class="table-scroll">
      <table class="info-table data">
        <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        {rows.slice(0, 500).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{f(r[c])}</td>)}</tr>)}
      </table>
    </div>
  );
}
