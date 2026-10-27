// Scripts de automação (JavaScript) sobre o modelo: a API `cad.*` exposta aos scripts, o motor que
// os corre e utilitários de estudo paramétrico e de superfície de resposta. Puro: o mesmo script
// corre no browser (Web Worker isolado, ver app/script-worker.ts) e em Node (tools/cad-script.ts,
// para simulações automáticas em lote). O script trabalha sobre uma CÓPIA do documento; as
// alterações só passam para o modelo se o utilizador as aplicar.
import type { CadDocument } from "../doc/types.ts";

/** Resultado de uma reconstrução, resumido para scripts. */
export interface ScriptRebuild {
  ok: boolean;
  errors: { feature: string; message: string }[];
  measures: Record<string, number>;
  variables: Record<string, number>;
  checks: { name: string; ok: boolean; message?: string }[];
  pmi: { id: string; text: string; errors: string[] }[];
}

/** Resultado de uma simulação, resumido para scripts. */
export interface ScriptSimulation {
  solver: string;
  metrics: Record<string, number>;
  summary: [string, string][];
  warnings: string[];
  cells: number;
  seconds: number;
  convergence?: { key: string; values: number[]; extrapolated: number; gci: number; behaviour: string }[];
}

/** O que o ambiente (browser ou Node) tem de fornecer ao motor de scripts. */
export interface ScriptHost {
  rebuild(doc: CadDocument): Promise<ScriptRebuild>;
  simulate(doc: CadDocument, studyId: string, opts: { convergence?: { ratio: number; target?: number; metric?: string; maxLevels?: number } }): Promise<ScriptSimulation>;
}

export interface ScriptOutput {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  tables: { name: string; rows: Record<string, unknown>[] }[];
  /** Documento depois do script (para aplicar, se mudou). */
  doc: CadDocument;
  changed: boolean;
  seconds: number;
}

/** Combinações de um plano fatorial completo: { L: [80, 100], t: [2, 3] } → 4 linhas. */
export function grid(spec: Record<string, readonly (number | string)[]>): Record<string, number | string>[] {
  let rows: Record<string, number | string>[] = [{}];
  for (const [k, vals] of Object.entries(spec)) {
    if (!vals.length) throw new Error(`grid: "${k}" sem valores`);
    rows = rows.flatMap((r) => vals.map((v) => ({ ...r, [k]: v })));
  }
  if (rows.length > 10000) throw new Error(`grid: ${rows.length} combinações (máx. 10 000)`);
  return rows;
}

/** n valores igualmente espaçados entre a e b (inclusive). */
export const linspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1)));

/**
 * Superfície de resposta (modelo de ordem reduzida simples): interpolação por funções de base radial
 * gaussianas sobre variáveis normalizadas, com um termo linear. Exata nos pontos de treino; serve para
 * explorar e escolher candidatos, nunca para substituir a verificação com o modelo completo.
 */
export function surrogate(rows: Record<string, unknown>[], inputs: string[], output: string, opts: { shape?: number } = {}) {
  const pts = rows.filter((r) => inputs.every((k) => Number.isFinite(Number(r[k]))) && Number.isFinite(Number(r[output])));
  if (pts.length < inputs.length + 2) throw new Error(`surrogate: precisa de pelo menos ${inputs.length + 2} pontos válidos (tem ${pts.length})`);
  const lo = inputs.map((k) => Math.min(...pts.map((r) => Number(r[k])))), hi = inputs.map((k) => Math.max(...pts.map((r) => Number(r[k]))));
  const xs = pts.map((r) => inputs.map((k) => Number(r[k]))), y = pts.map((r) => Number(r[output]));
  // forma: ≈ 0,8 / espaçamento médio dos pontos (gaussianas que se sobrepõem às vizinhas)
  const eps = opts.shape ?? 0.8 * Math.pow(pts.length, 1 / inputs.length);
  const fit = rbfFit(xs, y, lo, hi, eps);
  // validação cruzada "deixar um de fora" (erro típico do modelo fora dos pontos de treino)
  let looRmse = NaN;
  if (pts.length > inputs.length + 3 && pts.length <= 200) {
    const errs = xs.map((x, k) => rbfFit(xs.filter((_, i) => i !== k), y.filter((_, i) => i !== k), lo, hi, eps)(x) - y[k]);
    looRmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  }
  const predict = (x: Record<string, number> | number[]) => fit(Array.isArray(x) ? x : inputs.map((k) => Number(x[k])));
  const range = Math.max(...y) - Math.min(...y);
  return { predict, inputs, output, points: pts.length, bounds: inputs.map((k, i) => ({ name: k, min: lo[i], max: hi[i] })), looRmse, looRelative: range > 0 ? looRmse / range : NaN };
}

