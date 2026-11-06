// Agente local do CAD protótipo: corre os solvers abertos instalados nesta máquina (Gmsh + CalculiX,
// code_aster, OpenFOAM, SU2, XFOIL) para os casos que a aplicação prepara, e devolve os resultados.
//
//   node cad-runner.mjs <pasta-do-caso>          corre um caso exportado (case.json + model.brep …)
//        [--convergence 1.5]                     … em três malhas (h, 1,5·h, 2,25·h) com o GCI
//   node cad-runner.mjs --serve [--port 8765]    servidor em 127.0.0.1 para a aplicação ("Calcular")
//   node cad-runner.mjs --status                 solvers encontrados
//
// Segurança: o servidor só escuta em 127.0.0.1, exige o token que mostra ao arrancar e nunca executa
// scripts recebidos: os ficheiros de entrada dos solvers são gerados aqui a partir de `case.json`
// (geometria em BREP e superfícies em STL são só dados). Os solvers correm como processos separados
// (as licenças GPL/AGPL não se estendem à aplicação).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SimCase } from "../src/sim/case.ts";
import { meshPreview } from "../src/sim/meshview.ts";
import type { MeshQuality } from "../src/sim/quality.ts";
import { type FemResult } from "../src/sim/calculix.ts";
import { type ResultView } from "../src/sim/result.ts";
import { type ConvergenceLevel, type ConvergenceReport, type GciResult, type Metric, convergenceReport, gci, isMonotonic } from "../src/sim/convergence.ts";
import { type XfoilRequest, type XfoilResult, XFOIL_HYPOTHESES, parsePolar, polarSummary, xfoilCommands, xfoilRetryCommands } from "../src/sim/xfoil.ts";
import { type Log, type Job, jobState, cancelJob, CancelledError, tail, tools } from "./cad-runner-proc.ts";
import { checkGroups, gmshMesh, runFem } from "./cad-runner-fem.ts";
import { runOpenfoam, runSu2 } from "./cad-runner-cfd.ts";
export { tools } from "./cad-runner-proc.ts";
export { gmshError } from "./cad-runner-fem.ts";


export interface RunResult {
  ok: boolean;
  physics: "fem" | "cfd";
  solver: string;
  summary: [string, string][];
  warnings: string[];
  fem?: FemResult;
  /** Camadas de resultados para o 3D (FEM: superfície da peça; CFD: patches e cortes). */
  view?: ResultView;
  /** Grandezas escalares do cálculo e número de células/elementos da malha. */
  metrics: Metric[];
  cells: number;
  /** Estudo de convergência da malha (se pedido): três malhas e GCI por grandeza. */
  convergence?: ConvergenceReport;
  /** Hipóteses e limites do caso (normas, modelação), a mostrar com os resultados. */
  hypotheses: string[];
  /** Últimas linhas dos registos (diagnóstico). */
  log: string;
  seconds: number;
  /** Pré-visualização da malha: relatório de qualidade. */
  quality?: MeshQuality;
}

export interface RunOptions {
  /**
   * Estudo de convergência. Sem `target`: três malhas h, r·h, r²·h (a pedida é a mais fina).
   * Com `target` (GCI, fração): refina a partir de h (h, h/r, h/r², …) até o GCI da grandeza
   * `metric` (por omissão a primeira sonda, ou o deslocamento máximo) ficar abaixo do alvo, com
   * convergência monotónica, ou até `maxLevels` malhas (5) ou `maxCells` elementos/células.
   * Com `sweep` = n: 2n + 1 malhas h·r^k, k = n … −n (n acima e n abaixo da pedida), da mais grossa
   * para a mais fina, a parar antes de passar `maxCells`.
   */
  convergence?: { ratio: number; target?: number; metric?: string; maxLevels?: number; maxCells?: number; sweep?: number };
}

async function runOnce(c: SimCase, dir: string, log: Log, regenerate: boolean) {
  return c.physics === "fem" ? runFem(c, dir, log, regenerate)
    : c.solver === "openfoam" ? runOpenfoam(c, dir, log, regenerate) : runSu2(c, dir, log, regenerate);
}

