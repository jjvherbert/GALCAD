// Resultados do painel de simulação: exportação, progresso do trabalho, histórias no tempo, qualidade da malha e convergência.
import { useState } from "preact/hooks";
import { useStoreKeys } from "./store.ts";
import { download } from "./fileio.ts";
import { fmt, toCsvText, type Table } from "../sim/convreport.ts";
import { cancelActiveStudy } from "./sim-actions.ts";
import { Select } from "./forms.tsx";
import { type RunResult, resultView } from "./sim-client.ts";
import { fieldRange } from "../sim/result.ts";

/** Extrair os resultados do cálculo: resumo, histórias no tempo, métricas, qualidade da malha e JSON. */
export function ResultExports({ r, name }: { r: RunResult; name: string }) {
  const base = name.replace(/[^\wÀ-ÿ-]+/g, "_").replace(/^_+|_+$/g, "") || "estudo";
  const csv = (file: string, t: Table) => download(`${base}-${file}.csv`, toCsvText(t), "text/csv;charset=utf-8");
  const th = r.fem?.timeHistory;
  return (
    <div class="conv-actions" role="group" aria-label="Extrair os resultados">
      <b>Extrair</b>
      <button class="small" onClick={() => csv("resumo", { header: ["Grandeza", "Valor"], rows: r.summary.map(([k, v]) => [k, v]) })}>Resumo CSV</button>
      <button class="small" onClick={() => csv("metricas", { header: ["Chave", "Grandeza", "Unidade", "Valor"], rows: r.metrics.map((m) => [m.key, m.label, m.unit, fmt(m.value)]) })}>Métricas CSV</button>
      {th && <button class="small" onClick={() => csv("historias", { header: ["Tempo (s)", ...th.series.map((x) => `${x.label}${x.unit ? ` (${x.unit})` : ""}`)], rows: th.times.map((t, i) => [fmt(t, 8), ...th.series.map((x) => fmt(x.values[i]))]) })}>Histórias no tempo CSV</button>}
      {r.quality && <button class="small" onClick={() => csv("qualidade", { header: ["Métrica", "Unidade", "Mín.", "Média", "Máx.", "Elementos fora do limite"], rows: r.quality!.metrics.map((m) => [m.label, m.unit, fmt(m.min), fmt(m.mean), fmt(m.max), m.fail.join(" / ")]) })}>Qualidade CSV</button>}
      <button class="small" onClick={() => download(`${base}-resultados.json`, JSON.stringify({ solver: r.solver, segundos: r.seconds, resumo: r.summary, metricas: r.metrics, avisos: r.warnings, hipoteses: r.hypotheses, elementos: r.cells }, null, 2), "application/json")}>JSON</button>
    </div>
  );
}

/** Trabalho em curso no agente: o que está a fazer, tempo decorrido, Parar e a cauda do registo do solver. */
export function JobProgress() {
  const st = useStoreKeys("simProgress", "simBusy");
  const [stopping, setStopping] = useState(false);
  const p = st.simProgress;
  const stop = async () => {
    setStopping(true);
    try { await cancelActiveStudy(); } finally { setStopping(false); }
  };
  return (
    <div class="sim-job" role="status">
      <div class="sim-progress">
        <i />
        <span>{st.simBusy === "mesh" ? "A gerar a malha…" : "A calcular no agente local…"}{p ? ` ${Math.round(p.elapsed)} s` : ""}</span>
        <button class="small danger" disabled={stopping} onClick={() => void stop()}>{stopping ? "A parar…" : "Parar"}</button>
      </div>
      {p?.tail && <pre class="sim-tail" aria-label="Registo do solver">{p.tail.split("\n").slice(-8).join("\n")}</pre>}
    </div>
  );
}

/** Histórias no tempo da dinâmica (deslocamento máx. e sondas). */
export function TimePlot({ h }: { h: NonNullable<NonNullable<RunResult["fem"]>["timeHistory"]> }) {
  const [k, setK] = useState(h.series.length > 1 ? 1 : 0);
  const s = h.series[Math.min(k, h.series.length - 1)];
  const pts = h.times.map((t, i) => [t, s.values[i]] as const).filter(([, v]) => Number.isFinite(v));
  if (!pts.length) return null;
  const W = 260, H = 120, P = 30;
  const t1 = Math.max(...pts.map((p) => p[0])) || 1, v0 = Math.min(0, ...pts.map((p) => p[1])), v1 = Math.max(0, ...pts.map((p) => p[1]));
  const X = (t: number) => P + (t / t1) * (W - P - 6), Y = (v: number) => H - 18 - ((v - v0) / (v1 - v0 || 1)) * (H - 30);
  return (
    <details open class="history">
      <summary>Resposta no tempo</summary>
      {h.series.length > 1 && <Select label="Série" value={String(k)} options={h.series.map((x, i) => [String(i), `${x.label} (${x.unit})`])} onChange={(x) => setK(Number(x))} />}
      <svg class="conv-plot time-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Resposta no tempo">
        <line x1={P} y1={Y(0)} x2={W - 4} y2={Y(0)} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 18} class="axis" />
        <polyline points={pts.map(([t, v]) => `${X(t)},${Y(v)}`).join(" ")} class="curve" />
        <text x={P} y={H - 4}>0</text>
        <text x={W - 6} y={H - 4} text-anchor="end">{num(t1 * 1e3)} ms</text>
        <text x={P - 3} y={Y(v1) + 3} text-anchor="end">{num(v1)}</text>
        <text x={P - 3} y={Y(v0) + 3} text-anchor="end">{num(v0)}</text>
      </svg>
    </details>
  );
}

