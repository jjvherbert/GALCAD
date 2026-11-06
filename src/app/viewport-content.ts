// Conteúdo do visualizador: corpo (faces e arestas), malhas sobrepostas, regiões de esboço,
// material das faces conforme a análise (zebra, linhas de realce, sombreado) e pentes de curvatura.
import * as THREE from "three";
import type { MeshData } from "../kernel/mesh.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { Analysis } from "./store.ts";
import { highlightMaterial, zebraTexture } from "./viewport-style.ts";
import * as select from "./viewport-select.ts";
import type { RegionMesh } from "./viewport-select.ts";

/** Materiais das faces: sombreado com cores (por corpo) e, criados quando precisos, zebra e linhas de realce. */
export interface FaceMats {
  shaded: THREE.Material | null;
  zebra: THREE.MeshMatcapMaterial | null;
  highlight: THREE.ShaderMaterial | null;
}

/** Corpo construído: malhas das faces e arestas, e índices triângulo → face e vértices de cada face. */
export interface Body {
  faceMesh: THREE.Mesh;
  edgeLines: THREE.LineSegments;
  faceOfTri: Int32Array;
  faceVerts: [number, number][];
}

/** Liberta geometrias (exceto as partilhadas) e materiais de um grupo e esvazia-o. */
export function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.userData?.shared) m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
  });
  g.clear();
}

/** Constrói faces e arestas do corpo em `group`; cria o material sombreado novo em `mats.shaded`. */
export function buildBody(group: THREE.Group, mesh: MeshData, mats: FaceMats, a: Analysis | null, size: number): Body {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.vertices.length), 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  // triângulo → face e intervalo de vértices de cada face (para colorir)
  const { faceOfTri, faceVerts } = select.faceIndex(mesh);
  mats.shaded = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const faceMesh = new THREE.Mesh(g, faceMaterial(mats, a, size));
  const eg = new THREE.BufferGeometry();
  eg.setAttribute("position", new THREE.BufferAttribute(mesh.lines, 3));
  eg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.lines.length), 3));
  const edgeLines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true }));
  group.add(faceMesh, edgeLines);
  return { faceMesh, edgeLines, faceOfTri, faceVerts };
}

/** Malhas sobrepostas a vermelho (ex.: volumes de interferência) em `group`, por cima do modelo. */
export function buildOverlay(group: THREE.Group, meshes: MeshData[]) {
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(m.triangles, 1));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 6;
    group.add(mesh);
  }
}

/** Regiões escolhíveis de um esboço (no referencial do esboço) em `group`, por cima do modelo. */
export function buildRegions(group: THREE.Group, sketch: string, view: RebuildResponse["sketches"][string]): RegionMesh[] {
  const out: RegionMesh[] = [];
  const f = view.frame;
  for (const r of view.regionList) {
    const pos = new Float32Array((r.tris.length / 2) * 3);
    for (let i = 0, j = 0; i < r.tris.length; i += 2, j += 3) {
      const x = r.tris[i], y = r.tris[i + 1];
      pos[j] = f.o[0] + f.x[0] * x + f.y[0] * y;
      pos[j + 1] = f.o[1] + f.x[1] * x + f.y[1] * y;
      pos[j + 2] = f.o[2] + f.x[2] * x + f.y[2] * y;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x9333ea, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    mesh.renderOrder = 5;
    group.add(mesh);
    out.push({ mesh, sketch, sig: r.sig, seed: r.seed });
  }
  return out;
}

/** Material das faces conforme a análise (zebra, linhas de realce ou sombreado com cores). */
export function faceMaterial(mats: FaceMats, a: Analysis | null, size: number): THREE.Material {
  if (a?.kind === "zebra") {
    mats.zebra ??= new THREE.MeshMatcapMaterial({ matcap: zebraTexture(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    return mats.zebra;
  }
  if (a?.kind === "highlight") {
    mats.highlight ??= highlightMaterial();
    const u = mats.highlight.uniforms;
    const axes = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] } as const;
    const e = axes[a.axis];
    // luzes acima do modelo: plano perpendicular ao eixo "mais vertical" que não é o das luzes
    const up = a.axis === "Z" ? axes.Y : axes.Z;
    const sdir = new THREE.Vector3(...e).cross(new THREE.Vector3(...up)).normalize();
    u.e.value.set(...e);
    u.sdir.value.copy(sdir);
    const k = new THREE.Vector3(...e).cross(sdir);
    u.h.value = size * 0.8 * k.dot(new THREE.Vector3(...up));
    u.w.value = a.spacing;
    return mats.highlight;
  }
  return mats.shaded!;
}

/** O que a análise de superfície altera: corpo e malhas, materiais, escala do modelo e grupo dos pentes. */
export interface AnalysisState {
  mesh: MeshData | null;
  faceMesh: THREE.Mesh | null;
  mats: FaceMats;
  size: number;
  scene: THREE.Scene;
  analysisGroup: THREE.Group;
}

/**
 * Aplica a análise: normais exatas e material das faces, pentes (linhas) no grupo próprio; publica
 * `exactNormals`, `analysis` e `combs` em `data`. As cores ficam para quem chama (recolorir).
 */
export function applyAnalysis(s: AnalysisState, a: Analysis | null, data: DOMStringMap) {
  // linhas de realce: normais exatas do núcleo (as da malha são médias dos triângulos)
  if (s.faceMesh && s.mesh) {
    const exact = a?.kind === "highlight" && a.normals && a.normals.length === s.mesh.normals.length ? a.normals : null;
    s.faceMesh.geometry.setAttribute("normal", new THREE.BufferAttribute(exact ?? s.mesh.normals, 3));
    data.exactNormals = exact ? "1" : "";
  }
  if (s.faceMesh && s.mats.shaded) s.faceMesh.material = faceMaterial(s.mats, a, s.size);
  data.analysis = a?.kind ?? "";
  disposeGroup(s.analysisGroup);
  if (!s.analysisGroup.parent) s.scene.add(s.analysisGroup);
  if (a?.kind === "combs" && a.data) {
    const add = (arr: Float32Array, color: number) => {
      if (!arr.length) return;
      const g = new THREE.BufferGeometry();
      // as cerdas são desenhadas com o ganho escolhido na interface (a partir da base de cada cerda)
      const pos = arr.slice();
      if (a.gain !== 1 && arr === a.data!.quills) for (let i = 0; i < pos.length; i += 6) for (let k = 0; k < 3; k++) pos[i + 3 + k] = pos[i + k] + (pos[i + 3 + k] - pos[i + k]) * a.gain;
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 7;
      s.analysisGroup.add(l);
    };
    add(a.data.quills, 0x7c3aed);
    if (a.gain === 1) add(a.data.envelope, 0xdb2777);
    data.combs = String(a.data.quills.length / 6);
  }
}
