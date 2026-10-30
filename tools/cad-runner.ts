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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CfdCase, FemCase, SimCase } from "../src/sim/case.ts";
import { femGeo, su2Geo } from "../src/sim/gmsh.ts";
import { elementsOf, faceBlocks, parseMsh, physicalBlocks, solidBlocks, type Msh } from "../src/sim/msh.ts";
import { faceIntegrals } from "../src/sim/elements.ts";
import { meshPreview } from "../src/sim/meshview.ts";
import type { MeshQuality } from "../src/sim/quality.ts";
import { calculixDeck, femResult, type FemResult } from "../src/sim/calculix.ts";
import { openfoamCase } from "../src/sim/openfoam.ts";
import { patchAverage, patchFlux, patchPressureForce, readBoundary, readFaces, readLabels, readPoints, readScalarField } from "../src/sim/foamread.ts";
import { su2Config } from "../src/sim/su2.ts";
import { asterCase, asterResult } from "../src/sim/aster.ts";
import { type LayerField, type FoamMeshFull, patchLayer, readField, sliceLayer } from "../src/sim/foamfields.ts";
import { type ResultLayer, type ResultView, femView } from "../src/sim/result.ts";
import { type ConvergenceReport, type GciResult, type Metric, convergenceReport, gci, isMonotonic } from "../src/sim/convergence.ts";
import { type XfoilRequest, type XfoilResult, XFOIL_HYPOTHESES, parsePolar, polarSummary, xfoilCommands, xfoilRetryCommands } from "../src/sim/xfoil.ts";

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
  // code_aster: PATH, ou um ambiente conda/micromamba "aster" (instalação recomendada: conda-forge)
  const home = process.env.HOME ?? "";
  const condaAster = [process.env.CONDA_PREFIX && `${process.env.CONDA_PREFIX}/bin/run_aster`, `${home}/micromamba/envs/aster/bin/run_aster`, `${home}/miniforge3/envs/aster/bin/run_aster`, "/opt/mamba/root/envs/aster/bin/run_aster", "/opt/conda/envs/aster/bin/run_aster"].find((p) => p && existsSync(p));
  const aster = process.env.CAD_ASTER ?? which("run_aster") ?? which("as_run") ?? condaAster ?? null;
  const xfoil = process.env.CAD_XFOIL ?? which("xfoil");
  // OpenFOAM nativo para Windows (versão MinGW da openfoam.com): pasta OpenFOAM-vXXXX com platforms/*/bin
  const foamDir = process.env.CAD_FOAM_DIR && existsSync(process.env.CAD_FOAM_DIR) ? process.env.CAD_FOAM_DIR : null;
  const foamBin = foamDir ? (() => { const pl = join(foamDir, "platforms"); const t = existsSync(pl) ? readdirSync(pl).find((d) => existsSync(join(pl, d, "bin"))) : undefined; return t ? join(pl, t, "bin") : null; })() : null;
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
    openfoam: foamDir && foamBin
      ? { path: foamBin, version: foamDir.replace(/.*[\\/]/, ""), rc: null, dir: foamDir, bin: foamBin }
      : foamDirect || foamRc ? { path: foamDirect ?? foamRc!, version: foamRc ? foamRc.replace(/\/etc\/bashrc$/, "") : "no PATH", rc: foamRc } : null,
    su2: su2 ? { path: su2, version: "SU2_CFD" } : null,
    code_aster: aster ? { path: aster, version: aster.endsWith("as_run") ? "as_run" : "run_aster" } : null,
    xfoil: xfoil ? { path: xfoil, version: "XFOIL 6.9x", preload: process.env.CAD_XFOIL_PRELOAD ?? null } : null,
  };
}