/** RBF gaussiana + termo linear em variáveis normalizadas a [0, 1]: devolve a função interpoladora. */
function rbfFit(xs: number[][], y: number[], lo: number[], hi: number[], eps: number): (x: number[]) => number {
  const norm = (x: number[]) => x.map((v, i) => (hi[i] > lo[i] ? (v - lo[i]) / (hi[i] - lo[i]) : 0));
  const X = xs.map(norm);
  const phi = (a: number[], b: number[]) => Math.exp(-((eps * Math.hypot(...a.map((v, i) => v - b[i]))) ** 2));
  // sistema [Φ P; Pᵀ 0][w; c] = [y; 0] com P = [1, x]
  const n = X.length, m = lo.length + 1, N = n + m;
  const A = Array.from({ length: N }, () => new Array(N).fill(0)), rhs = new Array(N).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = phi(X[i], X[j]) + (i === j ? 1e-10 : 0);
    const P = [1, ...X[i]];
    for (let j = 0; j < m; j++) { A[i][n + j] = P[j]; A[n + j][i] = P[j]; }
    rhs[i] = y[i];
  }
  const w = solveDense(A, rhs);
  return (x: number[]) => {
    const v = norm(x);
    let s = w[n];
    for (let j = 0; j < lo.length; j++) s += w[n + 1 + j] * v[j];
    for (let i = 0; i < n; i++) s += w[i] * phi(v, X[i]);
    return s;
  };
}