/** Relatório de qualidade da malha (pré-visualização): métricas, limites, histograma e piores elementos. */
export function QualityReport({ q }: { q: NonNullable<RunResult["quality"]> }) {
  const lim = (l: { min?: number; max?: number }) => (l.min !== undefined ? `≥ ${l.min}` : `≤ ${l.max}`);
  const sj = q.metrics.find((x) => x.key === "sj");
  const peak = sj ? Math.max(...sj.hist.counts, 1) : 1;
  return (
    <details open class="quality">
      <summary>Qualidade da malha {q.ok ? "" : "— com elementos inválidos"}</summary>
      <table class="info-table">
        <tr><td>Métrica</td><td>mín. · média · máx. — fora dos limites</td></tr>
        {q.metrics.map((x) => (
          <tr key={x.key}>
            <td>{x.label}</td>
            <td>{x.min.toPrecision(3)} · {x.mean.toPrecision(3)} · {x.max.toPrecision(3)}{x.unit} — {x.limits.map((l, i) => <span key={i} class={x.fail[i] ? "error-text" : ""}>{lim(l)}: {x.fail[i]}{i < x.limits.length - 1 ? "; " : ""}</span>)}</td>
          </tr>
        ))}
      </table>
      {sj && (
        <div class="histogram" aria-label="Histograma do jacobiano escalado">
          {sj.hist.counts.map((n, i) => <div key={i} class="bar" title={`${sj.hist.edges[i].toFixed(2)}–${sj.hist.edges[i + 1].toFixed(2)}: ${n}`} style={{ height: `${(100 * n) / peak}%` }} />)}
        </div>
      )}
      {sj && <p class="muted">Jacobiano escalado de {sj.hist.edges[0].toFixed(1)} a 1 (1 = elemento perfeito)</p>}
      {q.worst.length > 0 && <p class="muted">Piores elementos: {q.worst.slice(0, 5).map((w) => `n.º ${w.element} (J = ${w.sj.toFixed(2)}, em ${w.center.map((v) => v.toFixed(1)).join(", ")} mm)`).join("; ")}</p>}
      <p class="field-hint">Limites por omissão: ângulos das faces, razão de aspeto e fator de forma como no Verify Mesh do Abaqus/CAE; jacobiano e empeno como no Femap. Elementos assinalados longe das zonas de interesse costumam ser aceitáveis.</p>
    </details>
  );
}

