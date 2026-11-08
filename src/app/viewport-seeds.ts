// Vista 3D: pré-visualização das seeds da malha (nós de cada aresta calculados pelo meshPlan, sem
// Gmsh). Pontos coloridos pela origem da contagem: definida pelo utilizador, propagada pela malha
// estruturada ou automática pelo tamanho global; rótulo «n» a meio das arestas com seed.
import * as THREE from "three";
import type { SeedPreview } from "../kernel/sim-fem.ts";

export const SEED_COLORS = { user: 0xdc2626, propagated: 0xf59e0b, auto: 0x64748b } as const;

export interface SeedLabel { el: HTMLDivElement; at: THREE.Vector3 }

/** Desenha os nós no grupo e cria os rótulos na camada; devolve os rótulos e o total de nós. */
export function buildSeedMarks(g: THREE.Group, layer: HTMLElement, p: SeedPreview | null): { labels: SeedLabel[]; nodes: number } {
  layer.replaceChildren();
  if (!p) return { labels: [], nodes: 0 };
  const labels: SeedLabel[] = [];
  let nodes = 0;
  for (const kind of ["auto", "propagated", "user"] as const) {
    const pts = p.edges.filter((e) => e.kind === kind).flatMap((e) => e.points);
    if (!pts.length) continue;
    nodes += pts.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.PointsMaterial({ color: SEED_COLORS[kind], size: kind === "auto" ? 4 : 6, sizeAttenuation: false, depthTest: false });
    const obj = new THREE.Points(geo, mat);
    obj.renderOrder = kind === "user" ? 12 : 11;
    g.add(obj);
  }
  for (const e of p.edges) {
    if (e.kind === "auto" || e.points.length < 6) continue;
    const k = Math.floor(e.points.length / 6) * 3;
    const el = Object.assign(document.createElement("div"), { className: `seed-label seed-${e.kind}`, textContent: String(e.n) });
    el.title = `Aresta ${e.tag}: ${e.n} elemento(s)${e.kind === "propagated" ? " (propagado pela malha estruturada)" : ""}`;
    layer.append(el);
    labels.push({ el, at: new THREE.Vector3(e.points[k], e.points[k + 1], e.points[k + 2]) });
  }
  return { labels, nodes };
}

export function placeSeedLabels(labels: SeedLabel[], camera: THREE.Camera, canvas: HTMLCanvasElement) {
  if (!labels.length) return;
  const w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector3();
  for (const l of labels) {
    v.copy(l.at).project(camera);
    l.el.style.transform = `translate(${(((v.x + 1) / 2) * w).toFixed(1)}px, ${(((1 - v.y) / 2) * h).toFixed(1)}px) translate(-50%, -130%)`;
  }
}
