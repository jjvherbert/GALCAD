// Seleção no visualizador: elemento sob o cursor (raio), chaves e escolhas (Pick) dos elementos e
// seleção por caixa no ecrã.
import * as THREE from "three";
import type { MeshData } from "../kernel/mesh.ts";
import type { PlaneRef } from "../doc/types.ts";
import type { Pick, PickKind } from "./store.ts";
import type { PlaneMesh } from "./viewport-scene.ts";

/** Elemento sob o cursor: face, aresta, plano ou região de esboço, com o ponto atingido. */
export type Hit =
  | { kind: "face"; index: number; point: THREE.Vector3 }
  | { kind: "edge"; index: number; point: THREE.Vector3 }
  | { kind: "plane"; ref: PlaneRef; label: string; point: THREE.Vector3 }
  | { kind: "region"; index: number; point: THREE.Vector3 };

/** Região escolhível de um esboço (malha, esboço, assinatura dos contornos e semente). */
export interface RegionMesh { mesh: THREE.Mesh; sketch: string; sig: string[]; seed: [number, number] }

/** O que se pode atingir com o raio: corpo (faces e arestas), regiões e planos. */
export interface Pickables {
  mesh: MeshData | null;
  faceMesh: THREE.Mesh | null;
  edgeLines: THREE.LineSegments | null;
  faceOfTri: Int32Array;
  regionMeshes: RegionMesh[];
  planeMeshes: PlaneMesh[];
}

/** Triângulo → face e intervalo de vértices de cada face (para colorir e selecionar por caixa). */
export function faceIndex(mesh: MeshData): { faceOfTri: Int32Array; faceVerts: [number, number][] } {
  const faceOfTri = new Int32Array(mesh.triangles.length / 3);
  const faceVerts = mesh.faces.map((f, i): [number, number] => {
    let lo = Infinity, hi = -1;
    for (let k = f.start; k < f.start + f.count; k++) { const v = mesh.triangles[k]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let t = f.start / 3; t < (f.start + f.count) / 3; t++) faceOfTri[t] = i;
    return [lo, hi];
  });
  return { faceOfTri, faceVerts };
}

/** Chave estável do elemento (a mesma usada no conjunto de seleção). */
export function keyOf(h: Hit, mesh: MeshData | null, regionMeshes: RegionMesh[]): string {
  if (h.kind === "face") return `face:${mesh!.faces[h.index].name}`;
  if (h.kind === "edge") return `edge:${mesh!.edges[h.index].name}`;
  if (h.kind === "region") return `region:${regionMeshes[h.index].sig.join("+")}`;
  return `plane:${JSON.stringify(h.ref)}`;
}

/** Escolha (Pick) a enviar à app para o elemento atingido. */
export function toPick(h: Hit, mesh: MeshData | null, regionMeshes: RegionMesh[]): Pick {
  if (h.kind === "face") { const f = mesh!.faces[h.index]; return { kind: "face", name: f.name, type: f.type, hint: { c: f.center, n: f.normal }, body: f.body, point: [h.point.x, h.point.y, h.point.z] }; }
  if (h.kind === "edge") { const e = mesh!.edges[h.index]; return { kind: "edge", name: e.name, type: e.type, hint: { c: e.mid, n: e.dir }, point: [h.point.x, h.point.y, h.point.z] }; }
  if (h.kind === "region") { const r = regionMeshes[h.index]; return { kind: "region", sketch: r.sketch, sig: r.sig, seed: r.seed }; }
  return { kind: "plane", ref: h.ref, label: h.label };
}

/**
 * Elemento sob o cursor, por ordem: regiões, arestas (com tolerância de alguns píxeis `wpp`), faces e
 * planos. `accept` filtra os tipos (null = todos); em `wireframe` as arestas ganham às faces.
 */
export function hitTest(ray: THREE.Raycaster, camera: THREE.Camera, canvas: HTMLCanvasElement, ev: { clientX: number; clientY: number }, accept: PickKind[] | null, p: Pickables, wpp: number, wireframe: boolean): Hit | null {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const ok = (k: PickKind) => !accept || accept.includes(k);
  ray.params.Line = { threshold: wpp * 6 };
  if (ok("region") && p.regionMeshes.length) {
    const rh = ray.intersectObjects(p.regionMeshes.map((r) => r.mesh), false)[0];
    if (rh) return { kind: "region", index: p.regionMeshes.findIndex((r) => r.mesh === rh.object), point: rh.point };
    if (accept?.length === 1) return null;
  }
  let faceHit: THREE.Intersection | undefined;
  if (p.faceMesh) faceHit = ray.intersectObject(p.faceMesh)[0];
  if (p.edgeLines && p.edgeLines.visible !== false && ok("edge")) {
    const eh = ray.intersectObject(p.edgeLines)[0];
    if (eh && (!faceHit || eh.distance <= faceHit.distance + wpp * 8 || wireframe) && eh.index !== undefined) {
      const vi = eh.index;
      const idx = p.mesh!.edges.findIndex((e) => vi >= e.start && vi < e.start + e.count);
      if (idx >= 0) return { kind: "edge", index: idx, point: eh.point };
    }
  }
  if (faceHit && faceHit.faceIndex != null && ok("face")) return { kind: "face", index: p.faceOfTri[faceHit.faceIndex], point: faceHit.point };
  if (faceHit) return null;
  if (ok("plane")) {
    const ph = ray.intersectObjects(p.planeMeshes.map((p) => p.mesh), false)[0];
    if (ph) { const pm = p.planeMeshes.find((x) => x.mesh === ph.object)!; return { kind: "plane", ref: pm.ref, label: pm.label, point: ph.point }; }
  }
  return null;
}

/**
 * Seleção por caixa no ecrã (w × h): arestas (e faces, se o filtro as aceitar) totalmente dentro da
 * caixa (→ janela) ou que a tocam (← cruzamento).
 */
export function boxSelect(a: [number, number], b: [number, number], mesh: MeshData | null, faceVerts: [number, number][], camera: THREE.Camera, w: number, h: number, accept: PickKind[] | null, pick: (h: Hit) => Pick): Pick[] {
  if (!mesh) return [];
  const crossing = b[0] < a[0];
  const [x0, x1, y0, y1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const v = new THREE.Vector3();
  const inside = (arr: Float32Array, i: number) => {
    v.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).project(camera);
    const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
    return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
  };
  const test = (arr: Float32Array, idx: Iterable<number>) => {
    let any = false, all = true;
    for (const i of idx) { const ins = inside(arr, i); any ||= ins; all &&= ins; if (crossing && any) return true; }
    return crossing ? any : all;
  };
  const out: Pick[] = [];
  const wantFaces = accept?.includes("face") && !accept.includes("edge");
  const wantEdges = !accept || accept.includes("edge");
  if (wantEdges) mesh.edges.forEach((e, i) => {
    const idx = Array.from({ length: e.count }, (_, k) => e.start + k);
    if (test(mesh.lines, idx)) out.push(pick({ kind: "edge", index: i, point: new THREE.Vector3() }));
  });
  if (wantFaces) mesh.faces.forEach((f, i) => {
    const [lo, hi] = faceVerts[i];
    if (test(mesh.vertices, Array.from({ length: hi - lo + 1 }, (_, k) => lo + k))) out.push(pick({ kind: "face", index: i, point: new THREE.Vector3() }));
  });
  return out;
}
