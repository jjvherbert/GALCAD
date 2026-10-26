// Toda a geometria (OpenCASCADE/WASM) corre aqui, fora da thread da UI.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { models } from "./models.js";

const ready = opencascade({ locateFile: () => wasmUrl }).then((oc) => setOC(oc));
let current = null;
let currentUnits = "mm";

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await ready;
    if (type === "build") {
      current?.delete?.();
      const { shape, info } = models[data.model].build(data.params);
      current = shape;
      currentUnits = models[data.model].units;
      const mesh = shape.mesh({ tolerance: 0.01, angularTolerance: 15 });
      const edges = shape.meshEdges({ tolerance: 0.01, angularTolerance: 15 });
      self.postMessage({ id, ok: true, mesh, edges: edges.lines, info });
    } else if (type === "export") {
      if (!current) throw new Error("Nada para exportar");
      // STEP/STL são lidos como milímetros pela maioria das ferramentas: converter modelos em metros.
      const out = currentUnits === "m" ? current.clone().scale(1000) : current;
      const blob = data.format === "step" ? out.blobSTEP() : out.blobSTL({ tolerance: 0.5, angularTolerance: 10, binary: true });
      if (out !== current) out.delete();
      self.postMessage({ id, ok: true, blob });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
