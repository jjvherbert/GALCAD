// Tabelas, gráficos e relatório de um estudo de convergência da malha, a partir do `ConvergenceReport`.
// Tudo puro e em texto (CSV, SVG, HTML): as mesmas funções alimentam o painel, as exportações (CSV, XLSX,
// SVG, PNG) e o relatório. Os valores vêm do relatório; nada é recalculado aqui além do que já está nele
// (erro relativo à extrapolação de Richardson, GCI de cada nível).
import type { ConvergenceConfig } from "../doc/study.ts";
import type { ConvergenceLevel, ConvergenceReport } from "./convergence.ts";

export interface Table { header: string[]; rows: string[][] }

/** Número em decimal (vírgula, sem expoente) com algarismos significativos; vazio se não for finito. */
export function fmt(x: number | undefined, sig = 6): string {
  if (x === undefined || !Number.isFinite(x)) return "";
  if (x === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const dec = Math.min(15, Math.max(0, sig - 1 - mag));
  return Number(x.toFixed(dec)).toString().replace(".", ",");
}
export const pct = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? "" : fmt(100 * x, Math.max(2, d + 1)));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tamanhos de malha previstos (mm) do estudo configurado, da mais grossa para a mais fina; a estimativa dos elementos escala com h⁻³. */
export function plannedSizes(base: number, c: Pick<ConvergenceConfig, "mode" | "ratio" | "levels">): { level: number; size: number; relCells: number }[] {
  const r = c.ratio;
  const ks = c.mode === "three" ? [2, 1, 0] : c.mode === "sweep" ? Array.from({ length: 2 * c.levels + 1 }, (_, i) => c.levels - i) : Array.from({ length: c.levels }, (_, k) => -k);
  return ks.map((k) => ({ level: k, size: base * r ** k, relCells: r ** (-3 * k) }));
}

/** Grandezas registadas (ordem estável: a das malhas mais finas). */
export function metricList(r: ConvergenceReport): { key: string; label: string; unit: string }[] {
  const seen = new Map<string, { key: string; label: string; unit: string }>();
  for (const l of [...(r.levels ?? [])].reverse()) for (const m of l.metrics) if (!seen.has(m.key)) seen.set(m.key, { key: m.key, label: m.label, unit: m.unit });
  if (!seen.size) for (const row of r.rows) seen.set(row.key, { key: row.key, label: row.label, unit: row.unit });
  return [...seen.values()];
}

const levelName = (l: ConvergenceLevel) => (l.level === 0 ? "0 (pedida)" : l.level > 0 ? `+${l.level}` : `${l.level}`);
const valueOf = (l: ConvergenceLevel, key: string) => l.metrics.find((m) => m.key === key)?.value;

/** Tabela das malhas: nível, tamanho, elementos, tempo e todas as grandezas. */
export function levelsTable(r: ConvergenceReport): Table {
  const ms = metricList(r);
  return {
    header: ["Nível", "Tamanho (mm)", "Elementos", "Tempo (s)", ...ms.map((m) => `${m.label}${m.unit ? ` (${m.unit})` : ""}`)],
    rows: (r.levels ?? []).map((l) => [levelName(l), fmt(l.size, 4), String(l.cells), fmt(l.seconds, 3), ...ms.map((m) => fmt(valueOf(l, m.key)))]),
  };
}

/** Tabela do GCI por grandeza (três malhas mais finas): ordem aparente, extrapolado, GCI e comportamento. */
export function gciTable(r: ConvergenceReport): Table {
  const BEH = { monotonic: "monotónica", oscillatory: "oscilatória", divergent: "divergente", converged: "convergida" } as const;
  return {
    header: ["Grandeza", "Unidade", "Fina", "Média", "Grossa", "Ordem aparente p", "Extrapolado (Richardson)", "Erro aprox. (%)", "Erro extrapolado (%)", "GCI fina (%)", "Razão assintótica", "Comportamento", "Notas"],
    rows: r.rows.map((x) => [x.label, x.unit, fmt(x.values[0]), fmt(x.values[1]), fmt(x.values[2]), fmt(x.gci.p, 4), fmt(x.gci.extrapolated), pct(x.gci.ea21), pct(x.gci.eext21), pct(x.gci.gciFine), fmt(x.gci.asymptotic, 3), BEH[x.gci.behaviour], x.gci.notes.join(" · ")]),
  };
}

/** Extrapolado (Richardson) de uma grandeza, se o relatório o tiver. */
export const extrapolated = (r: ConvergenceReport, key: string) => r.rows.find((x) => x.key === key)?.gci.extrapolated;

