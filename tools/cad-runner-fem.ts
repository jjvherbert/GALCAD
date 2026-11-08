// Malha (Gmsh) e casos FEM (CalculiX, code_aster, Radioss) do agente local (movido de cad-runner.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import type { CfdCase, FemCase, SimCase } from "../src/sim/case.ts";
import { type Algo3D, femGeo, type GeoOpts, su2Geo } from "../src/sim/gmsh.ts";
import { edgeBlocks, elementsOf, faceBlocks, parseMsh, physicalBlocks, solidBlocks, type Msh } from "../src/sim/msh.ts";
import { faceIntegrals, lineIntegrals } from "../src/sim/elements.ts";
import { type VtkFrame, parseVtk, radiossBlocks, radiossDeck } from "../src/sim/radioss.ts";
import { calculixDeck, femResult, femResultFrom } from "../src/sim/calculix.ts";
import { asterCase, asterResult } from "../src/sim/aster.ts";
import { femView } from "../src/sim/result.ts";
import { type Log, jobState, CancelledError, run, tail, tools, withEnv } from "./cad-runner-proc.ts";
import type { RunResult } from "./cad-runner.ts";

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

/** Confere os grupos da malha com as faces do CAD (centroide médio dos triângulos de cada grupo). */
export function checkGroups(c: FemCase, m: Msh): string[] {
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
  // arestas: comprimento das linhas da malha contra o do CAD
  for (const name of Object.keys(c.edgeGroups ?? {})) {
    let len = 0;
    for (const { type, nodes } of elementsOf(edgeBlocks(m, name))) len += lineIntegrals(type, nodes.map((t) => m.nodes.get(t)!)).length;
    const L = c.edgeLength?.[name];
    if (!len) out.push(`Grupo ${name}: sem linhas na malha`);
    else if (L && Math.abs(len - L) > 0.05 * L) out.push(`Grupo ${name}: a malha não corresponde às arestas do CAD (comprimento ${len.toFixed(1)} vs ${L.toFixed(1)} mm)`);
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

/**
 * Traduz os erros habituais do `log.gmsh` para uma mensagem legível (com as superfícies em causa);
 * `null` se não reconhecer nada. As faces do Gmsh têm a numeração do núcleo (o BREP é o mesmo).
 */
export function gmshError(logText: string): string | null {
  const errs = logText.split(/\r?\n/).filter((l) => /^Error\s*:/.test(l)).map((l) => l.replace(/^Error\s*:\s*/, "").trim());
  if (!errs.length) return null;
  const all = errs.join("\n");
  const faces = [...new Set([...all.matchAll(/surface\s+(\d+)/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const where = faces.length ? ` (faces ${faces.join(", ")})` : "";
  if (/self[- ]?intersect|intersecting facets|overlapping facets|PLC Error|invalid PLC/i.test(all))
    return `A superfície da peça intersecta-se a si própria ou tem faces sobrepostas${where}. Reveja arredondamentos/furos tangentes ou faces coincidentes.`;
  if (/boundary recovery|could not recover/i.test(all))
    return `O gerador 3D não conseguiu respeitar a malha das faces${where}. Normalmente é uma face muito fina ou um ângulo muito agudo; tente um tamanho de elemento menor nessa zona.`;
  if (/no (volume|elements) in|not closed|unable to recover the volume|no tetrahedra/i.test(all))
    return `A geometria não forma um volume fechado${where}. Verifique se o sólido é estanque (sem faces em falta).`;
  if (/degenerat|small edge|too small|zero length/i.test(all))
    return `Há arestas ou faces degeneradas/minúsculas${where}. Remova detalhes muito pequenos ou aumente o tamanho mínimo.`;
  return `O Gmsh falhou: ${errs[errs.length - 1]}`;
}

const ALGO_NAMES: Record<Algo3D, string> = { 1: "Delaunay", 4: "Frontal", 10: "HXT" };

/**
 * Gera a malha com o Gmsh. Ao regenerar tenta em cascata Delaunay → HXT (paralelo) → Frontal sem
 * otimização de ordem 2 → (FEM) com reparação OCC, cada tentativa com limite de tempo; a reparação só
 * é aceite se os grupos continuarem a bater certo. Devolve a malha lida (FEM) ou `undefined` (SU2).
 */
export async function gmshMesh(c: SimCase, dir: string, log: Log, o: { kind: "fem" | "su2"; regenerate: boolean; preview?: boolean }): Promise<Msh | undefined> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (instale o Gmsh ou defina CAD_GMSH)");
  const geo = join(dir, "mesh.geo");
  const nt = String(Math.max(1, cpus().length));
  const args = (n: string) => o.kind === "fem" ? ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", n] : ["mesh.geo", "-3", "-format", "su2", "-o", "mesh.su2", "-nt", n];
  const write = (g: GeoOpts) => writeFileSync(geo, o.kind === "fem" ? femGeo(c as FemCase, g) : su2Geo(c as CfdCase, g));
  const read = () => o.kind === "fem" ? parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8")) : undefined;
  const timeoutSec = jobState.current?.meshTimeout || Number(process.env.CAD_MESH_TIMEOUT) || (o.preview ? 120 : 600);
  // geo já existente e sem regenerar: corre-o tal como está (pode ter sido editado à mão)
  if (!o.regenerate && existsSync(geo)) {
    try { await run(t.gmsh.path, args(nt), dir, "log.gmsh", log, undefined, { timeoutSec }); }
    catch (e) { throw e instanceof CancelledError ? e : new Error(gmshError(logOf(dir)) ?? (e as Error).message); }
    return read();
  }
  const attempts: GeoOpts[] = [{ algorithm3D: 1 }, { algorithm3D: 10 }, { algorithm3D: 4, optimizeHO: false }];
  if (o.kind === "fem") attempts.push({ algorithm3D: 4, optimizeHO: false, heal: true });
  const start = Date.now();
  let last: Error | undefined, diag: string | null = null;
  for (const [k, g] of attempts.entries()) {
    if (k > 0 && Date.now() - start > 2 * timeoutSec * 1000) { log(`Malha: tempo total esgotado, sem mais tentativas.`); break; }
    write(g);
    log(`Malha: tentativa ${k + 1}/${attempts.length} — ${ALGO_NAMES[g.algorithm3D ?? 1]}${g.optimizeHO === false ? ", sem otimização de ordem 2" : ""}${g.heal ? ", com reparação da geometria" : ""}`);
    try {
      // só o HXT é paralelo; os outros com -nt 1 (resultado reprodutível)
      await run(t.gmsh.path, args(g.algorithm3D === 10 ? nt : "1"), dir, "log.gmsh", log, undefined, { timeoutSec });
      const msh = read();
      if (g.heal && msh) {
        const w = checkGroups(c as FemCase, msh);
        if (w.length) { last = new Error(`A reparação da geometria alterou as faces das condições:\n${w.join("\n")}`); continue; }
      }
      if (k > 0) log(`Malha: obtida na tentativa ${k + 1} (${ALGO_NAMES[g.algorithm3D ?? 1]}).`);
      return msh;
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      last = e as Error;
      diag ??= gmshError(logOf(dir));
      log(`Malha: tentativa ${k + 1} falhou — ${last.message.split("\n")[0]}`);
    }
  }
  throw new Error(diag ?? last?.message ?? "A malha falhou");
}

const logOf = (dir: string) => { try { return readFileSync(join(dir, "log.gmsh"), "utf8"); } catch { return ""; } };

/** Descrição curta dos elementos da malha (resumo). */
const meshKind = (c: FemCase) => (c.mesh.element === "hex" ? `hexaedros ${c.mesh.order === 2 ? "de 20 nós" : "de 8 nós"}${c.mesh.hexMethod === "subdivision" ? " (subdivisão)" : " (estruturados)"}` : `tetraedros de ordem ${c.mesh.order}`);

/** code_aster: mesma malha Gmsh, malha ASTER + .comm gerados aqui, run_aster com o .export. */
async function runAster(c: FemCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
  if (!t.code_aster) throw new Error("code_aster (run_aster) não encontrado (https://code-aster.org, ou defina CAD_ASTER)");
  const msh = (await gmshMesh(c, dir, log, { kind: "fem", regenerate }))!;
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

/**
 * OpenRadioss (OpenCourant): Starter e Engine sobre a malha Gmsh, animações convertidas em VTK pelo
 * anim_to_vtk e lidas como blocos nodais (deslocamento, von Mises) para o mesmo resultado dinâmico.
 */
async function runRadioss(c: FemCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
  const r = t.openradioss;
  if (!r) throw new Error("OpenRadioss/OpenCourant não encontrado (https://github.com/OpenCourant/OpenCourant/releases: descompacte e defina CAD_RADIOSS_DIR)");
  const msh = (await gmshMesh(c, dir, log, { kind: "fem", regenerate }))!;
  const warnings = checkGroups(c, msh);
  if (warnings.length) throw new Error(warnings.join("\n"));
  const deck = radiossDeck(c, msh);
  warnings.push(...deck.warnings);
  writeFileSync(join(dir, `${deck.name}_0000.rad`), deck.starter);
  writeFileSync(join(dir, `${deck.name}_0001.rad`), deck.engine);
  const plat = process.platform === "win32" ? "win64" : "linux64";
  // bibliotecas do leitor de entradas e do h3d; no Windows também o runtime Intel oneAPI dos executáveis
  const libs = [join(r.dir, "extlib", "hm_reader", plat), join(r.dir, "extlib", "h3d", "lib", plat), ...(plat === "win64" ? [join(r.dir, "extlib", "intelOneAPI_runtime", "win64")] : [])];
  const env = {
    RAD_CFG_PATH: join(r.dir, "hm_cfg_files"), RAD_H3D_PATH: libs[1], OMP_NUM_THREADS: "1", KMP_STACKSIZE: "400m", OMP_STACKSIZE: "400m",
    ...(process.platform === "win32" ? { PATH_PREPEND: libs.join(";") } : { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }),
  };
  await run(r.starter, ["-i", `${deck.name}_0000.rad`, "-np", "1", "-nt", "1"], dir, "log.starter", log, env);
  const out0 = existsSync(join(dir, `${deck.name}_0000.out`)) ? readFileSync(join(dir, `${deck.name}_0000.out`), "utf8") : "";
  const nerr = /(\d+)\s+ERROR\(S\)/.exec(out0);
  if (!/NORMAL TERMINATION/i.test(out0) || !nerr || Number(nerr[1]) > 0) throw new Error(`Starter do OpenRadioss com erros:\n${tail(join(dir, `${deck.name}_0000.out`), 40) || tail(join(dir, "log.starter"), 40)}`);
  await run(r.engine, ["-i", `${deck.name}_0001.rad`, "-nt", "1"], dir, "log.engine", log, env);
  const out1 = existsSync(join(dir, `${deck.name}_0001.out`)) ? readFileSync(join(dir, `${deck.name}_0001.out`), "utf8") : "";
  if (!/NORMAL TERMINATION/i.test(out1)) throw new Error(`Engine do OpenRadioss não terminou normalmente:\n${tail(join(dir, `${deck.name}_0001.out`), 40)}`);
  // animações galcadA001, galcadA002, … → VTK (o anim_to_vtk escreve no stdout)
  const anims = readdirSync(dir).filter((f) => new RegExp(`^${deck.name}A\\d+$`).test(f)).sort();
  if (!anims.length) throw new Error("O OpenRadioss não escreveu animações");
  const frames: VtkFrame[] = [];
  for (const a of anims) {
    const res = spawnSync(r.animToVtk, [a], { cwd: dir, env: withEnv(env), encoding: "utf8", maxBuffer: 1 << 30 });
    if (res.status !== 0 || !res.stdout.includes("UNSTRUCTURED_GRID")) throw new Error(`anim_to_vtk falhou em ${a}: ${(res.stderr || res.stdout).slice(-400)}`);
    frames.push(parseVtk(res.stdout));
  }
  const fem = femResultFrom(c, msh, radiossBlocks(frames), { frequencies: [], buckling: [], reactions: [], reactionHistory: [] });
  const dtm = /TIME STEP\s*[:=]?\s*([\d.Ee+-]+)/.exec(out1) ?? /DT\s*=\s*([\d.Ee+-]+)/.exec(out1);
  const summary: [string, string][] = [["Malha", `${deck.nodes} nós · ${deck.elements} ${meshKind(c)}`], ["Integração no tempo", `explícita (OpenRadioss), passo estável do Engine${dtm ? ` ≈ ${(Number(dtm[1]) / 1000).toExponential(3)} s` : ""}, ${frames.length} animações`], ...fem.summary];
  return { ok: true, physics: "fem", solver: "OpenRadioss (OpenCourant)", summary, warnings, fem, view: femView(fem), metrics: fem.metrics, cells: deck.elements, log: tail(join(dir, `${deck.name}_0001.out`)) };
}

export async function runFem(c: FemCase, dir: string, log: Log, regenerate: boolean): Promise<Omit<RunResult, "seconds" | "hypotheses">> {
  if (c.solver === "code_aster") return runAster(c, dir, log, regenerate);
  if (c.solver === "openradioss") return runRadioss(c, dir, log, regenerate);
  const t = tools();
  if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
  if (!t.calculix) throw new Error("CalculiX (ccx) não encontrado (http://www.calculix.de, ou defina CAD_CCX)");
  const msh = (await gmshMesh(c, dir, log, { kind: "fem", regenerate }))!;
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