/** Ambiente do processo com variáveis extra; `PATH` junta-se ao existente (no Windows a chave é "Path"). */
function withEnv(extra?: NodeJS.ProcessEnv & { PATH_PREPEND?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!extra) return env;
  const { PATH_PREPEND, ...rest } = extra;
  Object.assign(env, rest);
  if (PATH_PREPEND) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${PATH_PREPEND}${process.platform === "win32" ? ";" : ":"}${env[key] ?? ""}`;
  }
  return env;
}

function run(cmd: string, args: string[], cwd: string, logFile: string, log: Log, env?: NodeJS.ProcessEnv & { PATH_PREPEND?: string }): Promise<void> {
  return new Promise((ok, fail) => {
    log(`$ ${[cmd, ...args].join(" ")}`);
    const out: string[] = [];
    // lançadores .cmd/.bat (code_aster no Windows) só correm através do cmd.exe; os argumentos são
    // nomes de ficheiros gerados aqui (sem aspas nem metacaracteres)
    const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
    if (script && args.some((a) => /["&|<>^%]/.test(a))) { fail(new Error(`Argumento inválido para ${cmd}`)); return; }
    const p = script
      ? spawn(`"${cmd}"`, args.map((a) => `"${a}"`), { cwd, env: withEnv(env), shell: true })
      : spawn(cmd, args, { cwd, env: withEnv(env) });
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
  if ("dir" in t && t.dir) {
    // Windows: o ambiente do setEnvVariables-vXXXX.bat oficial, sem MSYS2 nem MPI (Pstream de série)
    const version = t.dir.replace(/.*[\\/]OpenFOAM-/, "");
    return run(join(t.bin, `${cmd}.exe`), args, cwd, `log.${cmd}`, log, { WM_PROJECT: "OpenFOAM", WM_PROJECT_VERSION: version, WM_PROJECT_DIR: t.dir, FOAM_SIGFPE: "1", PATH_PREPEND: t.bin });
  }
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
    for (const { type, nodes } of elementsOf(faceBlocks(m, name))) {
      const P = nodes.map((t) => m.nodes.get(t)!);
      const fi = faceIntegrals(type, P);
      a += fi.area;
      // centroide da face pelas áreas nodais consistentes
      fi.nodal.forEach((w, i) => { for (let q = 0; q < 3; q++) got[q] += w * P[i][q]; });
    }
    if (!a) { out.push(`Grupo ${name}: sem faces na malha`); continue; }
    const d = Math.hypot(...got.map((x, q) => x / a - want[q]));
    if (d > 0.02 * diag || Math.abs(a - A) > 0.05 * A) out.push(`Grupo ${name}: a malha não corresponde às faces do CAD (desvio ${d.toFixed(2)} mm, área ${a.toFixed(1)} vs ${A.toFixed(1)} mm²)`);
  }
  // montagens: cada volume da malha tem de cair na caixa do corpo correspondente
  for (const b of c.bodies ?? []) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const bl of physicalBlocks(m, b.group)) for (const t of bl.conn) { const p = m.nodes.get(t)!; for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p[q]); hi[q] = Math.max(hi[q], p[q]); } }
    const dev = Math.max(...[0, 1, 2].map((q) => Math.max(Math.abs(lo[q] - b.bbox.min[q]), Math.abs(hi[q] - b.bbox.max[q]))));
    if (!Number.isFinite(dev) || dev > 0.02 * diag) out.push(`Corpo ${b.name} (${b.group}): o volume da malha não corresponde ao corpo do CAD`);
  }
  // seeds e faces mapeadas: as curvas do Gmsh têm de ser as arestas do CAD com a mesma tag
  for (const cv of c.mesh.curves ?? []) {
    const box = m.entityBox.get(`1:${cv.tag}`);
    const dev = box ? Math.max(...[0, 1, 2].map((q) => Math.max(Math.abs(box[q] - cv.box.min[q]), Math.abs(box[q + 3] - cv.box.max[q])))) : Infinity;
    if (dev > 1e-3 * diag + 1e-6) { out.push(`Aresta ${cv.tag}: a curva do Gmsh não corresponde à aresta do CAD (numeração diferente) — as seeds não podem ser aplicadas`); break; }
  }
  return out;
}

/** Descrição curta dos elementos da malha (resumo). */
const meshKind = (c: FemCase) => (c.mesh.element === "hex" ? `hexaedros ${c.mesh.order === 2 ? "de 20 nós" : "de 8 nós"}${c.mesh.hexMethod === "subdivision" ? " (subdivisão)" : " (estruturados)"}` : `tetraedros de ordem ${c.mesh.order}`);

/** code_aster: mesma malha Gmsh, malha ASTER + .comm gerados aqui, run_aster com o .export. */
async function runAster(c: FemCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
  if (!t.code_aster) throw new Error("code_aster (run_aster) não encontrado (https://code-aster.org, ou defina CAD_ASTER)");
  if (regenerate || !existsSync(join(dir, "mesh.geo"))) writeFileSync(join(dir, "mesh.geo"), femGeo(c));
  await run(t.gmsh.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], dir, "log.gmsh", log);
  const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const warnings = checkGroups(c, msh);
  if (warnings.length) throw new Error(warnings.join("\n"));
  const ac = asterCase(c, msh);
  warnings.push(...ac.warnings);
  for (const [p, text] of Object.entries(ac.files)) writeFileSync(join(dir, p), text);
  await run(t.code_aster.path, ["job.export"], dir, "log.aster", log);
  const rd = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
  const u = rd("u.tab");
  if (!u) throw new Error(`O code_aster não escreveu os resultados:\n${tail(join(dir, "job.mess"), 30)}`);
  const fem = asterResult(c, msh, { u, vm: rd("vm.tab"), freq: rd("freq.tab"), reac: rd("reac.tab"), peeq: rd("peeq.tab") }, ac.nodeOrder);
  const elements = [...elementsOf(solidBlocks(msh, c.bodies))].length;
  const summary: [string, string][] = [["Malha", `${ac.nodeOrder.length} nós · ${elements} ${meshKind(c)}`], ...fem.summary];
  return { ok: true, physics: "fem", solver: "code_aster", summary, warnings, fem, view: femView(fem), metrics: fem.metrics, cells: elements, log: tail(join(dir, "job.mess")) };
}

async function runFem(c: FemCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  if (c.solver === "code_aster") return runAster(c, dir, log, regenerate);
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
  const fem = femResult(c, msh, readFileSync(join(dir, "job.frd"), "utf8"), existsSync(join(dir, "job.dat")) ? readFileSync(join(dir, "job.dat"), "utf8") : "", deck.supportLoad);
  const summary: [string, string][] = [["Malha", `${deck.nodes} nós · ${deck.elements} ${meshKind(c)}`], ...fem.summary];
  if (deck.dynamic) {
    summary.splice(1, 0, ["Integração no tempo", `${c.dynamic!.scheme === "explicit" ? "explícita" : "implícita"}, passo ${deck.dynamic.dt.toExponential(3)} s${deck.dynamic.stable ? " (estável da malha)" : ""}, ${deck.dynamic.increments} incrementos`]);
    // o CalculiX escala a massa (seletivamente) quando o passo pedido passa o estável
    const lg = existsSync(join(dir, "log.ccx")) ? readFileSync(join(dir, "log.ccx"), "utf8") : "";
    const sc = /Scaling factor of time increment:\s*([\d.Ee+-]+)/.exec(lg);
    if (/Selective Mass Scaling is active/.test(lg) || (sc && Number(sc[1]) > 1.0001)) warnings.push(`O passo pedido passa o limite de estabilidade: o CalculiX escalou a massa (fator ${sc?.[1] ?? "?"} no passo) — os modos altos ficam alterados; deixe o passo em branco para usar o estável`);
  }
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
      if (!/rms\[P\]|^C[DL]$|Press|Massflow|Drop/i.test(k)) return;
      summary.push([k, v[i].trim()]);
      if (/^C[DL]$/i.test(k)) metrics.push({ key: k.toLowerCase(), label: k, unit: "", value: Number(v[i]) });
      // queda de pressão entre os marcadores analisados (entrada → saída), em Pa (SU2 dimensional)
      if (/Pressure_Drop/i.test(k)) metrics.push({ key: "dp", label: "Queda de pressão", unit: "Pa", value: Math.abs(Number(v[i])) });
      if (/Massflow/i.test(k) && !metrics.some((m) => m.key === "mdot")) metrics.push({ key: "mdot", label: "Caudal mássico", unit: "kg/s", value: Math.abs(Number(v[i])) });
    });
    const rms = h.findIndex((k) => /rms\[P\]/i.test(k));
    if (rms >= 0) metrics.push({ key: "rmsP", label: "Resíduo RMS de pressão (log10)", unit: "", value: Number(v[rms]) });
  }
  const nelem = Number(/NELEM=\s*(\d+)/.exec(readFileSync(join(dir, "mesh.su2"), "utf8").slice(0, 400))?.[1] ?? 0);
  return { ok: true, physics: "cfd", solver: "SU2", summary, warnings: [], metrics, cells: nelem, log: tail(join(dir, "log.su2")) };
}

const tail = (p: string, n = 25) => (existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/).slice(-n).join("\n") : "");

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
  writeFileSync(join(dir, "mesh.geo"), femGeo(c));
  await run(t.gmsh.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], dir, "log.gmsh", log);
  const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
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
    let metric = opts.convergence.metric, stop: string | undefined;
    for (let k = n; k >= -n; k--) {
      // estimativa dos elementos da malha seguinte (∝ h⁻³) a partir da anterior
      if (runs.length && runs.at(-1)!.cells * ratio ** 3 > maxCells) { stop = `as malhas abaixo de ${steps.at(-1)!.size.toPrecision(3)} mm passariam de ${maxCells.toExponential(1)} elementos`; break; }
      const { sub, ck } = prepare(ratio ** k, `nivel${k >= 0 ? "+" : ""}${k}`);
      log(`— nível ${k > 0 ? "+" : ""}${k} (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
      const r1 = await runOnce(ck, sub, log, true);
      runs.push(r1);
      metric ??= r1.metrics.find((x) => x.key.startsWith("probe"))?.key ?? r1.metrics[0]?.key;
      steps.push({ level: k, size: ck.mesh.size, cells: r1.cells, value: r1.metrics.find((x) => x.key === metric)?.value ?? NaN });
    }
    if (runs.length < 3) throw new Error(`Varrimento: só ${runs.length} malha(s) cabem no limite de ${maxCells.toExponential(1)} elementos — aumente o tamanho pedido`);
    const fine = runs.slice(-3).reverse();
    const report = convergenceReport(ratio, fine.map((x, i) => ({ cells: x.cells, size: steps[steps.length - 1 - i].size, metrics: x.metrics })));
    const row = report.rows.find((x) => x.key === metric);
    const base = steps.find((x) => x.level === 0)!.value;
    const values = steps.map((x) => x.value).filter(Number.isFinite);
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
    let metric = opts.convergence.metric;
    let achieved = false, stop = "";
    for (let k = 0; k < maxLevels; k++) {
      const { sub, ck } = prepare(ratio ** -k, `nivel${k + 1}`);
      log(`— nível ${k + 1} (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
      const r1 = await runOnce(ck, sub, log, true);
      runs.push(r1);
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
    report.auto = { target, metric: metric ?? "", achieved, stop, steps };
    const fine = runs.at(-1)!;
    r = { ...fine, convergence: report, warnings: [...fine.warnings, ...(achieved ? [] : [`Convergência não atingida: ${stop}`]), ...report.rows.filter((x) => x.key === metric).flatMap((x) => x.gci.notes.map((n) => `${x.label}: ${n}`))] };
  } else if (opts.convergence) {
    const ratio = opts.convergence.ratio;
    if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
    // da mais grossa (mais rápida, falha cedo) para a pedida
    const runs: Omit<RunResult, "seconds" | "hypotheses">[] = [];
    for (const lvl of [2, 1, 0]) {
      const { sub, ck } = prepare(ratio ** lvl, `malha${lvl + 1}`);
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
export interface RunRequest { case: SimCase; brep: string; stl?: Record<string, string>; convergence?: RunOptions["convergence"] }

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
    if (req.method !== "POST" || (req.url !== "/run" && req.url !== "/xfoil" && req.url !== "/mesh")) { send(404, { error: "Pedido desconhecido" }); return; }
    if (busy) { send(409, { error: "O agente está ocupado com outro cálculo" }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) { size += (ch as Buffer).length; if (size > 200e6) { send(413, { error: "Pedido demasiado grande" }); return; } chunks.push(ch as Buffer); }
    busy = true;
    if (req.url === "/xfoil") {
      try { send(200, await runXfoil(JSON.parse(Buffer.concat(chunks).toString("utf8")) as XfoilRequest, (s) => console.log(s))); }
      catch (e) { send(500, { error: (e as Error).message }); }
      finally { busy = false; }
      return;
    }
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
      const cv = body.convergence;
      const fin = (x: unknown) => (x === undefined || x === null ? undefined : Number.isFinite(Number(x)) ? Number(x) : undefined);
      const conv = cv && Number.isFinite(Number(cv.ratio)) ? { ratio: Number(cv.ratio), target: fin(cv.target), metric: typeof cv.metric === "string" ? cv.metric : undefined, maxLevels: fin(cv.maxLevels), maxCells: fin(cv.maxCells), sweep: fin(cv.sweep) } : undefined;
      const r = req.url === "/mesh" ? await previewMesh(dir, (s) => console.log(s)) : await runCase(dir, (s) => console.log(s), true, { convergence: conv });
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
