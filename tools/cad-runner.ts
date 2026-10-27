// Agente local do CAD protótipo: corre os solvers abertos instalados nesta máquina (Gmsh + CalculiX,
// OpenFOAM, SU2) para os casos que a aplicação prepara, e devolve os resultados.
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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CfdCase, FemCase, SimCase } from "../src/sim/case.ts";
import { femGeo, su2Geo } from "../src/sim/gmsh.ts";
import { parseMsh, physicalBlocks, type Msh } from "../src/sim/msh.ts";
import { calculixDeck, femResult, type FemResult } from "../src/sim/calculix.ts";
import { openfoamCase } from "../src/sim/openfoam.ts";
import { patchAverage, patchFlux, patchPressureForce, readBoundary, readFaces, readLabels, readPoints, readScalarField } from "../src/sim/foamread.ts";
import { su2Config } from "../src/sim/su2.ts";
import { type LayerField, type FoamMeshFull, patchLayer, readField, sliceLayer } from "../src/sim/foamfields.ts";
import { type ResultLayer, type ResultView, femView } from "../src/sim/result.ts";
import { type ConvergenceReport, type Metric, convergenceReport } from "../src/sim/convergence.ts";

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
}

type Log = (s: string) => void;

// ---------------------------------------------------------------------------
// Solvers instalados
// ---------------------------------------------------------------------------

const which = (cmd: string) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};
const FOAM_RC = ["/usr/lib/openfoam/openfoam2606/etc/bashrc", "/usr/lib/openfoam/openfoam2512/etc/bashrc", "/usr/lib/openfoam/openfoam2506/etc/bashrc", "/opt/openfoam2606/etc/bashrc", "/usr/share/openfoam/etc/bashrc"];

export function tools() {
  const gmsh = process.env.CAD_GMSH ?? which("gmsh");
  const ccx = process.env.CAD_CCX ?? which("ccx") ?? which("ccx_2.23") ?? which("ccx_2.22");
  const su2 = process.env.CAD_SU2 ?? which("SU2_CFD");
  const foamDirect = which("simpleFoam");
  const foamRc = process.env.CAD_FOAM_BASHRC ?? FOAM_RC.find((p) => existsSync(p)) ?? null;
  const version = (cmd: string | null, args: string[]) => {
    if (!cmd) return null;
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });
    return (r.stdout + r.stderr).trim().split(/\r?\n/)[0]?.slice(0, 80) ?? "";
  };
  return {
    gmsh: gmsh ? { path: gmsh, version: version(gmsh, ["--version"]) } : null,
    calculix: ccx ? { path: ccx, version: version(ccx, ["-v"]) } : null,
    openfoam: foamDirect || foamRc ? { path: foamDirect ?? foamRc!, version: foamRc ? foamRc.replace(/\/etc\/bashrc$/, "") : "no PATH", rc: foamRc } : null,
    su2: su2 ? { path: su2, version: "SU2_CFD" } : null,
  };
}

function run(cmd: string, args: string[], cwd: string, logFile: string, log: Log, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((ok, fail) => {
    log(`$ ${[cmd, ...args].join(" ")}`);
    const out: string[] = [];
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    const take = (b: Buffer) => { out.push(b.toString()); };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", (e) => fail(new Error(`${cmd}: ${e.message}`)));
    p.on("close", (code) => {
      writeFileSync(join(cwd, logFile), out.join(""));
      if (code === 0) ok();
      else fail(new Error(`${cmd} terminou com o código ${code}:\n${out.join("").split(/\r?\n/).slice(-15).join("\n")}`));
    });
  });
}

/**
 * Comandos do OpenFOAM: com o ambiente já carregado (WM_PROJECT_DIR) correm diretamente; senão,
 * pelo bashrc da instalação (os executáveis precisam do ambiente para encontrar o diretório etc).
 */
