// Cores do visualizador: seleção, realces, pré-visualização e análises (inclinação, curvatura,
// desvio, continuidade) em faces, arestas, planos e regiões; realce que se desvanece numa feature.
import * as THREE from "three";
import type { MeshData } from "../kernel/mesh.ts";
import type { Analysis } from "./store.ts";
import { CONTINUITY_COLORS, type Theme, divergingColor, robustScale } from "./viewport-style.ts";
import type { PlaneMesh } from "./viewport-scene.ts";
import type { RegionMesh } from "./viewport-select.ts";

/** Realce que se desvanece: feature pendente, faces em realce (prefixo e início) e intensidade (0–1). */
export interface Flash { pending: string | null; on: { prefix: string; t0: number } | null; k: number }

/** O que define as cores: corpo e malhas, tema, seleção, realces, condições, análise e realce a desvanecer. */
export interface ColorState {
  mesh: MeshData | null;
  faceMesh: THREE.Mesh | null;
  edgeLines: THREE.LineSegments | null;
  faceVerts: [number, number][];
  planeMeshes: PlaneMesh[];
  regionMeshes: RegionMesh[];
  theme: Theme;
  selected: Set<string>;
  /** Chave do elemento sob o cursor (ou do realce vindo de fora do 3D); "" se nenhum. */
  hoverKey: string;
  featureHighlight: string | null;
  previewFeature: string | null;
  conditionFaces: Map<string, number> | null;
  analysis: Analysis | null;
  flash: Flash;
}

const flashColor = new THREE.Color();

/** Recolore regiões, planos, faces e arestas; publica o número de faces em pré-visualização em `data`. */
export function recolor(s: ColorState, data: DOMStringMap) {
  const hoverKey = s.hoverKey;
  for (const r of s.regionMeshes) {
    const k = `region:${r.sig.join("+")}`;
    const m = r.mesh.material as THREE.MeshBasicMaterial;
    m.color.set(s.selected.has(k) ? s.theme.sel : k === hoverKey ? s.theme.hover : 0x9333ea);
    m.opacity = s.selected.has(k) || k === hoverKey ? 0.55 : 0.22;
  }
  for (const p of s.planeMeshes) {
    const k = `plane:${JSON.stringify(p.ref)}`;
    (p.mesh.material as THREE.MeshBasicMaterial).color.set(s.selected.has(k) ? s.theme.sel : k === hoverKey ? s.theme.hover : p.ref.kind === "std" ? s.theme.plane : 0x22a06b);
  }
  if (!s.mesh || !s.faceMesh || !s.edgeLines) return;
  const col = s.faceMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
  const c = new THREE.Color();
  // "@c2" realça o componente c2 da montagem (nomes "c2|…" e "c2/…|…")
  const fhComp = s.featureHighlight?.startsWith("@") ? s.featureHighlight.slice(1) : null;
  const fh = s.featureHighlight && !fhComp ? `${s.featureHighlight}:` : null;
  const pv = s.previewFeature ? `${s.previewFeature}:` : null;
  const a = s.analysis;
  const nrm = s.mesh.normals;
  const dir = a?.kind === "draft" ? { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[a.dir] : null;
  const sinT = a?.kind === "draft" ? Math.sin((a.angle * Math.PI) / 180) : 0;
  const curv = a?.kind === "curvature" && a.data && a.data.values.length === s.mesh.vertices.length / 3 ? a.data.values : null;
  const scale = (curv && robustScale(curv)) || 1;
  const flash = s.flash;
  s.mesh.faces.forEach((f, i) => {
    const k = `face:${f.name}`;
    const [lo, hi] = s.faceVerts[i];
    const inComp = fhComp && (f.name.startsWith(`${fhComp}|`) || f.name.startsWith(`${fhComp}/`));
    const flat = s.selected.has(k) ? s.theme.sel : k === hoverKey ? s.theme.hover : (fh && f.name.startsWith(fh)) || inComp ? s.theme.feat : pv && f.name.startsWith(pv) ? s.theme.preview : s.conditionFaces?.get(f.name) ?? null;
    if (flat === null && (dir || curv)) {
      for (let v = lo; v <= hi; v++) {
        if (dir) {
          const d = nrm[v * 3] * dir[0] + nrm[v * 3 + 1] * dir[1] + nrm[v * 3 + 2] * dir[2];
          c.set(d >= sinT ? 0x22c55e : d <= -sinT ? 0xef4444 : 0xfacc15);
        } else divergingColor(curv![v] / scale, c);
        col.setXYZ(v, c.r, c.g, c.b);
      }
      return;
    }
    c.set(flat ?? (f.body ? s.theme.sheet : s.theme.body));
    if (flat === null && flash.on && flash.k > 0 && f.name.startsWith(flash.on.prefix)) c.lerp(flashColor.set(s.theme.preview), flash.k);
    for (let v = lo; v <= hi; v++) col.setXYZ(v, c.r, c.g, c.b);
  });
  col.needsUpdate = true;
  data.previewFaces = String(pv ? s.mesh.faces.filter((f) => f.name.startsWith(pv)).length : 0);
  const ecol = s.edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
  const dev = a?.kind === "deviation" && a.data ? new Map(a.data.edges.map((x) => [x.name, x.deg])) : null;
  const cont = a?.kind === "continuity" && a.data ? new Map(a.data.edges.map((x) => [x.name, x.cls])) : null;
  s.mesh.edges.forEach((e) => {
    const k = `edge:${e.name}`;
    const d = dev?.get(e.name);
    const cl = cont?.get(e.name);
    const base = cl !== undefined ? CONTINUITY_COLORS[cl]
      : d === undefined ? (e.curve ? s.theme.curve : s.theme.edge) : d <= 0.5 ? 0x16a34a : d <= 10 ? 0xf59e0b : 0x6b7280;
    c.set(s.selected.has(k) ? s.theme.sel : k === hoverKey ? s.theme.hover : base);
    for (let v = e.start; v < e.start + e.count; v++) ecol.setXYZ(v, c.r, c.g, c.b);
  });
  ecol.needsUpdate = true;
}

/**
 * Avança o realce que se desvanece (900 ms): arranca o pendente se a feature tem faces e as
 * transições estão ligadas. Devolve true se é preciso recolorir.
 */
export function stepFlash(fl: Flash, mesh: MeshData | null, animate: boolean): boolean {
  if (fl.pending && mesh) {
    const prefix = `${fl.pending}:`;
    fl.pending = null;
    if (animate && mesh.faces.some((f) => f.name.startsWith(prefix))) fl.on = { prefix, t0: performance.now() };
  }
  if (!fl.on) return false;
  const k = 1 - (performance.now() - fl.on.t0) / 900;
  if (k <= 0) { fl.on = null; fl.k = 0; return true; }
  fl.k = k * k;
  return true;
}
