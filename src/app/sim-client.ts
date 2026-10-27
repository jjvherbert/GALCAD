// Ligação da aplicação ao pré-processador: exportar o caso de um estudo (zip) e calcular no agente
// local (`cad-runner.mjs --serve`, em 127.0.0.1), que corre os solvers instalados na máquina.
import { zipStore } from "../io/mesh-export.ts";
import type { SimCase } from "../sim/case.ts";
import type { RunResult } from "../../tools/cad-runner.ts";
import { type ResultView, femView } from "../sim/result.ts";
import { externalParts, store } from "./store.ts";
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
export async function runStudy(studyId: string, url: string, token: string, convergence?: { ratio: number; target?: number; metric?: string; maxLevels?: number }): Promise<{ case: SimCase; result: RunResult }> {
  const r = await caseFiles(studyId);
  const stl = Object.fromEntries(Object.entries(r.files).filter(([p]) => p.startsWith("constant/triSurface/")).map(([p, t]) => [p.slice("constant/triSurface/".length, -4), t]));
  let res: Response;
  try {
    res = await fetch(`${url}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cad-token": token },
      body: JSON.stringify({ case: r.case, brep: r.files["model.brep"], stl: Object.keys(stl).length ? stl : undefined, convergence }),
    });
  } catch {
    throw new Error("Agente local não responde (corra: node cad-runner.mjs --serve)");
  }
  const j = await res.json();
  if (!res.ok) throw new Error(`${j.error ?? "Erro do agente"}${j.log ? `\n${j.log}` : ""}`);
  return { case: r.case, result: j as RunResult };
}