/** Caso com a malha engrossada pelo fator `k` (tamanhos × k; refinamento por curvatura ÷ k). */
export function coarsened(c: SimCase, k: number): SimCase {
  if (c.physics === "fem") {
    const curv = c.mesh.curvature > 0 ? Math.max(4, Math.round(c.mesh.curvature / k)) : 0;
    // seeds e curvas mapeadas: n.º de elementos a escalar com o tamanho, mantendo a razão maior/menor
    const curves = c.mesh.curves?.map((cv) => {
      const n = Math.max(1, Math.round(cv.n / k));
      const B = cv.progression ? cv.progression ** Math.max(0, cv.n - 1) : 1;
      return { ...cv, n, ...(cv.progression ? { progression: n > 1 ? B ** (1 / (n - 1)) : 1 } : {}) };
    });
    return { ...c, mesh: { ...c.mesh, size: c.mesh.size * k, minSize: c.mesh.minSize * k, curvature: curv, local: c.mesh.local.map((l) => ({ ...l, size: l.size * k })), ...(curves ? { curves } : {}) } };
  }
  return { ...c, mesh: { ...c.mesh, size: c.mesh.size * k } };
}

/**
 * Só a malha (pré-visualização, como no Femap antes de exportar): corre o Gmsh no caso FEM de uma
 * pasta, confere os grupos e as seeds com o CAD e devolve a qualidade e a superfície da malha.
 */
export async function previewMesh(dir: string, log: Log = () => {}): Promise<RunResult> {
  const t0 = Date.now();
  const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as SimCase;
  if (c.format !== "cadp-sim-case" || c.physics !== "fem") throw new Error("A pré-visualização da malha é para estudos FEM");
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
  const msh = (await gmshMesh(c, dir, log, { kind: "fem", regenerate: true, preview: true }))!;
  const warnings = checkGroups(c, msh);
  const p = meshPreview(c, msh);
  warnings.push(...p.quality.notes);
  return { ok: true, physics: "fem", solver: `Gmsh ${t.gmsh.version ?? ""} — pré-visualização da malha`.trim(), summary: p.summary, warnings, view: p.view, quality: p.quality, metrics: [], cells: p.quality.elements, hypotheses: c.hypotheses, log: tail(join(dir, "log.gmsh")), seconds: (Date.now() - t0) / 1000 };
}