/** Erro relativo de cada malha à extrapolação de Richardson, por grandeza (vazio sem extrapolado). */
export function errorTable(r: ConvergenceReport): Table {
  const ms = metricList(r).filter((m) => Number.isFinite(extrapolated(r, m.key) ?? NaN));
  return {
    header: ["Nível", "Elementos", ...ms.map((m) => `${m.label} — erro vs. extrapolado (%)`)],
    rows: (r.levels ?? []).map((l) => [levelName(l), String(l.cells), ...ms.map((m) => { const v = valueOf(l, m.key), e = extrapolated(r, m.key)!; return v === undefined || e === 0 ? "" : pct(Math.abs((v - e) / e), 3); })]),
  };
}

/** Pedidos/hipóteses do estudo, em linhas «chave: valor», para o cabeçalho das exportações. */
export function setupLines(r: ConvergenceReport): string[] {
  const s = r.setup;
  const MODE = { three: "3 malhas (h, r·h, r²·h)", sweep: "Varrimento ±n níveis", auto: "Refinamento automático até ao GCI alvo" } as const;
  return [
    s ? `Modo: ${MODE[s.mode]}` : "",
    `Razão de refinamento r = ${r.ratio}`,
    s?.levels ? `${s.mode === "sweep" ? "Níveis para cada lado" : "Máx. de malhas"}: ${s.levels}` : "",
    s?.target !== undefined ? `GCI alvo: ${(100 * s.target).toFixed(2)} %` : "",
    s?.metric ? `Grandeza seguida: ${s.metric}` : "",
  ].filter(Boolean);
}

export function toCsvText(t: Table, sep = ";"): string {
  const q = (v: string) => (v.includes(sep) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + [t.header, ...t.rows].map((row) => row.map(q).join(sep)).join("\r\n") + "\r\n";
}

// --- gráficos (SVG em texto) ----------------------------------------------------------

export const PALETTE = ["#018a8a", "#0a2464", "#f59e0b", "#9333ea", "#dc2626", "#2563eb", "#16a34a", "#64748b"];

interface Axis { lo: number; hi: number; log: boolean }
const niceTicks = (a: Axis, n = 4): number[] => {
  if (a.log) {
    const e0 = Math.ceil(Math.log10(a.lo)), e1 = Math.floor(Math.log10(a.hi));
    const out: number[] = [];
    for (let e = e0; e <= e1; e++) out.push(10 ** e);
    if (out.length >= 2) return out;
  }
  return Array.from({ length: n + 1 }, (_, i) => a.lo + ((a.hi - a.lo) * i) / n);
};
const tickLabel = (v: number) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : Number(v.toPrecision(4)).toString());

interface ChartOpts {
  title: string; xLabel: string; yLabel: string; logX?: boolean; logY?: boolean;
  series: { name: string; color: string; pts: { x: number; y: number; big?: boolean }[]; dashed?: boolean }[];
  /** Linha horizontal (extrapolado) e faixa ± em torno dela. */
  ref?: { y: number; label: string; band?: number };
  width?: number; height?: number; legend?: boolean;
}

