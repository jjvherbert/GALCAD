// Valores por defeito de cada feature nova.
import type { CadDocument, FeatureData, FeatureType, PlaneRef } from "../doc/types.ts";
import { PLUGINS } from "../plugins/meta.ts";

/** Último esboço do documento (antes do índice dado), o candidato natural para a feature seguinte. */
export function lastSketch(doc: CadDocument, before = doc.rollback ?? doc.features.length): string {
  for (let i = Math.min(before, doc.features.length) - 1; i >= 0; i--) if (doc.features[i].type === "sketch") return doc.features[i].id;
  return "";
}

export function defaultFeature(doc: CadDocument, type: FeatureType, opts: { plane?: PlaneRef; plugin?: string; kind?: string } = {}): FeatureData {
  const sk = lastSketch(doc);
  switch (type) {
    case "sketch": return { type, plane: opts.plane ?? { kind: "std", name: "XY" }, entities: {}, constraints: [] };
    case "extrude": return { type, sketch: sk, op: "add", end: { type: "blind", depth: 10 } };
    case "revolve": return { type, sketch: sk, op: "add", axis: { kind: "std", name: "Z" }, angle: 360 };
    case "sweep": return { type, profile: sk, path: "", op: "add", orientation: "frenet" };
    case "loft": return { type, sections: [], op: "add" };
    case "hole": return { type, sketch: sk, kind: "clearance", size: "M6", fit: "normal", head: "none", end: { type: "throughAll" } };
    case "fillet": return { type, refs: [], radius: 2 };
    case "chamfer": return { type, refs: [], distance: 1 };
    case "shell": return { type, faces: [], thickness: 2 };
    case "draft": return { type, faces: [], neutral: { kind: "std", name: "XY" }, angle: 3 };
    case "rib": return { type, sketch: sk, thickness: 3 };
    case "linearPattern": return { type, features: [], direction: { kind: "std", name: "X" }, count: 3, spacing: 20 };
    case "circularPattern": return { type, features: [], axis: { kind: "std", name: "Z" }, count: 6, angle: 360 };
    case "mirror": return { type, features: [], plane: { kind: "std", name: "YZ" } };
    case "plane": return { type, base: opts.plane ?? { kind: "std", name: "XY" }, offset: 10 };
    case "axis": return { type, mode: "twoPlanes", planes: [{ kind: "std", name: "XZ" }, { kind: "std", name: "YZ" }] };
    case "csys": return { type, origin: [0, 0, 0], rotation: [0, 0, 0] };
    case "import": return { type, format: "step", fileName: "", data: "", op: "add" };
    case "plugin": {
      const p = PLUGINS.find((x) => x.id === opts.plugin) ?? PLUGINS[0];
      const kind = opts.kind ?? Object.keys(p.kinds)[0];
      const params = Object.fromEntries(Object.entries(p.kinds[kind].params).map(([k, d]) => [k, d.value]));
      return { type, plugin: p.id, kind, params, op: "add" };
    }
  }
}
