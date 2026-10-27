// Worker dos scripts: corre o código do utilizador fora da página, sem acesso à interface, à rede
// nem ao armazenamento (as APIs são retiradas antes de correr). Fala com a página só pelo protocolo
// abaixo: a página faz as reconstruções e as simulações (anfitrião) e devolve resultados simples.
import { type ScriptHost, runScript } from "../script/api.ts";

const scope = self as unknown as Record<string, unknown>;
for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "navigator"]) {
  try { Object.defineProperty(scope, k, { value: undefined, configurable: false, writable: false }); } catch { /* já indisponível */ }
}

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
let seq = 0;
const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
const call = (method: keyof ScriptHost, args: unknown[]) => new Promise<never>((ok, fail) => {
  const id = ++seq;
  pending.set(id, { ok: ok as (v: unknown) => void, fail });
  post({ type: "call", id, method, args });
});
const host: ScriptHost = {
  rebuild: (doc) => call("rebuild", [doc]),
  simulate: (doc, id, opts) => call("simulate", [doc, id, opts]),
  xfoil: (req) => call("xfoil", [req]),
};

self.onmessage = async ({ data }: MessageEvent) => {
  if (data.type === "reply") {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p?.fail(new Error(data.error)); else p?.ok(data.result);
    return;
  }
  if (data.type === "run") {
    const out = await runScript(data.code, data.doc, host, { timeoutMs: data.timeoutMs, onLog: (line) => post({ type: "log", line }) });
    post({ type: "done", out });
  }
};
