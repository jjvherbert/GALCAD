// Worker do núcleo geométrico: OpenCASCADE e PlaneGCS em WebAssembly, fora da thread da UI.
import opencascade from "replicad-opencascadejs";
import ocWasm from "replicad-opencascadejs/wasm?url";
import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { setOC } from "replicad";
import { initSolver } from "../sketch/solver.ts";
import { KernelService } from "./service.ts";
import type { Request, Response } from "./protocol.ts";

const ready = (async () => {
  const oc = await (opencascade as unknown as (o: object) => Promise<never>)({ locateFile: () => ocWasm });
  setOC(oc);
  await initSolver(gcsWasm);
})();
const service = new KernelService();

// pedidos tratados em série: o OCC não é reentrante
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<Request & { id: number }>) => {
  queue = queue.then(async () => {
    let msg: Response;
    try {
      await ready;
      const result = data.type === "rebuild" ? await service.rebuild(data.doc, data.force)
        : data.type === "curvature" ? service.curvature(data.kind)
        : await service.export(data.format, data.name);
      msg = { id: data.id, ok: true, result };
    } catch (e) {
      msg = { id: data.id, ok: false, error: (e as Error)?.message ?? String(e) };
    }
    const transfer: Transferable[] = [];
    if (msg.ok && "mesh" in msg.result && msg.result.mesh) {
      const m = msg.result.mesh;
      transfer.push(m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.lines.buffer);
    } else if (msg.ok && "data" in msg.result) {
      transfer.push(msg.result.data.buffer);
    } else if (msg.ok && "values" in msg.result) {
      transfer.push(msg.result.values.buffer);
    }
    (self as unknown as Worker).postMessage(msg, transfer);
  });
};
