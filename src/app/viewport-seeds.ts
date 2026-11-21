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

export const ADVICE_COLOR = 0x06b6d4;

/** Fantasmas de uma sugestão do avaliador (C9c): as arestas tocadas (pelas tags do plano de seeds) e os
 *  planos de partição propostos, translúcidos e por cima de tudo. Devolve o n.º de arestas desenhadas. */
export function buildAdviceGhosts(g: THREE.Group, preview: { tags: number[]; planes?: { origin: [number, number, number]; normal: [number, number, number] }[] } | null, seeds: SeedPreview | null): number {
  if (!preview || !seeds) return 0;
  const want = new Set(preview.tags);
  const segs: number[] = [];
  let edges = 0;
  for (const e of seeds.edges) {
    if (!want.has(e.tag) || e.points.length < 6) continue;
    edges++;
    for (let i = 3; i < e.points.length; i += 3) segs.push(e.points[i - 3], e.points[i - 2], e.points[i - 1], e.points[i], e.points[i + 1], e.points[i + 2]);
  }
  if (segs.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    const obj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: ADVICE_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
    obj.renderOrder = 13;
    g.add(obj);
  }
  if (preview.planes?.length) {
    const box = new THREE.Box3();
    for (const e of seeds.edges) for (let i = 0; i + 2 < e.points.length; i += 3) box.expandByPoint(new THREE.Vector3(e.points[i], e.points[i + 1], e.points[i + 2]));
    const size = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length() * 1.1;
    for (const pl of preview.planes) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: ADVICE_COLOR, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
      mesh.position.set(...pl.origin);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...pl.normal).normalize());
      mesh.renderOrder = 12;
      g.add(mesh);
    }
  }
  return edges;
}
