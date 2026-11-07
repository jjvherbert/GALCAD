// Vista 3D: camadas da cena (rótulos PMI, rede de polos, resultado de simulação, estilo de visualização, referências, esboços).
import * as THREE from "three";
import { type ResultView, layerShown } from "../sim/result.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { CadDocument } from "../doc/types.ts";
import { type SimView, buildSimLayers } from "./viewport-sim.ts";
import { buildReferences, buildSketches, modelSize } from "./viewport-scene.ts";
import { drawPoleNet } from "./viewport-poles.ts";
import { type PmiItem, buildPmiLabels, placePmiLabels } from "./viewport-pmi.ts";
import type { Viewport } from "./viewport.ts";

export function setPmi(v: Viewport, items: PmiItem[] | null) {
  v.pmiEl.replaceChildren();
  v.pmiSvg.replaceChildren();
  v.pmiLabels = [];
  v.el.dataset.pmi = items ? String(items.length) : "";
  if (!items) return;
  const L = Math.max(4, modelSize(v.lastResult) * 0.18);
  v.pmiLabels = buildPmiLabels(items, v.pmiEl, v.pmiSvg, L, (id) => v.onPmiClick?.(id));
  // posicionar já: sem isto os rótulos novos ficam uma imagem no canto (0,0) até à próxima frame
  placePmi(v);
}

export function placePmi(v: Viewport) {
  placePmiLabels(v.pmiLabels, v.camera, v.renderer.domElement);
}

export function drawPoles(v: Viewport, preview?: { k: number; p: THREE.Vector3 }) {
  v.disposeGroup(v.poleGroup);
  if (!v.poleGroup.parent) v.scene.add(v.poleGroup);
  drawPoleNet(v.poleGroup, v.poleNet, v.poleSel, v.camera, v.renderer.domElement, v.el.dataset, preview);
}

export function setSimResult(v: Viewport, r: ResultView | null, view: SimView) {
  v.disposeGroup(v.simGroup);
  if (!v.simGroup.parent) v.scene.add(v.simGroup);
  const fem = !!r?.modes.length || r?.layers.some((l) => l.displacements) === true;
  if (v.faceMesh) v.faceMesh.visible = !r;
  if (v.edgeLines) v.edgeLines.visible = r ? !fem : v.settings.displayStyle !== "shaded";
  v.el.dataset.sim = r ? "1" : "";
  v.el.dataset.simLayers = r ? r.layers.filter((l) => layerShown(l, view.hidden)).map((l) => l.name).join("|") : "";
  if (!r) return;
  const { dmax, k } = buildSimLayers(v.simGroup, r, view, v.size, fem ? v.edgeLines : null);
  v.el.dataset.simScale = dmax > 0 ? k.toPrecision(3) : "";
}

export function applyDisplayStyle(v: Viewport) {
  const style = v.settings.displayStyle;
  if (v.faceMesh) {
    const m = v.faceMesh.material as THREE.MeshStandardMaterial;
    m.transparent = style === "wireframe";
    m.opacity = style === "wireframe" ? 0.06 : 1;
    m.depthWrite = style !== "wireframe";
    m.needsUpdate = true;
  }
  if (v.edgeLines) {
    v.edgeLines.visible = style !== "shaded";
    (v.edgeLines.material as THREE.LineBasicMaterial).depthTest = style !== "wireframe";
  }
}

export function setReferences(v: Viewport, result: RebuildResponse | null, doc: CadDocument, showStd: boolean) {
  v.disposeGroup(v.refGroup);
  v.planeMeshes = buildReferences(v.refGroup, result, doc, showStd, v.theme.plane);
}

export function setSketches(v: Viewport, result: RebuildResponse | null, doc: CadDocument, hide?: string) {
  v.disposeGroup(v.sketchGroup);
  buildSketches(v.sketchGroup, result, doc, v.theme.sketch, hide);
}
