// Vista 3D: recolorir (seleção, realce, análise) e realce sob o cursor.
import * as colors from "./viewport-colors.ts";
import type { Hit } from "./viewport-select.ts";
import type { Viewport } from "./viewport.ts";

export function recolor(v: Viewport) {
  colors.recolor({
    mesh: v.mesh, faceMesh: v.faceMesh, edgeLines: v.edgeLines, faceVerts: v.faceVerts,
    planeMeshes: v.planeMeshes, regionMeshes: v.regionMeshes, theme: v.theme, selected: v.selected,
    hoverKey: v.hover ? v.keyOf(v.hover) : v.extHover, featureHighlight: v.featureHighlight,
    previewFeature: v.previewFeature, conditionFaces: v.conditionFaces, analysis: v.analysis, flash: v.flash,
  }, v.el.dataset);
}

export function setHover(v: Viewport, h: Hit | null) {
  const same = (a: Hit | null, b: Hit | null) => (a && b ? v.keyOf(a) === v.keyOf(b) : a === b);
  if (same(h, v.hover)) return;
  v.hover = h;
  v.recolor();
  if (!h) v.onHover(null);
  else if (h.kind === "face") { const f = v.mesh!.faces[h.index]; v.onHover({ kind: "face", type: f.type, name: f.name }); }
  else if (h.kind === "edge") { const e = v.mesh!.edges[h.index]; v.onHover({ kind: "edge", type: e.type, name: e.name }); }
  else if (h.kind === "region") v.onHover({ kind: "plane", type: "region", name: `Região: ${v.regionMeshes[h.index].sig.join(" + ")}` });
  else v.onHover({ kind: "plane", type: "plane", name: h.label });
}
