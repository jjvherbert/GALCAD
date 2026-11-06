// Processos dos solvers do agente local: localização, execução, cancelamento e tempo limite (movido de cad-runner.ts).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Log = (s: string) => void;

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
  // OpenRadioss/OpenCourant: pasta da distribuição oficial (exec/, hm_cfg_files/, extlib/)
  const radDir = [process.env.CAD_RADIOSS_DIR, `${home}/OpenCourant`, "/opt/OpenCourant"].find((p) => p && existsSync(join(p, "exec")));
  const radExe = radDir ? radiossExecutables(radDir) : null;
  // OpenFOAM nativo para Windows (versão MinGW da openfoam.com): pasta OpenFOAM-vXXXX com platforms/*/bin
  const foamDir = process.env.CAD_FOAM_DIR && existsSync(process.env.CAD_FOAM_DIR) ? process.env.CAD_FOAM_DIR : null;
  const foamBin = foamDir ? (() => { const pl = join(foamDir, "platforms"); const t = existsSync(pl) ? readdirSync(pl).find((d) => existsSync(join(pl, d, "bin"))) : undefined; return t ? join(pl, t, "bin") : null; })() : null;
  const foamDirect = which("simpleFoam");
  const foamRc = process.env.CAD_FOAM_BASHRC ?? FOAM_RC.find((p) => existsSync(p)) ?? null;
  const version = (cmd: string | null, args: string[]) => {
    if (!cmd) return null;
    // lançadores .cmd/.bat só correm pelo cmd.exe (o Node recusa-os sem shell: EINVAL, stdout null);
    // um executável que não arranca não pode derrubar o agente — fica sem versão
    const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
    const r = script
      ? spawnSync(`"${cmd}"`, args, { encoding: "utf8", timeout: 10000, shell: true })
      : spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? "";
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
    openradioss: radDir && radExe ? { path: radExe.engine, version: "OpenCourant", dir: radDir, ...radExe } : null,
  };
}

/** Executáveis da distribuição do OpenCourant: Starter, Engine (sem MPI, dupla precisão) e anim_to_vtk. */
function radiossExecutables(dir: string): { starter: string; engine: string; animToVtk: string } | null {
  const ex = readdirSync(join(dir, "exec"));
  const pick = (re: RegExp) => { const f = ex.filter((x) => re.test(x) && !/_sp(\.exe)?$|ompi|impi|msmpi/.test(x)).sort((a, b) => a.length - b.length)[0]; return f ? join(dir, "exec", f) : null; };
  const starter = pick(/^starter_/), engine = pick(/^engine_/), animToVtk = pick(/^anim_to_vtk/);
  return starter && engine && animToVtk ? { starter, engine, animToVtk } : null;
}

/** Ambiente do processo com variáveis extra; `PATH` junta-se ao existente (no Windows a chave é "Path"). */
export function withEnv(extra?: NodeJS.ProcessEnv & { PATH_PREPEND?: string }): NodeJS.ProcessEnv {
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

/**
 * Job em curso (o agente corre um de cada vez): processo filho atual, cauda da saída para o progresso
 * ao vivo e motivo de cancelamento. `run()` regista aqui o processo para o poder matar.
 */
export interface Job { start: number; tail: string; child?: ReturnType<typeof spawn>; cancelled?: string; meshTimeout?: number; solveTimeout?: number }
export const jobState: { current: Job | null } = { current: null };

/** Mata o processo e os filhos: no Windows o `shell:true` mete um cmd.exe pelo meio, daí `taskkill /T`. */
function killTree(p: ReturnType<typeof spawn>): void {
  if (p.exitCode !== null || p.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  else p.kill("SIGKILL");
}

/** Cancela o job em curso (Parar no browser ou pedido fechado); devolve se havia algo a cancelar. */
export function cancelJob(reason: string): boolean {
  if (!jobState.current) return false;
  jobState.current.cancelled ??= reason;
  if (jobState.current.child) killTree(jobState.current.child);
  return true;
}

export class CancelledError extends Error {}
export class TimeoutError extends Error {}

export function run(cmd: string, args: string[], cwd: string, logFile: string, log: Log, env?: NodeJS.ProcessEnv & { PATH_PREPEND?: string }, opts: { timeoutSec?: number } = {}): Promise<void> {
  return new Promise((ok, fail) => {
    if (jobState.current?.cancelled) { fail(new CancelledError(jobState.current.cancelled)); return; }
    log(`$ ${[cmd, ...args].join(" ")}`);
    const out: string[] = [];
    // lançadores .cmd/.bat (code_aster no Windows) só correm através do cmd.exe; os argumentos são
    // nomes de ficheiros gerados aqui (sem aspas nem metacaracteres)
    const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
    if (script && args.some((a) => /["&|<>^%]/.test(a))) { fail(new Error(`Argumento inválido para ${cmd}`)); return; }
    const p = script
      ? spawn(`"${cmd}"`, args.map((a) => `"${a}"`), { cwd, env: withEnv(env), shell: true })
      : spawn(cmd, args, { cwd, env: withEnv(env) });
    const job = jobState.current;
    if (job) job.child = p;
    const take = (b: Buffer) => {
      const s = b.toString();
      out.push(s);
      if (job) job.tail = (job.tail + s).slice(-20000);
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    // limite de tempo: mata a árvore de processos e diz porquê
    // (sem limite explícito, os solvers usam o limite de cálculo do pedido)
    let timedOut = false;
    const limit = opts.timeoutSec ?? job?.solveTimeout;
    const timer = limit ? setTimeout(() => { timedOut = true; killTree(p); }, limit * 1000) : undefined;
    p.on("error", (e) => { clearTimeout(timer); fail(new Error(`${cmd}: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (job?.child === p) job.child = undefined;
      writeFileSync(join(cwd, logFile), out.join(""));
      if (job?.cancelled) fail(new CancelledError(job.cancelled));
      else if (timedOut) fail(new TimeoutError(`${cmd.split(/[\\/]/).pop()} não terminou em ${limit} s`));
      else if (code === 0) ok();
      else fail(new Error(`${cmd} terminou com o código ${code}:\n${out.join("").split(/\r?\n/).slice(-15).join("\n")}`));
    });
  });
}

/**
 * Comandos do OpenFOAM: com o ambiente já carregado (WM_PROJECT_DIR) correm diretamente; senão,
 * pelo bashrc da instalação (os executáveis precisam do ambiente para encontrar o diretório etc).
 */
export function foam(cmd: string, args: string[], cwd: string, log: Log) {
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

export const tail = (p: string, n = 25) => (existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/).slice(-n).join("\n") : "");