/** Gráfico de linhas com eixos, grelha, legenda, linha de referência e faixa (SVG em texto autónomo). */
export function chartSvg(o: ChartOpts): string {
  const W = o.width ?? 520, H = o.height ?? 300, L = 62, R = o.legend ? 138 : 16, T = 30, B = 46;
  const all = o.series.flatMap((s) => s.pts).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!o.logX || p.x > 0) && (!o.logY || p.y > 0));
  if (!all.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#64748b">Sem dados para o gráfico</text></svg>`;
  const ys = all.map((p) => p.y);
  if (o.ref && Number.isFinite(o.ref.y)) { ys.push(o.ref.y); if (o.ref.band) ys.push(o.ref.y * (1 + o.ref.band), o.ref.y * (1 - o.ref.band)); }
  const xs = all.map((p) => p.x);
  const pad = (lo: number, hi: number, log: boolean): Axis => {
    if (log) return { lo: lo / 1.25, hi: hi * 1.25, log };
    const d = (hi - lo) || Math.abs(hi) * 0.1 || 1;
    return { lo: lo - d * 0.12, hi: hi + d * 0.12, log };
  };
  const ax = pad(Math.min(...xs), Math.max(...xs), !!o.logX), ay = pad(Math.min(...ys), Math.max(...ys), !!o.logY);
  const px = (v: number) => L + ((ax.log ? Math.log(v / ax.lo) / Math.log(ax.hi / ax.lo) : (v - ax.lo) / (ax.hi - ax.lo)) * (W - L - R));
  const py = (v: number) => H - B - (ay.log ? Math.log(v / ay.lo) / Math.log(ay.hi / ay.lo) : (v - ay.lo) / (ay.hi - ay.lo)) * (H - T - B);
  const xt = niceTicks(ax, 5), yt = niceTicks(ay, 4);
  const f = (n: number) => n.toFixed(1);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Montserrat, Segoe UI, sans-serif" role="img" aria-label="${esc(o.title)}">`, `<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  out.push(`<text x="${L}" y="18" font-size="13" font-weight="700" fill="#0a2464">${esc(o.title)}</text>`);
  for (const v of yt) out.push(`<line x1="${L}" x2="${W - R}" y1="${f(py(v))}" y2="${f(py(v))}" stroke="#e2e8f0"/><text x="${L - 6}" y="${f(py(v) + 3)}" font-size="10" text-anchor="end" fill="#475569">${tickLabel(v)}</text>`);
  for (const v of xt) out.push(`<line y1="${T}" y2="${H - B}" x1="${f(px(v))}" x2="${f(px(v))}" stroke="#f1f5f9"/><text x="${f(px(v))}" y="${H - B + 14}" font-size="10" text-anchor="middle" fill="#475569">${tickLabel(v)}</text>`);
  out.push(`<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#64748b"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#64748b"/>`);
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#334155">${esc(o.xLabel)}</text>`);
  out.push(`<text transform="translate(13 ${(T + H - B) / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#334155">${esc(o.yLabel)}</text>`);
  if (o.ref && Number.isFinite(o.ref.y)) {
    if (o.ref.band) out.push(`<rect x="${L}" y="${f(py(o.ref.y * (1 + o.ref.band)))}" width="${W - L - R}" height="${f(Math.abs(py(o.ref.y * (1 - o.ref.band)) - py(o.ref.y * (1 + o.ref.band))))}" fill="#018a8a" opacity=".12"/>`);
    out.push(`<line x1="${L}" x2="${W - R}" y1="${f(py(o.ref.y))}" y2="${f(py(o.ref.y))}" stroke="#018a8a" stroke-dasharray="5 4"/><text x="${W - R - 4}" y="${f(py(o.ref.y) - 5)}" font-size="10" text-anchor="end" fill="#018a8a">${esc(o.ref.label)}</text>`);
  }
  o.series.forEach((s) => {
    const pts = s.pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!o.logX || p.x > 0) && (!o.logY || p.y > 0)).sort((a, b) => a.x - b.x);
    if (pts.length > 1) out.push(`<polyline fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="4 3"' : ""} points="${pts.map((p) => `${f(px(p.x))},${f(py(p.y))}`).join(" ")}"/>`);
    for (const p of pts) out.push(`<circle cx="${f(px(p.x))}" cy="${f(py(p.y))}" r="${p.big ? 5.5 : 3.5}" fill="${p.big ? "#ffffff" : s.color}" stroke="${s.color}" stroke-width="2"/>`);
  });
  if (o.legend) o.series.forEach((s, i) => out.push(`<rect x="${W - R + 12}" y="${T + 4 + i * 17}" width="12" height="3" fill="${s.color}"/><text x="${W - R + 30}" y="${T + 9 + i * 17}" font-size="10" fill="#334155">${esc(s.name.length > 17 ? s.name.slice(0, 16) + "…" : s.name)}</text>`));
  out.push("</svg>");
  return out.join("");
}

/** Pontos (tamanho da malha, valor) de uma grandeza; o nível pedido (0) vai em destaque. */
const pointsOf = (r: ConvergenceReport, key: string) => (r.levels ?? []).flatMap((l) => { const y = valueOf(l, key); return y === undefined ? [] : [{ x: l.size, y, big: l.level === 0 }]; });

/** Valor da grandeza vs. tamanho da malha (eixo x logarítmico), com o extrapolado e a faixa do GCI. */
export function convergenceChart(r: ConvergenceReport, key: string): string {
  const m = metricList(r).find((x) => x.key === key);
  const row = r.rows.find((x) => x.key === key);
  const ext = row?.gci.extrapolated;
  return chartSvg({
    title: `${m?.label ?? key} vs. tamanho da malha`, xLabel: "Tamanho da malha (mm, escala logarítmica)", yLabel: `${m?.label ?? key}${m?.unit ? ` (${m.unit})` : ""}`, logX: true,
    series: [{ name: m?.label ?? key, color: PALETTE[0], pts: pointsOf(r, key) }],
    ref: ext !== undefined && Number.isFinite(ext) ? { y: ext, label: `extrapolado ${fmt(ext, 5)}${row && Number.isFinite(row.gci.gciFine) ? ` · GCI ${pct(row.gci.gciFine)} %` : ""}`, band: row && Number.isFinite(row.gci.gciFine) ? row.gci.gciFine : undefined } : undefined,
  });
}

