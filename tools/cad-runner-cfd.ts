// Casos CFD (OpenFOAM, SU2) do agente local (movido de cad-runner.ts).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CfdCase } from "../src/sim/case.ts";
import { openfoamCase } from "../src/sim/openfoam.ts";
import { patchAverage, patchFlux, patchPressureForce, readBoundary, readFaces, readLabels, readPoints, readScalarField } from "../src/sim/foamread.ts";
import { su2Config } from "../src/sim/su2.ts";
import { type LayerField, type FoamMeshFull, patchLayer, readField, sliceLayer } from "../src/sim/foamfields.ts";
import { type ResultLayer, type ResultView } from "../src/sim/result.ts";
import { type Metric } from "../src/sim/convergence.ts";
import { type Log, run, foam, tail, tools } from "./cad-runner-proc.ts";
import { gmshMesh } from "./cad-runner-fem.ts";
import type { RunResult } from "./cad-runner.ts";

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

export async function runOpenfoam(c: CfdCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
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

export async function runSu2(c: CfdCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado");
  if (!t.su2) throw new Error("SU2 não encontrado (https://su2code.github.io, ou defina CAD_SU2)");
  if (regenerate) writeFileSync(join(dir, "case.cfg"), su2Config(c));
  await gmshMesh(c, dir, log, { kind: "su2", regenerate });
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
