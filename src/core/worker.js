// Núcleo geométrico (OpenCASCADE/WASM), fora da thread da UI.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { modelDefs } from "./registry.js";

const geometries = import.meta.glob("../plugins/*/geometry.js", { eager: true, import: "builders" });
const builderFor = (modelId) => {
  const [plugin, key] = modelId.split("/");
  const fn = geometries[`../plugins/${plugin}/geometry.js`]?.[key];
  if (!fn) throw new Error(`Modelo desconhecido: ${modelId}`);
  return fn;
};

const ready = opencascade({ locateFile: () => wasmUrl }).then((oc) => setOC(oc));
let current = null;
let currentUnits = "mm";

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await ready;
    if (type === "build") {
      current?.delete?.();
      const { shape, info = null } = builderFor(data.model)(data.params);
      current = shape;
      currentUnits = modelDefs[data.model].units;
      const opts = { tolerance: currentUnits === "m" ? 0.01 : 0.05, angularTolerance: 15 };
      self.postMessage({ id, ok: true, mesh: shape.mesh(opts), edges: shape.meshEdges(opts).lines, info });
    } else if (type === "export") {
      if (!current) throw new Error("Nada para exportar");
      // STEP/STL são lidos como milímetros pela maioria das ferramentas: converter modelos em metros.
      const out = currentUnits === "m" ? current.clone().scale(1000) : current;
      const blob = data.format === "step" ? out.blobSTEP() : out.blobSTL({ tolerance: currentUnits === "m" ? 0.5 : 0.05, angularTolerance: 10, binary: true });
      if (out !== current) out.delete();
      self.postMessage({ id, ok: true, blob });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
