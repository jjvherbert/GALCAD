// Valores por defeito de cada feature nova.
import type { CadDocument, FeatureData, FeatureType, PlaneRef } from "../doc/types.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { createsSheet } from "../doc/features.ts";

/** Último esboço do documento (antes do índice dado), o candidato natural para a feature seguinte. */
export function lastSketch(doc: CadDocument, before = doc.rollback ?? doc.features.length): string {
  for (let i = Math.min(before, doc.features.length) - 1; i >= 0; i--) if (doc.features[i].type === "sketch") return doc.features[i].id;
  return "";
}

/** Último corpo de superfície criado antes do índice dado. */
export function lastSheet(doc: CadDocument, before = doc.rollback ?? doc.features.length): string {
  for (let i = Math.min(before, doc.features.length) - 1; i >= 0; i--) {
    const f = doc.features[i];
    if (createsSheet(f)) return f.id;
  }
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
    case "surfaceExtrude": return { type, sketch: sk, end: { type: "blind", depth: 10 } };
    case "surfaceRevolve": return { type, sketch: sk, axis: { kind: "std", name: "Z" }, angle: 360 };
    case "surfaceSweep": return { type, profile: sk, path: "", orientation: "frenet" };
    case "surfaceLoft": return { type, sections: [] };
    case "fill": return { type, edges: [], continuity: "contact" };
    case "offsetSurface": return { type, faces: [], distance: 2 };
    case "knit": return { type, sheets: [], makeSolid: false, op: "add" };
    case "thicken": return { type, sheet: lastSheet(doc), thickness: 2, side: "front", op: "add" };
    case "trimSurface": return { type, sheet: lastSheet(doc), tool: { kind: "plane", plane: { kind: "std", name: "XY" } }, keep: [] };
    case "deleteFace": return { type, faces: [], mode: "delete" };
    case "curve": return { type, def: { kind: "points", points: [[0, 0, 0], [50, 20, 10], [100, 0, 0]] } };
    case "boundary": return { type, dir1: [], dir2: [], cont1: "contact", cont2: "contact" };
    case "ruled": return { type, edges: [], mode: "normal", distance: 10 };
    case "untrim": return { type, faces: [] };
    case "replaceFace": return { type, faces: [], sheet: lastSheet(doc) };
    case "multiSection": return { type, sections: [], guides: [] };
    case "blend": return { type, side1: { curve: { kind: "curve", feature: "" }, continuity: "tangent" }, side2: { curve: { kind: "curve", feature: "" }, continuity: "tangent" } };
    case "circleSweep": return { type, mode: "threeGuides", guides: [], radius: 10 };
    case "extrapolate": return { type, sheet: lastSheet(doc), edges: [], length: 10, continuity: "tangent" };
    case "heal": return { type, sheets: [], distance: 0.1, tangency: 0.5, simplify: true };
    case "plugin": {
      const p = PLUGINS.find((x) => x.id === opts.plugin) ?? PLUGINS[0];
      const kind = opts.kind ?? Object.keys(p.kinds)[0];
      const params = Object.fromEntries(Object.entries(p.kinds[kind].params).map(([k, d]) => [k, d.value]));
      return { type, plugin: p.id, kind, params, op: "add" };
    }
  }
}
