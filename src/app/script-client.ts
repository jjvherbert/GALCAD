// Página ↔ worker dos scripts: o worker pede reconstruções e simulações, a página faz-as com o núcleo
// e o agente local (sobre a cópia do documento que o script lhe passa) e devolve o resumo.
import type { CadDocument } from "../doc/types.ts";
import type { PartDoc } from "../doc/project.ts";
import { DEFAULT_DENSITY } from "../doc/project.ts";
import type { ScriptOutput } from "../script/api.ts";
import { rebuildSummary, simulationSummary } from "../script/summary.ts";
import { externalParts, store } from "./store.ts";
import { runStudyFor } from "./sim-client.ts";

export interface ScriptRun { promise: Promise<ScriptOutput>; stop: () => void }

export function runScriptInWorker(code: string, onLog: (line: string) => void, timeoutMs = 30 * 60 * 1000): ScriptRun {
  const st = store.state;
  const base = st.doc as PartDoc;
  const worker = new Worker(new URL("./script-worker.ts", import.meta.url), { type: "module" });
  const asPart = (doc: CadDocument) => ({ ...base, ...doc, id: base.id }) as PartDoc;
  let finish: (o: ScriptOutput) => void, failRun: (e: Error) => void;
  const promise = new Promise<ScriptOutput>((ok, fail) => { finish = ok; failRun = fail; });
  worker.onmessage = async ({ data }: MessageEvent) => {
    if (data.type === "log") onLog(data.line);
    else if (data.type === "done") { worker.terminate(); finish(data.out); }
    else if (data.type === "call") {
      try {
        let result: unknown;
        if (data.method === "rebuild") {
          const d = asPart(data.args[0]);
          result = rebuildSummary(await store.kernel.rebuild(d, false, externalParts(store.state.project, d)), d.properties?.density ?? DEFAULT_DENSITY);
        } else if (data.method === "simulate") {
          const [doc, id, opts] = data.args;
          const a = store.state.agent;
          result = simulationSummary((await runStudyFor(asPart(doc), id, a.url, a.token, opts?.convergence)).result);
        } else throw new Error(`Pedido desconhecido: ${data.method}`);
        worker.postMessage({ type: "reply", id: data.id, result });
      } catch (e) {
        worker.postMessage({ type: "reply", id: data.id, error: (e as Error).message });
      }
    }
  };
  worker.onerror = (e) => { worker.terminate(); failRun(new Error(e.message || "Erro no worker do script")); };
  worker.postMessage({ type: "run", code, doc: structuredClone(base), timeoutMs });
  return { promise, stop: () => { worker.terminate(); failRun(new Error("Script interrompido")); } };
}