/** Corre o caso de uma pasta (case.json + model.brep [+ STL]). `regenerate`: refaz os ficheiros dos solvers a partir do caso. */
export async function runCase(dir: string, log: Log = () => {}, regenerate = false, opts: RunOptions = {}): Promise<RunResult> {
  const t0 = Date.now();
  const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as SimCase;
  if (c.format !== "cadp-sim-case") throw new Error("case.json inválido");
  let r: Omit<RunResult, "seconds" | "hypotheses">;
  const prepare = (k: number, name: string) => {
    const sub = join(dir, name);
    mkdirSync(sub, { recursive: true });
    const ck = coarsened(c, k);
    writeFileSync(join(sub, "case.json"), JSON.stringify(ck));
    writeFileSync(join(sub, "model.brep"), readFileSync(join(dir, "model.brep")));
    if (existsSync(join(dir, "constant/triSurface"))) {
      mkdirSync(join(sub, "constant/triSurface"), { recursive: true });
      for (const fn of readdirSync(join(dir, "constant/triSurface"))) if (fn.endsWith(".stl")) writeFileSync(join(sub, "constant/triSurface", fn), readFileSync(join(dir, "constant/triSurface", fn)));
    }
    return { sub, ck };
  };
  if (opts.convergence?.sweep) {
    const { ratio } = opts.convergence;
    const n = Math.round(opts.convergence.sweep), maxCells = opts.convergence.maxCells ?? 1.5e6;
    if (!(n >= 1 && n <= 4)) throw new Error("Varrimento: entre 1 e 4 níveis para cada lado");
    if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
    const runs: Omit<RunResult, "seconds" | "hypotheses">[] = [];
    const steps: NonNullable<ConvergenceReport["sweep"]>["steps"] = [];
    const all: ConvergenceLevel[] = [];
    let metric = opts.convergence.metric, stop: string | undefined;
    for (let k = n; k >= -n; k--) {
      // estimativa dos elementos da malha seguinte (∝ h⁻³) a partir da anterior
      if (runs.length && runs.at(-1)!.cells * ratio ** 3 > maxCells) { stop = `as malhas abaixo de ${steps.at(-1)!.size.toPrecision(3)} mm passariam de ${maxCells.toExponential(1)} elementos`; break; }
      const { sub, ck } = prepare(ratio ** k, `nivel${k >= 0 ? "+" : ""}${k}`);
      log(`— nível ${k > 0 ? "+" : ""}${k} (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
      const tk = Date.now();
      const r1 = await runOnce(ck, sub, log, true);
      runs.push(r1);
      all.push({ level: k, size: ck.mesh.size, cells: r1.cells, seconds: (Date.now() - tk) / 1000, metrics: r1.metrics });
      metric ??= r1.metrics.find((x) => x.key.startsWith("probe"))?.key ?? r1.metrics[0]?.key;
      steps.push({ level: k, size: ck.mesh.size, cells: r1.cells, value: r1.metrics.find((x) => x.key === metric)?.value ?? NaN });
    }
    if (runs.length < 3) throw new Error(`Varrimento: só ${runs.length} malha(s) cabem no limite de ${maxCells.toExponential(1)} elementos — aumente o tamanho pedido`);
    const fine = runs.slice(-3).reverse();
    const report = convergenceReport(ratio, fine.map((x, i) => ({ cells: x.cells, size: steps[steps.length - 1 - i].size, metrics: x.metrics })));
    const row = report.rows.find((x) => x.key === metric);
    const base = steps.find((x) => x.level === 0)!.value;
    const values = steps.map((x) => x.value).filter(Number.isFinite);
    report.levels = all;
    report.setup = { mode: "sweep", ratio, levels: n, metric };
    report.sweep = { metric: metric ?? "", levels: n, steps, monotonic: isMonotonic(values), base, baseError: row && Number.isFinite(row.gci.extrapolated) ? Math.abs((base - row.gci.extrapolated) / row.gci.extrapolated) : undefined, stop };
    report.hypotheses.push(`Varrimento de ${steps.length} malhas (tamanho h·r^k, k = ${n} … ${steps.at(-1)!.level}, r = ${ratio}); GCI e extrapolação pelas três mais finas; erro da malha pedida = |f(h) − f extrapolado| / |f extrapolado|`);
    const baseRun = runs[steps.findIndex((x) => x.level === 0)];
    r = { ...baseRun, convergence: report, warnings: [...baseRun.warnings, ...(stop ? [`Varrimento incompleto: ${stop}`] : []), ...(report.sweep.monotonic ? [] : ["A grandeza não varia de forma monotónica com a malha: veja se o ponto está junto a uma singularidade (canto vivo, apoio, carga)"]), ...(row?.gci.notes ?? []).map((x) => `${row!.label}: ${x}`)] };
  } else if (opts.convergence?.target !== undefined) {
    const { ratio, target } = opts.convergence;
    const maxLevels = Math.min(8, Math.max(3, opts.convergence.maxLevels ?? 5)), maxCells = opts.convergence.maxCells ?? 1.5e6;
    if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
    if (!(target > 0 && target < 1)) throw new Error("GCI alvo fora de ]0; 1[ (fração, ex. 0,01 = 1 %)");
    const runs: Omit<RunResult, "seconds" | "hypotheses">[] = [];
    const steps: NonNullable<ConvergenceReport["auto"]>["steps"] = [];
    const all: ConvergenceLevel[] = [];
    let metric = opts.convergence.metric;
    let achieved = false, stop = "";
    for (let k = 0; k < maxLevels; k++) {
      const { sub, ck } = prepare(ratio ** -k, `nivel${k + 1}`);
      log(`— nível ${k + 1} (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
      const tk = Date.now();
      const r1 = await runOnce(ck, sub, log, true);
      runs.push(r1);
      all.push({ level: -k, size: ck.mesh.size, cells: r1.cells, seconds: (Date.now() - tk) / 1000, metrics: r1.metrics });
      metric ??= r1.metrics.find((x) => x.key.startsWith("probe"))?.key ?? r1.metrics[0]?.key;
      const val = r1.metrics.find((x) => x.key === metric)?.value ?? NaN;
      let g: GciResult | undefined;
      if (runs.length >= 3) {
        const [f3, f2, f1] = runs.slice(-3).map((x) => x.metrics.find((y) => y.key === metric)?.value ?? NaN);
        const [n3, n2, n1] = runs.slice(-3).map((x) => x.cells);
        g = gci([n1, n2, n3], [f1, f2, f3]);
      }
      steps.push({ level: k + 1, size: ck.mesh.size, cells: r1.cells, value: val, gci: g?.gciFine, behaviour: g?.behaviour });
      if (g && g.behaviour === "monotonic" && g.gciFine <= target) { achieved = true; stop = `GCI ${(100 * g.gciFine).toFixed(2)} % ≤ ${(100 * target).toFixed(2)} %`; break; }
      if (g?.behaviour === "converged") { achieved = true; stop = "valores iguais nas duas malhas mais finas"; break; }
      if (r1.cells * ratio ** 3 > maxCells) { stop = `a malha seguinte passaria de ${maxCells.toExponential(1)} células`; break; }
    }
    if (!stop) stop = `atingido o máximo de ${maxLevels} malhas`;
    const last = runs.slice(-3).reverse();
    const report = last.length === 3 ? convergenceReport(ratio, last.map((x) => ({ cells: x.cells, size: NaN, metrics: x.metrics }))) : { ratio, meshes: [], rows: [], hypotheses: [] };
    report.meshes = last.map((x, i) => ({ cells: x.cells, size: steps[steps.length - 1 - i].size }));
    report.levels = all;
    report.setup = { mode: "auto", ratio, target, levels: maxLevels, metric };
    report.auto = { target, metric: metric ?? "", achieved, stop, steps };
    const fine = runs.at(-1)!;
    r = { ...fine, convergence: report, warnings: [...fine.warnings, ...(achieved ? [] : [`Convergência não atingida: ${stop}`]), ...report.rows.filter((x) => x.key === metric).flatMap((x) => x.gci.notes.map((n) => `${x.label}: ${n}`))] };
  } else if (opts.convergence) {
    const ratio = opts.convergence.ratio;
    if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
    // da mais grossa (mais rápida, falha cedo) para a pedida
    const runs: Omit<RunResult, "seconds" | "hypotheses">[] = [];
    const all: ConvergenceLevel[] = [];
    for (const lvl of [2, 1, 0]) {
      const { sub, ck } = prepare(ratio ** lvl, `malha${lvl + 1}`);
      log(`— malha ${lvl + 1} de 3 (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
      const tk = Date.now();
      runs[lvl] = await runOnce(ck, sub, log, true);
      all.push({ level: lvl, size: ck.mesh.size, cells: runs[lvl].cells, seconds: (Date.now() - tk) / 1000, metrics: runs[lvl].metrics });
    }
    const report = convergenceReport(ratio, runs.map((x, i) => ({ cells: x.cells, size: c.mesh.size * ratio ** i, metrics: x.metrics })));
    report.levels = all;
    report.setup = { mode: "three", ratio };
    r = { ...runs[0], convergence: report, warnings: [...runs[0].warnings, ...report.rows.flatMap((x) => x.gci.notes.map((n) => `${x.label}: ${n}`))] };
  } else r = await runOnce(c, dir, log, regenerate);
  const res: RunResult = { ...r, summary: [...r.summary], hypotheses: c.hypotheses, seconds: (Date.now() - t0) / 1000 };
  writeFileSync(join(dir, "results.json"), JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------------------
// XFOIL (perfis 2D)
// ---------------------------------------------------------------------------

/**
 * Polar de um perfil no XFOIL. Os comandos são gerados a partir do pedido validado (só números e
 * códigos NACA). Algumas compilações (ex.: Debian/Ubuntu 6.99) ativam exceções de vírgula flutuante e
 * abortam no modo viscoso: CAD_XFOIL_PRELOAD aponta para uma biblioteca que as desliga (ver LEIA-ME).
 */
export async function runXfoil(req: XfoilRequest, log: Log = () => {}): Promise<XfoilResult> {
  const t0 = Date.now();
  const c = xfoilCommands(req);
  const x = tools().xfoil;
  if (!x) throw new Error("XFOIL não encontrado (https://web.mit.edu/drela/Public/web/xfoil/, apt install xfoil, ou defina CAD_XFOIL)");
  const dir = mkdtempSync(join(tmpdir(), "cad-xfoil-"));
  try {
    for (const [p, text] of Object.entries(c.files)) writeFileSync(join(dir, p), text);
    log(`$ ${x.path} < comandos (${c.request.alpha.from}…${c.request.alpha.to}°, Re ${c.request.re})`);
    const env = { ...process.env, ...(x.preload ? { LD_PRELOAD: x.preload } : {}) };
    // sem exceções de vírgula flutuante, uma camada-limite que diverge pode ficar em ciclo com NaN:
    // guarda-se só o fim da saída e o processo é parado se a saída disparar
    const xf = (stdin: string, seconds: number) => new Promise<string>((ok, fail) => {
      const p = spawn(x.path, [], { cwd: dir, env });
      let tailText = "", total = 0, stopped = "";
      const take = (b: Buffer) => {
        total += b.length;
        tailText = (tailText + b.toString()).slice(-20000);
        if (total > 50e6 && !stopped) { stopped = "saída descontrolada (camada-limite divergente, NaN)"; p.kill("SIGKILL"); }
      };
      p.stdout.on("data", take);
      p.stderr.on("data", take);
      const timer = setTimeout(() => { stopped = `não terminou em ${seconds} s`; p.kill("SIGKILL"); }, seconds * 1000);
      p.on("error", (e) => { clearTimeout(timer); fail(new Error(`xfoil: ${e.message}`)); });
      p.on("close", () => { clearTimeout(timer); ok(stopped ? `${tailText}\n[XFOIL parado: ${stopped}]` : tailText); });
      p.stdin.end(stdin);
    });
    const nA = Math.abs(c.request.alpha.to - c.request.alpha.from) / c.request.alpha.step + 1;
    const limit = Math.round(30 + 3 * nA);
    const out = await xf(c.stdin, limit);
    const file = join(dir, "polar.txt");
    let polar = existsSync(file) ? parsePolar(readFileSync(file, "utf8")) : [];
    let retried = 0;
    const first = polar.length ? polarSummary(polar, c.request).missing : [];
    if (first.length) {
      // segunda passagem só para os ângulos pedidos que faltam (aproximação a partir do vizinho)
      log(`XFOIL: segunda passagem para α = ${first.join(", ")}°`);
      await xf(xfoilRetryCommands(c.request, first, polar.map((p) => p.alpha)).stdin, Math.round(30 + 6 * first.length));
      const f2 = join(dir, "polar2.txt");
      const extra = existsSync(f2) ? parsePolar(readFileSync(f2, "utf8")).filter((p) => first.some((m) => Math.abs(m - p.alpha) < 1e-3)) : [];
      retried = extra.length;
      polar = [...polar, ...extra].sort((a, b) => a.alpha - b.alpha);
    }
    if (!polar.length) {
      const fpe = /SIGFPE|Floating-point exception/i.test(out);
      throw new Error(fpe ? "O XFOIL abortou com uma exceção de vírgula flutuante (compilação com FPE ativas): defina CAD_XFOIL_PRELOAD (ver LEIA-ME)" : `O XFOIL não produziu nenhum ponto da polar:\n${out.split(/\r?\n/).slice(-12).join("\n")}`);
    }
    const summary = polarSummary(polar, c.request);
    const warnings: string[] = [];
    if (retried) warnings.push(`${retried} ângulo(s) obtidos numa segunda passagem (aproximação a partir do vizinho convergido, +10 painéis): confirmar a continuidade da polar`);
    if (summary.missing.length) warnings.push(`Sem convergência em α = ${summary.missing.join(", ")}° (omitidos)`);
    if (summary.clMax === null) warnings.push("CLmax não atingido na gama pedida");
    if (c.request.mach! > 0.5) warnings.push("Mach > 0,5: verificar se há escoamento supersónico local (Cp mínimo)");
    const name = "naca" in c.request.airfoil ? `NACA ${c.request.airfoil.naca}` : c.request.airfoil.name;
    return { ok: true, solver: x.version, airfoil: name, re: c.request.re, mach: c.request.mach!, ncrit: c.request.ncrit!, polar, summary, warnings, hypotheses: XFOIL_HYPOTHESES, seconds: (Date.now() - t0) / 1000, log: out.split(/\r?\n/).slice(-20).join("\n") };
  } finally {
    if (!process.env.CAD_KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Servidor local
// ---------------------------------------------------------------------------

/** Pedido da aplicação: o caso, a geometria e (CFD/OpenFOAM) as superfícies STL de cada patch. */
/** Limites pedidos pelo browser (s): ignora valores inválidos e corta nos máximos (malha 2 h, solve 7 dias). */
export function jobLimits(body: { meshTimeout?: unknown; solveTimeout?: unknown }): { meshTimeout?: number; solveTimeout?: number } {
  const lim = (v: unknown, max: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : undefined; };
  const out: { meshTimeout?: number; solveTimeout?: number } = {};
  const mt = lim(body.meshTimeout, 7200), st = lim(body.solveTimeout, 7 * 24 * 3600);
  if (mt !== undefined) out.meshTimeout = mt;
  if (st !== undefined) out.solveTimeout = st;
  return out;
}

export interface RunRequest { case: SimCase; brep: string; stl?: Record<string, string>; convergence?: RunOptions["convergence"]; /** limite por tentativa de malha, s */ meshTimeout?: number; /** limite de cada passo do solver, s */ solveTimeout?: number }

export function serve(port = 8765, token = randomBytes(12).toString("hex")) {
  let busy = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-cad-token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-cad-token"] !== token) { send(401, { error: "Token do agente em falta ou errado" }); return; }
    if (req.method === "GET" && req.url === "/status") { send(200, { ok: true, tools: tools(), busy }); return; }
    // progresso ao vivo do job em curso (tempo decorrido e cauda da saída do solver)
    if (req.method === "GET" && req.url === "/job") { send(200, jobState.current ? { busy: true, elapsed: (Date.now() - jobState.current.start) / 1000, tail: jobState.current.tail.slice(-4000), cancelled: jobState.current.cancelled } : { busy: false }); return; }
    if (req.method === "POST" && req.url === "/cancel") { send(200, { ok: true, cancelled: cancelJob("Parado pelo utilizador") }); return; }
    if (req.method !== "POST" || (req.url !== "/run" && req.url !== "/xfoil" && req.url !== "/mesh")) { send(404, { error: "Pedido desconhecido" }); return; }
    if (busy) { send(409, { error: "O agente está ocupado com outro cálculo" }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) { size += (ch as Buffer).length; if (size > 200e6) { send(413, { error: "Pedido demasiado grande" }); return; } chunks.push(ch as Buffer); }
    busy = true;
    const job: Job = { start: Date.now(), tail: "" };
    jobState.current = job;
    // o browser fechou o pedido (separador fechado, fetch abortado) antes da resposta: mata o solver
    res.on("close", () => { if (!res.writableFinished && jobState.current === job) cancelJob("Pedido fechado pelo cliente"); });
    // as mensagens do agente também entram na cauda do progresso
    const log = (s: string) => { console.log(s); job.tail = (job.tail + s + "\n").slice(-20000); };
    // cancelado: 499 (convenção do nginx para «o cliente fechou o pedido»)
    const fail = (e: unknown, extra: object = {}) => e instanceof CancelledError ? send(499, { error: `Cancelado: ${e.message}`, cancelled: true }) : send(500, { error: (e as Error).message, ...extra });
    if (req.url === "/xfoil") {
      try { send(200, await runXfoil(JSON.parse(Buffer.concat(chunks).toString("utf8")) as XfoilRequest, log)); }
      catch (e) { fail(e); }
      finally { busy = false; jobState.current = null; }
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cad-run-"));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunRequest;
      Object.assign(job, jobLimits(body));
      if (body.case?.format !== "cadp-sim-case" || typeof body.brep !== "string") throw new Error("Pedido inválido");
      writeFileSync(join(dir, "case.json"), JSON.stringify(body.case));
      writeFileSync(join(dir, "model.brep"), body.brep);
      if (body.stl) {
        mkdirSync(join(dir, "constant/triSurface"), { recursive: true });
        for (const [name, text] of Object.entries(body.stl)) {
          if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Nome de patch inválido: ${name}`);
          writeFileSync(join(dir, `constant/triSurface/${name}.stl`), text);
        }
      }
      const cv = body.convergence;
      const fin = (x: unknown) => (x === undefined || x === null ? undefined : Number.isFinite(Number(x)) ? Number(x) : undefined);
      const conv = cv && Number.isFinite(Number(cv.ratio)) ? { ratio: Number(cv.ratio), target: fin(cv.target), metric: typeof cv.metric === "string" ? cv.metric : undefined, maxLevels: fin(cv.maxLevels), maxCells: fin(cv.maxCells), sweep: fin(cv.sweep) } : undefined;
      const r = req.url === "/mesh" ? await previewMesh(dir, log) : await runCase(dir, log, true, { convergence: conv });
      send(200, r);
    } catch (e) {
      fail(e, { log: tail(join(dir, "log.ccx")) || tail(join(dir, "log.gmsh")) });
    } finally {
      busy = false;
      jobState.current = null;
      if (!process.env.CAD_KEEP) rmSync(dir, { recursive: true, force: true });
    }
  });
  server.listen(port, "127.0.0.1");
  return { server, token, port };
}

