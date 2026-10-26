import { drawRoundedRectangle, drawCircle } from "replicad";
import { buildHull, hydrostatics } from "./hull.js";
import { modelDefs } from "./model-defs.js";

// Construtores de geometria (correm no worker): build(params) → { shape, info }.
const builders = {
  casco(p) {
    const shape = buildHull(p);
    return { shape, info: { hydro: hydrostatics(shape, p) } };
  },
  placa({ w, h, t, r, f }) {
    let s = drawRoundedRectangle(w, h, Math.min(8, w / 4, h / 4)).sketchOnPlane().extrude(t);
    s = s.cut(drawCircle(Math.min(r, w / 2 - 1, h / 2 - 1)).sketchOnPlane().extrude(t));
    if (f > 0) s = s.fillet(Math.min(f, t / 2 - 0.1), (e) => e.inPlane("XY", t));
    return { shape: s, info: {} };
  },
};

export const models = Object.fromEntries(
  Object.entries(modelDefs).map(([k, def]) => [k, { ...def, build: builders[k] }]),
);