function foam(cmd: string, args: string[], cwd: string, log: Log) {
  const t = tools().openfoam;
  if (!t) throw new Error("OpenFOAM não encontrado (instale a versão openfoam.com ou defina CAD_FOAM_BASHRC)");
  if (process.env.WM_PROJECT_DIR || !t.rc) return run(cmd, args, cwd, `log.${cmd}`, log);
  const quoted = [cmd, ...args].map((a) => `'${a.replace(/'/g, "")}'`).join(" ");
  return run("bash", ["-c", `. '${t.rc}' >/dev/null 2>&1; exec ${quoted}`], cwd, `log.${cmd}`, log);
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

/** Confere os grupos da malha com as faces do CAD (centroide médio dos triângulos de cada grupo). */
function checkGroups(c: FemCase, m: Msh): string[] {
  const out: string[] = [];
  const diag = Math.hypot(...c.bbox.max.map((x, i) => x - c.bbox.min[i]));
  for (const [name, tags] of Object.entries(c.groups)) {
    const faces = c.faces.filter((f) => tags.includes(f.tag));
    const A = faces.reduce((s, f) => s + f.area, 0);
    const want = [0, 1, 2].map((k) => faces.reduce((s, f) => s + f.center[k] * f.area, 0) / A);
    let a = 0;
    const got = [0, 0, 0];
    for (const b of physicalBlocks(m, name)) {
      const per = b.type === 9 ? 6 : 3;
      for (let k = 0; k < b.conn.length; k += per) {
        const [P, Q, R] = b.conn.slice(k, k + 3).map((t) => m.nodes.get(t)!);
        const u = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]], v = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
        const ar = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        a += ar;
        for (let q = 0; q < 3; q++) got[q] += ((P[q] + Q[q] + R[q]) / 3) * ar;
      }
    }
    if (!a) { out.push(`Grupo ${name}: sem triângulos na malha`); continue; }
    const d = Math.hypot(...got.map((x, q) => x / a - want[q]));
    if (d > 0.02 * diag || Math.abs(a - A) > 0.05 * A) out.push(`Grupo ${name}: a malha não corresponde às faces do CAD (desvio ${d.toFixed(2)} mm, área ${a.toFixed(1)} vs ${A.toFixed(1)} mm²)`);
  }
  return out;
}

async function runFem(c: FemCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
  if (!t.calculix) throw new Error("CalculiX (ccx) não encontrado (http://www.calculix.de, ou defina CAD_CCX)");
  if (regenerate || !existsSync(join(dir, "mesh.geo"))) writeFileSync(join(dir, "mesh.geo"), femGeo(c));
  await run(t.gmsh.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], dir, "log.gmsh", log);
  const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const warnings = checkGroups(c, msh);
  if (warnings.length) throw new Error(warnings.join("\n"));
  const deck = calculixDeck(c, msh);
  warnings.push(...deck.warnings);
  writeFileSync(join(dir, "job.inp"), deck.inp);
  log(`malha: ${deck.nodes} nós, ${deck.elements} elementos`);
  await run(t.calculix.path, ["-i", "job"], dir, "log.ccx", log, { OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "2" });
  const fem = femResult(c, msh, readFileSync(join(dir, "job.frd"), "utf8"), existsSync(join(dir, "job.dat")) ? readFileSync(join(dir, "job.dat"), "utf8") : "");
  const summary: [string, string][] = [["Malha", `${deck.nodes} nós · ${deck.elements} tetraedros de ordem ${c.mesh.order}`], ...fem.summary];
  return { ok: true, physics: "fem", solver: `CalculiX ${t.calculix.version ?? ""}`.trim(), summary, warnings, fem, view: femView(fem), metrics: fem.metrics, cells: deck.elements, log: tail(join(dir, "log.ccx")) };
}

/**
 * Camadas do resultado CFD: patches (paredes/corpo, entrada, saída) com a pressão e três cortes
 * pelo centro do corpo com a pressão e |U|. Visíveis por omissão: interno — entrada, saída e o corte
 * que contém o escoamento; externo — corpo e esse corte.
 */
function cfdView(c: CfdCase, mesh: FoamMeshFull, p: ReturnType<typeof readField>, U: ReturnType<typeof readField>): ResultView {
  const pres: LayerField = { name: "Pressão", unit: "Pa", field: p, ncomp: 1, map: (v) => v[0] * c.fluid.rho };
  const vel: LayerField = { name: "Velocidade", unit: "m/s", field: U, ncomp: 3, map: (v) => Math.hypot(v[0], v[1], v[2]) };
  const internal = c.regime === "internal";
  const layers: ResultLayer[] = [];
  const add = (l: ResultLayer | null) => { if (l) layers.push(l); };
  if (internal) {
    add(patchLayer("Paredes", mesh, "walls", [pres, null], false));
    add(patchLayer("Entrada", mesh, "inlet", [pres, vel], true));
    add(patchLayer("Saída", mesh, "outlet", [pres, vel], true));
  } else add(patchLayer("Corpo", mesh, "body", [pres, null], true));
  const ax = [0, 1, 2].reduce((m, k) => (Math.abs(c.velocity[k]) > Math.abs(c.velocity[m]) ? k : m), 0);
  const show = ax === 2 ? 1 : 2;
  const mid = [0, 1, 2].map((k) => ((c.bbox.min[k] + c.bbox.max[k]) / 2) * 1e-3);
  for (const k of [0, 1, 2]) {
    const n = [0, 0, 0];
    n[k] = 1;
    add(sliceLayer(`Corte ${"XYZ"[k]} = ${(mid[k] * 1000).toFixed(1)} mm`, mesh, mid, n, [pres, vel], k === show));
  }
  return { fields: [{ name: pres.name, unit: pres.unit }, { name: vel.name, unit: vel.unit }], modes: [], layers };
}