export const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)} %` : "—");
export const num = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : x.toPrecision(5)) : "—");
export const BEHAVIOUR = { monotonic: "monotónica", oscillatory: "oscilatória", divergent: "divergente", converged: "convergida", invalid: "inválida" } as const;

export function SimLegend() {
  const st = useStoreKeys("simResult", "simView");
  const view = resultView(st.simResult?.result);
  const f = view?.fields[st.simView.field];
  const range = view ? fieldRange(view, st.simView.field, st.simView.hidden) : null;
  if (!f || !range) return null;
  const fmt = (x: number) => (Math.abs(x) >= 1000 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : x.toFixed(3));
  return (
    <>
      <div class={f.reverse ? "legend sequential reverse" : "legend sequential"} />
      <div class="legend-labels"><span>{fmt(range[0])}</span><span>{f.unit}</span><span>{fmt(range[1])}</span></div>
    </>
  );
}

/** Refinamento automático: valor da grandeza por nível contra o tamanho de malha, com o extrapolado. */
/** Varrimento ±n níveis: valor por malha (h = (1/N)^⅓), extrapolado, monotonia e erro da malha pedida. */
export function SweepPlot({ sw, ext, label }: { sw: NonNullable<NonNullable<RunResult["convergence"]>["sweep"]>; ext?: number; label: string }) {
  const pts = sw.steps.filter((x) => Number.isFinite(x.value));
  if (!pts.length) return null;
  const W = 260, H = 120, P = 28;
  const hs = pts.map((x) => (1 / x.cells) ** (1 / 3));
  const vs = [...pts.map((x) => x.value), ...(ext !== undefined && Number.isFinite(ext) ? [ext] : [])];
  const h1 = Math.max(...hs) * 1.05, v0 = Math.min(...vs), v1 = Math.max(...vs);
  const X = (h: number) => P + (h / (h1 || 1)) * (W - P - 6), Y = (v: number) => H - 18 - ((v - v0) / (v1 - v0 || 1)) * (H - 30);
  return (
    <>
      <p class="muted">{label}: {sw.monotonic ? "✓ monotónica" : "✗ não monotónica"}{sw.baseError !== undefined ? ` · erro estimado da malha pedida ${pct(sw.baseError)}` : ""}{sw.stop ? ` · ${sw.stop}` : ""}</p>
      <svg class="conv-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Varrimento da malha">
        <line x1={P} y1={H - 18} x2={W - 4} y2={H - 18} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 18} class="axis" />
        {ext !== undefined && Number.isFinite(ext) && <line x1={P} x2={W - 4} y1={Y(ext)} y2={Y(ext)} class="ext" />}
        <polyline points={pts.map((x, i) => `${X(hs[i])},${Y(x.value)}`).join(" ")} class="curve" />
        {pts.map((x, i) => <circle key={i} cx={X(hs[i])} cy={Y(x.value)} r={x.level === 0 ? 4 : 2.5} class={x.level === 0 ? "base" : ""} />)}
        <text x={P} y={H - 4}>0</text>
        <text x={W - 6} y={H - 4} text-anchor="end">h = (1/N)^⅓</text>
        <text x={P - 3} y={Y(v1) + 3} text-anchor="end">{num(v1)}</text>
        <text x={P - 3} y={Y(v0) + 3} text-anchor="end">{num(v0)}</text>
      </svg>
      <table class="info-table sweep">
        <tr><td>Nível · tamanho</td><td>Elementos · valor</td></tr>
        {sw.steps.map((x) => <tr key={x.level} class={x.level === 0 ? "base" : ""}><td>{x.level > 0 ? `+${x.level}` : x.level}{x.level === 0 ? " (pedida)" : ""} · {num(x.size)} mm</td><td>{x.cells} · {num(x.value)}</td></tr>)}
      </table>
    </>
  );
}

export function ConvergencePlot({ auto, ext, label }: { auto: NonNullable<NonNullable<RunResult["convergence"]>["auto"]>; ext?: number; label: string }) {
  const pts = auto.steps.filter((x) => Number.isFinite(x.value));
  if (!pts.length) return null;
  const W = 260, H = 120, P = 28;
  const hs = pts.map((x) => (1 / x.cells) ** (1 / 3));
  const vs = [...pts.map((x) => x.value), ...(ext !== undefined && Number.isFinite(ext) ? [ext] : [])];
  const h0 = 0, h1 = Math.max(...hs) * 1.05, v0 = Math.min(...vs), v1 = Math.max(...vs);
  const X = (h: number) => P + ((h - h0) / (h1 - h0 || 1)) * (W - P - 6), Y = (v: number) => H - 18 - ((v - v0) / (v1 - v0 || 1)) * (H - 30);
  return (
    <>
      <p class="muted">{auto.achieved ? "✓ convergido" : "✗ não convergido"}: {auto.stop} · {label}</p>
      <svg class="conv-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Convergência da malha">
        <line x1={P} y1={H - 18} x2={W - 4} y2={H - 18} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 18} class="axis" />
        {ext !== undefined && Number.isFinite(ext) && <line x1={P} x2={W - 4} y1={Y(ext)} y2={Y(ext)} class="ext" />}
        <polyline points={pts.map((x, i) => `${X(hs[i])},${Y(x.value)}`).join(" ")} class="curve" />
        {pts.map((x, i) => <circle key={i} cx={X(hs[i])} cy={Y(x.value)} r="2.5" />)}
        <text x={P} y={H - 4}>0</text>
        <text x={W - 6} y={H - 4} text-anchor="end">h = (1/N)^⅓</text>
        <text x={P - 3} y={Y(v1) + 3} text-anchor="end">{num(v1)}</text>
        <text x={P - 3} y={Y(v0) + 3} text-anchor="end">{num(v0)}</text>
      </svg>
      <table class="info-table">
        <tr><td>Nível · tamanho</td><td>Elementos · valor · GCI</td></tr>
        {auto.steps.map((x) => <tr key={x.level}><td>{x.level} · {num(x.size)} mm</td><td>{x.cells} · {num(x.value)} · {x.gci !== undefined ? pct(x.gci) : "—"}</td></tr>)}
      </table>
    </>
  );
}
