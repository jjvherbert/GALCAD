// Estudo de convergência da malha como parte do modelo de simulação: configura-se no estudo (modo,
// razão, níveis, GCI alvo, grandeza seguida), corre-se com o cálculo, guarda-se no estudo (últimos 6) e
// extraem-se as tabelas, os gráficos e o relatório (CSV, XLSX, JSON, SVG, PNG, HTML).
import { useState } from "preact/hooks";
import { type ConvergenceConfig, DEFAULT_CONVERGENCE, type Study } from "../doc/study.ts";
import { toXLSXSheets } from "../io/table.ts";
import { convergenceChart, errorChart, errorTable, gciTable, levelsTable, metricList, normalizedChart, plannedSizes, reportHtml, setupLines, toCsvText, type Table } from "../sim/convreport.ts";
import { download } from "./fileio.ts";
import { Check, Field, Select } from "./forms.tsx";
import { runConvergence, setConvergence, updateStudy } from "./sim-actions.ts";
import { useStore } from "./store.ts";

const MODE: [string, string][] = [["three", "3 malhas: h, r·h, r²·h"], ["sweep", "Varrimento ±n níveis à volta de h"], ["auto", "Automático: refinar até ao GCI alvo"]];
const slug = (s: string) => s.replace(/[^\wÀ-ÿ-]+/g, "_").replace(/^_+|_+$/g, "") || "estudo";

/** Converte um SVG em texto para PNG (canvas) e descarrega-o. */
async function downloadPng(name: string, svg: string, scale = 2) {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const w = Number(m?.[1] ?? 520), h = Number(m?.[2] ?? 300);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("Não foi possível desenhar o gráfico")); img.src = url; });
  const cv = document.createElement("canvas");
  cv.width = w * scale; cv.height = h * scale;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(url);
  cv.toBlob((b) => { if (b) download(name, b, "image/png"); }, "image/png");
}