// ---------------------------------------------------------------------------
// Linha de comandos
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && /cad-runner\.(m?js|ts)$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === "--status") console.log(JSON.stringify(tools(), null, 2));
  else if (args[0] === "--serve") {
    const port = Number(args[args.indexOf("--port") + 1]) || 8765;
    const { token } = serve(port, process.env.CAD_TOKEN);
    console.log(`Agente CAD a escutar em http://127.0.0.1:${port}\nToken (copie para a aplicação, Simulação → Agente local): ${token}\nSolvers: ${JSON.stringify(tools())}`);
  } else if (args[0]) {
    const ri = args.indexOf("--convergence");
    runCase(resolve(args[0]), (s) => console.log(s), args.includes("--regenerate"), ri > 0 ? { convergence: { ratio: Number(args[ri + 1]) || 1.5 } } : {})
      .then((r) => {
        for (const [k, v] of r.summary) console.log(`${k}: ${v}`);
        for (const x of r.convergence?.rows ?? []) console.log(`${x.label}: ${x.values.map((v) => v.toPrecision(5)).join(" / ")} → extrapolado ${x.gci.extrapolated.toPrecision(5)} ${x.unit}, p = ${x.gci.p.toFixed(2)}, GCI = ${(100 * x.gci.gciFine).toFixed(2)} %`);
        for (const w of r.warnings) console.log(`Aviso: ${w}`);
      })
      .catch((e) => { console.error((e as Error).message); process.exit(1); });
  } else console.log("Uso: node cad-runner.mjs <pasta-do-caso> | --serve [--port 8765] | --status");
}