/** Todas as grandezas normalizadas pelo valor extrapolado (ou pelo da malha mais fina): 1 = convergido. */
export function normalizedChart(r: ConvergenceReport): string {
  const ms = metricList(r).slice(0, 8);
  const fine = (r.levels ?? []).at(-1);
  const series = ms.flatMap((m, i) => {
    const ref = extrapolated(r, m.key) ?? (fine ? valueOf(fine, m.key) : undefined);
    if (ref === undefined || !Number.isFinite(ref) || ref === 0) return [];
    return [{ name: m.label, color: PALETTE[i % PALETTE.length], pts: (r.levels ?? []).flatMap((l) => { const v = valueOf(l, m.key); return v === undefined ? [] : [{ x: l.cells, y: v / ref, big: l.level === 0 }]; }) }];
  });
  return chartSvg({ title: "Grandezas normalizadas pelo valor convergido", xLabel: "Elementos (escala logarítmica)", yLabel: "valor / convergido", logX: true, series, ref: { y: 1, label: "convergido", band: 0.01 }, legend: true, width: 600 });
}

/** Erro relativo à extrapolação de cada malha, por grandeza, em escala logarítmica. */
export function errorChart(r: ConvergenceReport): string {
  const ms = metricList(r).filter((m) => Number.isFinite(extrapolated(r, m.key) ?? NaN)).slice(0, 8);
  const series = ms.map((m, i) => {
    const e = extrapolated(r, m.key)!;
    return { name: m.label, color: PALETTE[i % PALETTE.length], pts: (r.levels ?? []).flatMap((l) => { const v = valueOf(l, m.key); const err = v === undefined || e === 0 ? NaN : Math.abs((v - e) / e) * 100; return Number.isFinite(err) && err > 0 ? [{ x: l.cells, y: err, big: l.level === 0 }] : []; }) };
  });
  return chartSvg({ title: "Erro relativo à extrapolação de Richardson", xLabel: "Elementos (escala logarítmica)", yLabel: "erro (%, escala logarítmica)", logX: true, logY: true, series, legend: true, width: 600 });
}

// --- relatório HTML -------------------------------------------------------------------

const tableHtml = (t: Table, caption: string) => `<table><caption>${esc(caption)}</caption><thead><tr>${t.header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

/** Relatório autónomo (HTML) do estudo de convergência: pedido, tabelas, gráficos, hipóteses e limites. */
export function reportHtml(opts: { title: string; study: string; solver: string; date: string; report: ConvergenceReport; hypotheses?: string[] }): string {
  const r = opts.report;
  const ms = metricList(r);
  const lead = (r.setup?.metric && ms.find((m) => m.key === r.setup!.metric)) || ms.find((m) => r.rows.some((x) => x.key === m.key)) || ms[0];
  return `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8"><title>${esc(opts.title)}</title><style>
body{font:13px/1.45 Montserrat,Segoe UI,sans-serif;color:#0f172a;max-width:980px;margin:24px auto;padding:0 16px}
h1{color:#0a2464;font-size:22px;margin:0 0 2px}h2{color:#0a2464;font-size:15px;margin:22px 0 6px;border-bottom:2px solid #018a8a;padding-bottom:2px}
.meta{color:#475569;margin-bottom:10px}table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-size:11.5px}caption{text-align:left;font-weight:700;padding:4px 0}
th,td{border:1px solid #cbd5e1;padding:3px 6px;text-align:right}th{background:#f1f5f9}td:first-child,th:first-child{text-align:left}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:10px}.warn{background:#fffbeb;border-left:4px solid #f59e0b;padding:6px 10px;margin:8px 0}
@media print{body{margin:8mm}h2{break-after:avoid}table,svg{break-inside:avoid}}
</style></head><body>
<h1>${esc(opts.title)}</h1><div class="meta">${esc(opts.study)} · ${esc(opts.solver)} · ${esc(opts.date)}</div>
<h2>Pedido</h2><ul>${setupLines(r).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Malhas e resultados</h2>${tableHtml(levelsTable(r), "Todas as malhas corridas (da mais grossa para a mais fina)")}
<h2>Índice de convergência da malha (GCI)</h2>${tableHtml(gciTable(r), "Três malhas mais finas — Celik et al. (2008) / ASME V&V 20")}
${errorTable(r).rows.length ? tableHtml(errorTable(r), "Erro relativo de cada malha à extrapolação de Richardson") : ""}
<h2>Gráficos</h2><div class="charts">${lead ? convergenceChart(r, lead.key) : ""}${normalizedChart(r)}${errorChart(r)}</div>
<h2>Hipóteses e limites</h2><ul>${[...r.hypotheses, ...(opts.hypotheses ?? [])].map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
<div class="warn">Estimativa de incerteza de discretização (GCI), não uma garantia: confirme a gama assintótica e a ordem aparente, e use sondas em vez de máximos junto a singularidades. Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado.</div>
</body></html>`;
}