function DataTable({ t, caption }: { t: Table; caption: string }) {
  if (!t.rows.length) return null;
  return (
    <div class="conv-table-wrap">
      <table class="conv-table">
        <caption>{caption}</caption>
        <thead><tr>{t.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{t.rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function ConvergencePanel({ s }: { s: Study }) {
  const st = useStore();
  const cfg = { ...DEFAULT_CONVERGENCE, ...s.convergence };
  const runs = s.convergenceRuns ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const [chartKey, setChartKey] = useState<string | null>(null);
  const run = runs.find((r) => r.id === sel) ?? runs[0];
  const report = run?.report;
  const ms = report ? metricList(report) : [];
  const withGci = report ? ms.filter((m) => report.rows.some((x) => x.key === m.key)) : [];
  const lead = chartKey ?? report?.setup?.metric ?? withGci[0]?.key ?? ms[0]?.key ?? "";
  const busy = !!st.simBusy;
  const base = typeof s.mesh.size === "number" ? s.mesh.size : undefined;
  const plan = base ? plannedSizes(base, cfg) : [];
  const lastCells = st.simResult?.studyId === s.id ? st.simResult.result.cells : report?.levels?.find((l) => l.level === 0)?.cells;
  const metricOptions: [string, string][] = [
    ["", s.physics === "fem" ? "1.ª sonda (ou deslocamento máx.)" : "Queda de pressão / arrasto"],
    ...(s.physics === "fem" ? (s.probes ?? []).map((p, i): [string, string] => [`probe${i + 1}`, `Sonda: ${p.name || i + 1}`]) : []),
    ...(s.physics === "fem" ? ([["umax", "Deslocamento máx."], ["vmax", "von Mises máx."], ["f1", "Frequência 1"], ["tmax", "Temperatura máx."]] as [string, string][]) : ([["dp", "Queda de pressão"], ["drag", "Arrasto"], ["cd", "Cd"]] as [string, string][])),
    ...ms.filter((m) => !["umax", "vmax", "f1", "tmax", "dp", "drag", "cd"].includes(m.key) && !m.key.startsWith("probe")).map((m): [string, string] => [m.key, m.label]),
  ];
  const name = slug(`${s.name}-convergencia`);

  const sheets = () => report ? [
    { name: "Malhas", ...levelsTable(report) },
    { name: "GCI", ...gciTable(report) },
    ...(errorTable(report).rows.length ? [{ name: "Erros", ...errorTable(report) }] : []),
    { name: "Pedido e hipóteses", header: ["Item"], rows: [...setupLines(report), ...report.hypotheses].map((x) => [x]) },
  ] : [];
  const html = () => reportHtml({ title: `Convergência da malha — ${s.name}`, study: s.name, solver: run!.solver, date: new Date(run!.at).toLocaleString("pt-PT"), report: report! });

  return (
    <>
      <p class="field-hint">Configure aqui o estudo de convergência da malha: corre com o cálculo (F5) e fica guardado no estudo, com as tabelas, os gráficos e o relatório para extrair. Estimativa de incerteza de discretização (GCI, Celik et al. 2008 / ASME V&V 20), não uma garantia.</p>
      <fieldset class="checklist">
        <legend class="field-label">Configuração</legend>
        <Check label="Correr a convergência com o cálculo (F5)" value={cfg.enabled} onChange={(enabled) => setConvergence({ enabled })} />
        <Select label="Modo" value={cfg.mode} options={MODE} onChange={(mode) => setConvergence({ mode: mode as ConvergenceConfig["mode"], ...(mode === "sweep" && cfg.ratio > 1.4 ? { ratio: 1.35 } : {}), ...(mode === "sweep" ? { levels: Math.min(cfg.levels, 4) } : {}) })} />
        <div class="row">
          <Field label="Razão r"><input type="number" min="1.1" max="3" step="0.05" value={cfg.ratio} onChange={(e) => setConvergence({ ratio: Number((e.target as HTMLInputElement).value) || 1.35 })} /></Field>
          {cfg.mode !== "three" && <Field label={cfg.mode === "sweep" ? "Níveis (cada lado)" : "Máx. malhas"}><input type="number" min={cfg.mode === "sweep" ? 1 : 3} max={cfg.mode === "sweep" ? 4 : 8} value={cfg.levels} onChange={(e) => setConvergence({ levels: Number((e.target as HTMLInputElement).value) || 3 })} /></Field>}
          {cfg.mode === "auto" && <Field label="GCI alvo (%)"><input type="number" min="0.05" max="50" step="0.1" value={cfg.target} onChange={(e) => setConvergence({ target: Number((e.target as HTMLInputElement).value) || 1 })} /></Field>}
        </div>
        <Select label="Grandeza seguida" value={cfg.metric} options={metricOptions} onChange={(metric) => setConvergence({ metric })} />
        {cfg.ratio < 1.3 && <p class="error-text">r &lt; 1,3: o GCI perde fiabilidade (recomendado ≥ 1,3).</p>}
        {plan.length > 0 && (
          <div class="conv-plan" aria-label="Malhas previstas">
            <b>{plan.length} malhas previstas</b>
            <span class="muted"> · tamanhos (mm): {plan.map((p) => `${Number(p.size.toPrecision(3))}`).join(" → ")}{lastCells ? ` · ≈ ${plan.map((p) => Math.round(lastCells * p.relCells).toLocaleString("pt-PT")).join(" → ")} elementos` : ""}</span>
          </div>
        )}
        <div class="row">
          <button class="small primary" disabled={busy || !st.agent.token} onClick={runConvergence}>{busy ? "A calcular…" : "▶ Correr convergência"}</button>
        </div>
        {busy && <div class="sim-progress" role="status"><i />A correr as malhas no agente local…</div>}
        {!st.agent.token && <p class="field-hint">Ligue o agente local (secção «Resolver») para correr.</p>}
      </fieldset>

      {!report && <p class="field-hint">Ainda sem estudos de convergência guardados neste estudo.</p>}
      {report && run && (
        <>
          <div class="row conv-runs">
            <Select label="Estudo guardado" value={run.id} options={runs.map((r) => [r.id, `${new Date(r.at).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" })} · ${{ three: "3 malhas", sweep: "varrimento", auto: "automático" }[r.report.setup?.mode ?? "three"]} · ${r.report.levels?.length ?? r.report.meshes.length} malhas`])} onChange={setSel} />
            <button class="icon" title="Apagar este estudo guardado" aria-label="Apagar o estudo guardado" onClick={() => { if (confirm("Apagar este estudo de convergência guardado?")) { setSel(null); updateStudy(s.id, { convergenceRuns: runs.filter((r) => r.id !== run.id) } as never); } }}>✕</button>
          </div>
          <p class="muted">{setupLines(report).join(" · ")}</p>
          {report.auto && <p class="muted">{report.auto.achieved ? "✓ convergido" : "✗ não convergido"}: {report.auto.stop}</p>}
          {report.sweep && <p class="muted">{report.sweep.monotonic ? "✓ monotónica" : "✗ não monotónica"}{report.sweep.baseError !== undefined ? ` · erro estimado da malha pedida ${(100 * report.sweep.baseError).toFixed(2)} %` : ""}{report.sweep.stop ? ` · ${report.sweep.stop}` : ""}</p>}

          <div class="conv-charts">
            <Select label="Grandeza do gráfico" value={lead} options={ms.map((m): [string, string] => [m.key, `${m.label}${m.unit ? ` (${m.unit})` : ""}`])} onChange={setChartKey} />
            <div class="conv-chart" role="img" aria-label="Grandeza vs. tamanho da malha" dangerouslySetInnerHTML={{ __html: convergenceChart(report, lead) }} />
            {withGci.length > 1 && <div class="conv-chart" aria-label="Grandezas normalizadas" dangerouslySetInnerHTML={{ __html: normalizedChart(report) }} />}
            {errorTable(report).rows.length > 0 && <div class="conv-chart" aria-label="Erro relativo à extrapolação" dangerouslySetInnerHTML={{ __html: errorChart(report) }} />}
          </div>
          <DataTable t={levelsTable(report)} caption="Malhas e resultados (da mais grossa para a mais fina)" />
          <DataTable t={gciTable(report)} caption="GCI por grandeza (três malhas mais finas)" />
          <DataTable t={errorTable(report)} caption="Erro de cada malha vs. extrapolado" />
          <ul class="muted">{report.hypotheses.map((h) => <li key={h}>{h}</li>)}</ul>

          <div class="conv-actions" role="group" aria-label="Extrair">
            <b>Extrair</b>
            <button class="small" onClick={() => download(`${name}-malhas.csv`, toCsvText(levelsTable(report)), "text/csv;charset=utf-8")}>CSV malhas</button>
            <button class="small" onClick={() => download(`${name}-gci.csv`, toCsvText(gciTable(report)), "text/csv;charset=utf-8")}>CSV GCI</button>
            <button class="small" onClick={() => download(`${name}.xlsx`, toXLSXSheets(sheets()) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}>XLSX (todas as tabelas)</button>
            <button class="small" onClick={() => download(`${name}.json`, JSON.stringify({ estudo: s.name, solver: run.solver, data: run.at, configuracao: cfg, relatorio: report }, null, 2), "application/json")}>JSON</button>
            <button class="small" onClick={() => download(`${name}-${lead}.svg`, convergenceChart(report, lead), "image/svg+xml")}>Gráfico SVG</button>
            <button class="small" onClick={() => void downloadPng(`${name}-${lead}.png`, convergenceChart(report, lead))}>Gráfico PNG</button>
            <button class="small" onClick={() => download(`${name}.html`, html(), "text/html;charset=utf-8")}>Relatório HTML</button>
            <button class="small" title="Abre o relatório para imprimir ou guardar em PDF" onClick={() => { const w = window.open("", "_blank"); if (w) { w.document.write(html()); w.document.close(); setTimeout(() => w.print(), 400); } }}>Imprimir / PDF</button>
          </div>
        </>
      )}
    </>
  );
}

