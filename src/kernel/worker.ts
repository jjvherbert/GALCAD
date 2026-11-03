// Worker do núcleo geométrico: OpenCASCADE e PlaneGCS em WebAssembly, fora da thread da UI.
import opencascade from "replicad-opencascadejs";
import ocWasm from "replicad-opencascadejs/wasm?url";
import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { setOC } from "replicad";
import { initSolver } from "../sketch/solver.ts";
import { KernelService } from "./service.ts";
import { handle, makeHandlers } from "./handlers.ts";
import type { Request, Response } from "./protocol.ts";

const ready = (async () => {
  const oc = await (opencascade as unknown as (o: object) => Promise<never>)({ locateFile: () => ocWasm });
  setOC(oc);
  await initSolver(gcsWasm);
})();
const handlers = makeHandlers(new KernelService());

// pedidos tratados em série: o OCC não é reentrante
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<Request & { id: number }>) => {
  queue = queue.then(async () => {
    let msg: Response;
    let transfer: Transferable[] = [];
    try {
      await ready;
      const r = await handle(handlers, data);
      transfer = r.transfer;
      msg = { id: data.id, ok: true, result: r.result };
    } catch (e) {
      msg = { id: data.id, ok: false, error: (e as Error)?.message ?? String(e) };
    }
    try {
      (self as unknown as Worker).postMessage(msg, transfer);
    } catch (e) {
      // sem isto a promessa da fila rejeitava e nenhum pedido seguinte voltava a correr (pendurado sem erro)
      (self as unknown as Worker).postMessage({ id: data.id, ok: false, error: `Resposta do núcleo não enviada: ${(e as Error)?.message ?? String(e)}` } satisfies Response);
    }
  }).catch((e) => console.error("Núcleo: falha inesperada na fila", e));
};