/** Diretivas de dicionário do OpenFOAM que executam código (recusadas nos ficheiros recebidos). */
const UNSAFE = /#(codeStream|calc|include|includeEtc|includeFunc|eval)\b|\bcode(Include|Options|Libs)?\s*#?\{/;

async function runOpenfoam(c: CfdCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  if (regenerate) {
    const stl: Record<string, string> = {};
    for (const name of Object.keys(c.groups)) stl[name] = readFileSync(join(dir, `constant/triSurface/${name}.stl`), "utf8");
    for (const [p, text] of Object.entries(openfoamCase(c, stl))) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); }
  }
  // nenhum dicionário pode trazer código (#codeStream, #calc, …): os solvers correm na máquina do utilizador
  for (const sub of ["system", "constant", "0"]) for (const fn of readdirSync(join(dir, sub))) {
    const p = join(dir, sub, fn);
    if (!statSync(p).isFile() || fn.endsWith(".stl")) continue;
    if (UNSAFE.test(readFileSync(p, "utf8"))) throw new Error(`Diretiva não permitida em ${sub}/${fn}`);
  }
  await foam("blockMesh", [], dir, log);
  await foam("surfaceFeatureExtract", [], dir, log);
  await foam("snappyHexMesh", ["-overwrite"], dir, log);
  await foam("checkMesh", [], dir, log).catch(() => log("checkMesh com avisos"));
  const warnings: string[] = [];
  try {
    await foam("simpleFoam", [], dir, log);
  } catch (e) {
    // algumas compilações falham nos function objects: repetir sem eles (o resumo vem dos campos)
    if (!/sha1|functionObject|function object/i.test((e as Error).message)) throw e;
    warnings.push("Os function objects falharam nesta instalação do OpenFOAM: cálculo repetido com -noFunctionObjects");
    await foam("simpleFoam", ["-noFunctionObjects"], dir, log);
  }
  const L = readFileSync(join(dir, "log.simpleFoam"), "utf8");
  const conv = /SIMPLE solution converged in (\d+) iterations/.exec(L);
  const iters = [...L.matchAll(/^Time = (\d+)/gm)].length;
  const cells = /cells:\s+(\d+)/.exec(tail(join(dir, "log.checkMesh"), 400))?.[1];
  const summary: [string, string][] = [
    ["Malha", `${cells ?? "?"} células (snappyHexMesh)`],
    ["Iterações", conv ? `${conv[1]} (convergido)` : `${iters} (sem atingir os resíduos pedidos)`],
    ["Re", c.reynolds.toExponential(2)],
  ];
  if (!conv) warnings.push("O simpleFoam não convergiu para os resíduos pedidos: aumente as iterações ou reveja a malha");
  // resumo e campos a partir do último tempo (independente da versão e dos function objects)
  const metrics: Metric[] = [];
  let view: ResultView | undefined;
  const times = readdirSync(dir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== "0").sort((a, b) => Number(a) - Number(b));
  const last = times.at(-1);
  if (last) {
    const pm = join(dir, "constant/polyMesh");
    const mesh: FoamMeshFull = { points: readPoints(readFileSync(join(pm, "points"), "utf8")), faces: readFaces(readFileSync(join(pm, "faces"), "utf8")), owner: readLabels(readFileSync(join(pm, "owner"), "utf8")), neighbour: readLabels(readFileSync(join(pm, "neighbour"), "utf8")), boundary: readBoundary(readFileSync(join(pm, "boundary"), "utf8")) };
    const phi = existsSync(join(dir, last, "phi")) ? readScalarField(readFileSync(join(dir, last, "phi"), "utf8")) : null;
    const pText = readFileSync(join(dir, last, "p"), "utf8");
    const p = readScalarField(pText);
    if (phi && mesh.boundary.has("inlet") && mesh.boundary.has("outlet")) {
      const Qi = -patchFlux(phi, mesh, "inlet"), Qo = patchFlux(phi, mesh, "outlet");
      const bal = (100 * (Qo - Qi)) / Math.max(Math.abs(Qi), 1e-30);
      summary.push(["Caudal de entrada", `${(Qi * 1000).toPrecision(5)} L/s`], ["Balanço de massa", `${bal.toFixed(3)} %`]);
      metrics.push({ key: "q", label: "Caudal de entrada", unit: "L/s", value: Qi * 1000 });
    }
    if (c.regime === "internal" && mesh.boundary.has("inlet") && mesh.boundary.has("outlet")) {
      const dp = (patchAverage(p, mesh, "inlet") - patchAverage(p, mesh, "outlet")) * c.fluid.rho;
      summary.push(["Queda de pressão", `${dp.toPrecision(5)} Pa`]);
      metrics.push({ key: "dp", label: "Queda de pressão", unit: "Pa", value: dp });
    }
    if (c.regime === "external" && mesh.boundary.has("body")) {
      const F = patchPressureForce(p, mesh, "body", c.fluid.rho);
      const U = Math.hypot(...c.velocity), dir = c.velocity.map((x) => x / U);
      const drag = F[0] * dir[0] + F[1] * dir[1] + F[2] * dir[2];
      // área de referência: projeção da caixa envolvente do corpo no plano normal ao escoamento
      const ax = [0, 1, 2].reduce((m, k) => (Math.abs(dir[k]) > Math.abs(dir[m]) ? k : m), 0);
      const ext = [0, 1, 2].map((k) => (c.bbox.max[k] - c.bbox.min[k]) * 1e-3);
      const Aref = ext.filter((_, k) => k !== ax).reduce((a, b) => a * b, 1);
      const cd = drag / (0.5 * c.fluid.rho * U * U * Aref);
      summary.push(["Força de pressão no corpo (N)", F.map((x) => x.toPrecision(4)).join(" · ")], ["Arrasto de pressão", `${drag.toPrecision(4)} N (Cd ≈ ${cd.toFixed(3)}, área ${(Aref * 1e6).toFixed(0)} mm²)`]);
      metrics.push({ key: "drag", label: "Arrasto de pressão", unit: "N", value: drag }, { key: "cd", label: "Cd (pressão)", unit: "", value: cd });
      warnings.push("Força calculada só com a pressão: falta a parcela viscosa (use o function object forces/wallShearStress do OpenFOAM)");
    }
    try {
      view = cfdView(c, mesh, readField(pText), readField(readFileSync(join(dir, last, "U"), "utf8")));
    } catch (e) {
      warnings.push(`Campos para o 3D não lidos: ${(e as Error).message}`);
    }
  }
  const nCells = Number(cells) || 0;
  return { ok: true, physics: "cfd", solver: "OpenFOAM simpleFoam", summary, warnings, view, metrics, cells: nCells, log: L.split(/\r?\n/).slice(-30).join("\n") };
}

