// Ligação da aplicação ao pré-processador: exportar o caso de um estudo (zip) e calcular no agente
// local (`cad-runner.mjs --serve`, em 127.0.0.1), que corre os solvers instalados na máquina.
import { zipStore } from "../io/mesh-export.ts";
import type { SimCase } from "../sim/case.ts";
import type { XfoilRequest, XfoilResult } from "../sim/xfoil.ts";
import type { RunResult } from "../../tools/cad-runner.ts";
import { type ResultView, femView } from "../sim/result.ts";
import { externalParts, store } from "./store.ts";
import type { PartDoc } from "../doc/project.ts";
import { download } from "./fileio.ts";

export type { RunResult };

/** Camadas a mostrar de um resultado (resultados antigos só com a parte FEM: uma camada). */
export const resultView = (r: RunResult | undefined | null): ResultView | null => (r ? r.view ?? (r.fem ? femView(r.fem) : null) : null);

async function caseFiles(studyId: string) {
  const st = store.state;
  if (st.active.kind === "assembly") return store.kernel.assemblyStudyCase(st.project, st.active.id, studyId);
  return store.kernel.studyCase(st.doc, externalParts(st.project, st.doc), studyId);
}

const safe = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_");

/** Descarrega o caso completo (geometria, script Gmsh, dicionários, case.json, LEIA-ME) em .zip. */
export async function exportStudyCase(studyId: string) {
  try {
    const r = await caseFiles(studyId);
    const enc = new TextEncoder();
    const name = safe(r.case.title);
    const data = zipStore(Object.entries(r.files).map(([p, text]) => ({ name: `${name}/${p}`, data: enc.encode(text) })));
    download(`${name}.zip`, data as BlobPart, "application/zip");
    store.set({ message: `Caso exportado (${Object.keys(r.files).length} ficheiros)${r.warnings.length ? ` — ${r.warnings[0]}` : ""}` });
  } catch (e) {
    store.set({ error: (e as Error).message });
  }
}

/** Estado do agente local (solvers encontrados) ou erro de ligação. */
export async function agentStatus(url: string, token: string): Promise<{ ok: boolean; tools?: Record<string, { path: string; version: string | null } | null>; error?: string }> {
  try {
    const r = await fetch(`${url}/status`, { headers: { "x-cad-token": token } });
    const j = await r.json();
    return r.ok ? j : { ok: false, error: j.error };
  } catch {
    return { ok: false, error: "Agente local não responde (corra: node cad-runner.mjs --serve)" };
  }
}

/**
 * Gera o caso e calcula-o no agente local; devolve os resultados. `convergence`: corre também em duas
 * malhas mais grossas (tamanhos × r e × r²) e devolve o GCI de cada grandeza.
 */
export async function runStudy(studyId: string, url: string, token: string, convergence?: { ratio: number; target?: number; metric?: string; maxLevels?: number; sweep?: number }, opts?: JobOpts): Promise<{ case: SimCase; result: RunResult }> {
  return postCase(await caseFiles(studyId), url, token, convergence, "/run", opts);
}

/** Como `runStudy`, mas para um documento de peça dado (ex.: a cópia em que um script trabalha). */
export async function runStudyFor(doc: PartDoc, studyId: string, url: string, token: string, convergence?: Parameters<typeof runStudy>[3]) {
  const st = store.state;
  return postCase(await store.kernel.studyCase(doc, externalParts(st.project, doc), studyId), url, token, convergence);
}

/** Só a malha do estudo (Gmsh no agente local): qualidade e superfície com as arestas dos elementos. */
export async function previewStudyMesh(studyId: string, url: string, token: string, opts?: JobOpts): Promise<{ case: SimCase; result: RunResult }> {
  return postCase(await caseFiles(studyId), url, token, undefined, "/mesh", opts);
}

/** Opções de um pedido longo ao agente: `signal` para o Parar; `meshTimeout` (s) por tentativa do Gmsh. */
export interface JobOpts { signal?: AbortSignal; meshTimeout?: number }

/** Pedido parado pelo utilizador (Parar, ou o agente respondeu 499). Não é uma falha do cálculo. */
export class CancelledError extends Error {
  constructor(message = "Cancelado pelo utilizador") {
    super(message);
    this.name = "CancelledError";
  }
}

/** `fetch` ao agente: abortado → CancelledError; sem ligação → mensagem a dizer como arrancar o agente. */
async function agentFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    if (init.signal?.aborted || (e as Error).name === "AbortError") throw new CancelledError();
    throw new Error("Agente local não responde (corra: node cad-runner.mjs --serve)");
  }
}

/** Corpo JSON da resposta; 499 → CancelledError; outro erro → mensagem do agente (+ cauda do log). */
async function agentJson(res: Response, signal?: AbortSignal): Promise<any> {
  let j: any;
  try {
    j = await res.json();
  } catch (e) {
    if (signal?.aborted) throw new CancelledError();
    throw new Error(`Resposta inválida do agente (HTTP ${res.status}): ${(e as Error).message}`);
  }
  if (res.status === 499) throw new CancelledError(j?.error);
  if (!res.ok) throw new Error(`${j?.error ?? "Erro do agente"}${j?.log ? `\n${j.log}` : ""}`);
  return j;
}

/** Pede ao agente que pare o trabalho em curso (mata a árvore de processos do solver). */
export async function cancelAgentJob(url: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/cancel`, { method: "POST", headers: { "x-cad-token": token } });
    return r.ok && (await r.json()).cancelled === true;
  } catch {
    return false;
  }
}

/** Progresso do trabalho em curso no agente: tempo decorrido (s) e cauda do registo; null se não responde. */
export async function agentJob(url: string, token: string): Promise<{ busy: boolean; elapsed?: number; tail?: string; cancelled?: string } | null> {
  try {
    const r = await fetch(`${url}/job`, { headers: { "x-cad-token": token } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function postCase(r: Awaited<ReturnType<typeof caseFiles>>, url: string, token: string, convergence?: Parameters<typeof runStudy>[3], path = "/run", opts: JobOpts = {}): Promise<{ case: SimCase; result: RunResult }> {
  if (!token) throw new Error("Ligue o agente local (Simulação → Agente local: endereço e token)");
  const stl = Object.fromEntries(Object.entries(r.files).filter(([p]) => p.startsWith("constant/triSurface/")).map(([p, t]) => [p.slice("constant/triSurface/".length, -4), t]));
  const res = await agentFetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cad-token": token },
    body: JSON.stringify({ case: r.case, brep: r.files["model.brep"], stl: Object.keys(stl).length ? stl : undefined, convergence, meshTimeout: opts.meshTimeout }),
    signal: opts.signal,
  });
  return { case: r.case, result: (await agentJson(res, opts.signal)) as RunResult };
}

/** Polar de um perfil no XFOIL do agente local. */
export async function runXfoilAgent(req: XfoilRequest, url: string, token: string, signal?: AbortSignal): Promise<XfoilResult> {
  if (!token) throw new Error("Ligue o agente local (Simulação → Agente local: endereço e token)");
  const res = await agentFetch(`${url}/xfoil`, { method: "POST", headers: { "content-type": "application/json", "x-cad-token": token }, body: JSON.stringify(req), signal });
  return (await agentJson(res, signal)) as XfoilResult;
}