/** Eliminação de Gauss com pivotagem parcial (sistemas pequenos). */
export function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) throw new Error("Sistema singular (pontos repetidos?)");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Tabela → CSV (separador ";", vírgula decimal não: ponto, para ferramentas de cálculo). */
export function tableCSV(rows: Record<string, unknown>[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => { const s = v === undefined || v === null ? "" : typeof v === "number" ? String(+v.toPrecision(10)) : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [cols.join(";"), ...rows.map((r) => cols.map((c) => q(r[c])).join(";"))].join("\n") + "\n";
}

/** Descrição da API (para a ajuda no editor e para o copiloto). */
export const API_DOC = `// API dos scripts (JavaScript, async/await). O script trabalha sobre uma cópia do documento.
cad.doc()                      // documento atual (cópia JSON: features, variables, studies, pmi, …)
cad.variables()                // { nome: valor } resolvidas na última reconstrução
cad.set(nome, expr)            // muda (ou cria) uma variável: número ou expressão ("L/2 + 3")
cad.feature(id)                // feature (cópia) por id ("f3") ou nome
cad.update(id, patch)          // altera parâmetros de uma feature: cad.update("f2", { end: { type: "blind", depth: 25 } })
await cad.rebuild()            // reconstrói → { ok, errors, measures: {volume, area, massa, dimX, dimY, dimZ}, variables, checks, pmi }
await cad.simulate(estudoId, { convergence? })   // corre um estudo no agente local → { metrics: {umax, vmmax, probe1, f1, dp, …}, summary, warnings, cells, convergence }
cad.studies()                  // [{ id, name, physics, analysis }]
cad.grid({ L: [80, 100], t: [2, 3] })            // plano fatorial completo → [{L, t}, …]
cad.linspace(a, b, n)          // n valores entre a e b
cad.surrogate(linhas, ["L", "t"], "massa")       // superfície de resposta RBF → { predict({L, t}), looRmse, looRelative, bounds }
cad.log(...valores)            // escreve na consola do script
cad.table(linhas, nome?)       // mostra uma tabela (e permite descarregar CSV)
// O valor devolvido pelo script (return …) aparece no fim. Sem acesso à rede, ao disco nem à interface.`;

type Doc = CadDocument;

/**
 * Corre um script. `compile` transforma o código numa função async(cad) — no browser é chamado dentro
 * do Worker; em Node usa a mesma construção (AsyncFunction). `timeoutMs` limita o tempo total.
 */
export async function runScript(code: string, doc: Doc, host: ScriptHost, opts: { timeoutMs?: number; onLog?: (line: string) => void } = {}): Promise<ScriptOutput> {
  const t0 = Date.now();
  let cur: Doc = structuredClone(doc);
  const start = JSON.stringify(doc);
  const logs: string[] = [];
  const tables: ScriptOutput["tables"] = [];
  let lastVars: Record<string, number> = {};
  const fmt = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(+v.toPrecision(10)) : JSON.stringify(v));
  const findFeature = (id: string) => cur.features.find((f) => f.id === id || f.name === id);
  const cad = Object.freeze({
    doc: () => structuredClone(cur),
    variables: () => ({ ...lastVars }),
    set: (name: string, expr: number | string) => {
      if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Nome de variável inválido: ${name}`);
      const v = cur.variables.find((x) => x.name === name);
      cur = { ...cur, variables: v ? cur.variables.map((x) => (x.name === name ? { ...x, expr: String(expr) } : x)) : [...cur.variables, { name, expr: String(expr) }] };
    },
    feature: (id: string) => { const f = findFeature(id); if (!f) throw new Error(`Feature inexistente: ${id}`); return structuredClone(f); },
    update: (id: string, patch: Record<string, unknown>) => {
      const f = findFeature(id);
      if (!f) throw new Error(`Feature inexistente: ${id}`);
      if ("id" in patch || "type" in patch) throw new Error("cad.update: não se muda o id nem o tipo de uma feature");
      cur = { ...cur, features: cur.features.map((x) => (x === f ? ({ ...x, ...structuredClone(patch) } as typeof x) : x)) };
    },
    rebuild: async () => { const r = await host.rebuild(cur); lastVars = r.variables; return r; },
    simulate: (studyId: string, o: Parameters<ScriptHost["simulate"]>[2] = {}) => {
      if (!(cur.studies ?? []).some((s) => s.id === studyId || s.name === studyId)) throw new Error(`Estudo inexistente: ${studyId}`);
      const id = (cur.studies ?? []).find((s) => s.id === studyId || s.name === studyId)!.id;
      return host.simulate(cur, id, o);
    },
    studies: () => (cur.studies ?? []).map((s) => ({ id: s.id, name: s.name, physics: s.physics, analysis: s.physics === "fem" ? s.analysis : s.regime })),
    grid, linspace, surrogate,
    log: (...a: unknown[]) => { const line = a.map(fmt).join(" "); logs.push(line); opts.onLog?.(line); if (logs.length > 5000) throw new Error("Demasiadas linhas na consola (máx. 5000)"); },
    table: (rows: Record<string, unknown>[], name = `Tabela ${tables.length + 1}`) => { if (!Array.isArray(rows)) throw new Error("cad.table: espera uma lista de linhas"); tables.push({ name, rows: structuredClone(rows) }); },
  });
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (cad: unknown) => Promise<unknown>;
  let value: unknown, error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fn = new AsyncFunction("cad", `"use strict";\n${code}`);
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`Tempo esgotado (${Math.round((opts.timeoutMs ?? 600000) / 1000)} s)`)), opts.timeoutMs ?? 600000); });
    value = await Promise.race([fn(cad), timeout]);
  } catch (e) {
    error = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { ok: !error, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)), error, logs, tables, doc: cur, changed: JSON.stringify(cur) !== start, seconds: (Date.now() - t0) / 1000 };
}