async function runSu2(c: CfdCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado");
  if (!t.su2) throw new Error("SU2 não encontrado (https://su2code.github.io, ou defina CAD_SU2)");
  if (regenerate) { writeFileSync(join(dir, "mesh.geo"), su2Geo(c)); writeFileSync(join(dir, "case.cfg"), su2Config(c)); }
  await run(t.gmsh.path, ["mesh.geo", "-3", "-format", "su2", "-o", "mesh.su2"], dir, "log.gmsh", log);
  await run(t.su2.path, ["case.cfg"], dir, "log.su2", log);
  const hist = existsSync(join(dir, "history.csv")) ? readFileSync(join(dir, "history.csv"), "utf8").trim().split(/\r?\n/) : [];
  const summary: [string, string][] = [["Iterações", String(Math.max(0, hist.length - 1))], ["Re", c.reynolds.toExponential(2)]];
  const metrics: Metric[] = [];
  if (hist.length > 1) {
    const h = hist[0].split(",").map((x) => x.replace(/"/g, "").trim()), v = hist.at(-1)!.split(",");
    h.forEach((k, i) => {
      if (!/rms\[P\]|CD|CL/i.test(k)) return;
      summary.push([k, v[i].trim()]);
      if (/^C[DL]$/i.test(k)) metrics.push({ key: k.toLowerCase(), label: k, unit: "", value: Number(v[i]) });
    });
  }
  const nelem = Number(/NELEM=\s*(\d+)/.exec(readFileSync(join(dir, "mesh.su2"), "utf8").slice(0, 400))?.[1] ?? 0);
  return { ok: true, physics: "cfd", solver: "SU2", summary, warnings: [], metrics, cells: nelem, log: tail(join(dir, "log.su2")) };
}

const tail = (p: string, n = 25) => (existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/).slice(-n).join("\n") : "");

export interface RunOptions {
  /** Estudo de convergência: três malhas com tamanhos h, r·h, r²·h (a pedida é a mais fina). */
  convergence?: { ratio: number };
}

async function runOnce(c: SimCase, dir: string, log: Log, regenerate: boolean) {
  return c.physics === "fem" ? runFem(c, dir, log, regenerate)
    : c.solver === "openfoam" ? runOpenfoam(c, dir, log, regenerate) : runSu2(c, dir, log, regenerate);
}

/** Caso com a malha engrossada pelo fator `k` (tamanhos × k; refinamento por curvatura ÷ k). */
export function coarsened(c: SimCase, k: number): SimCase {
  if (c.physics === "fem") {
    const curv = c.mesh.curvature > 0 ? Math.max(4, Math.round(c.mesh.curvature / k)) : 0;
    return { ...c, mesh: { ...c.mesh, size: c.mesh.size * k, minSize: c.mesh.minSize * k, curvature: curv, local: c.mesh.local.map((l) => ({ ...l, size: l.size * k })) } };
  }
  return { ...c, mesh: { ...c.mesh, size: c.mesh.size * k } };
}

/** Corre o caso de uma pasta (case.json + model.brep [+ STL]). `regenerate`: refaz os ficheiros dos solvers a partir do caso. */
export async function runCase(dir: string, log: Log = () => {}, regenerate = false, opts: RunOptions = {}): Promise<RunResult> {
  const t0 = Date.now();
  const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as SimCase;
  if (c.format !== "cadp-sim-case") throw new Error("case.json inválido");
  let r: Omit<RunResult, "seconds" | "hypotheses">;
  if (opts.convergence) {
    const ratio = opts.convergence.ratio;
    if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
    // da mais grossa (mais rápida, falha cedo) para a pedida
    const runs: Omit<RunResult, "seconds" | "hypotheses">[] = [];
    for (const lvl of [2, 1, 0]) {
      const sub = join(dir, `malha${lvl + 1}`);
      mkdirSync(sub, { recursive: true });
      const ck = coarsened(c, ratio ** lvl);
      writeFileSync(join(sub, "case.json"), JSON.stringify(ck));
      writeFileSync(join(sub, "model.brep"), readFileSync(join(dir, "model.brep")));
      if (existsSync(join(dir, "constant/triSurface"))) {
        mkdirSync(join(sub, "constant/triSurface"), { recursive: true });
        for (const fn of readdirSync(join(dir, "constant/triSurface"))) if (fn.endsWith(".stl")) writeFileSync(join(sub, "constant/triSurface", fn), readFileSync(join(dir, "constant/triSurface", fn)));
      }
      log(`— malha ${lvl + 1} de 3 (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
      runs[lvl] = await runOnce(ck, sub, log, true);
    }
    const report = convergenceReport(ratio, runs.map((x, i) => ({ cells: x.cells, size: c.mesh.size * ratio ** i, metrics: x.metrics })));
    r = { ...runs[0], convergence: report, warnings: [...runs[0].warnings, ...report.rows.flatMap((x) => x.gci.notes.map((n) => `${x.label}: ${n}`))] };
  } else r = await runOnce(c, dir, log, regenerate);
  const res: RunResult = { ...r, summary: [...r.summary], hypotheses: c.hypotheses, seconds: (Date.now() - t0) / 1000 };
  writeFileSync(join(dir, "results.json"), JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------------------
// Servidor local
// ---------------------------------------------------------------------------

/** Pedido da aplicação: o caso, a geometria e (CFD/OpenFOAM) as superfícies STL de cada patch. */
export interface RunRequest { case: SimCase; brep: string; stl?: Record<string, string>; convergence?: { ratio: number } }

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
    if (req.method !== "POST" || req.url !== "/run") { send(404, { error: "Pedido desconhecido" }); return; }
    if (busy) { send(409, { error: "O agente está ocupado com outro cálculo" }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) { size += (ch as Buffer).length; if (size > 200e6) { send(413, { error: "Pedido demasiado grande" }); return; } chunks.push(ch as Buffer); }
    busy = true;
    const dir = mkdtempSync(join(tmpdir(), "cad-run-"));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunRequest;
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
      const conv = body.convergence && Number.isFinite(Number(body.convergence.ratio)) ? { ratio: Number(body.convergence.ratio) } : undefined;
      const r = await runCase(dir, (s) => console.log(s), true, { convergence: conv });
      send(200, r);
    } catch (e) {
      send(500, { error: (e as Error).message, log: tail(join(dir, "log.ccx")) || tail(join(dir, "log.gmsh")) });
    } finally {
      busy = false;
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
