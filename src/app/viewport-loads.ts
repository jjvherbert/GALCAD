// Setas das cargas na vista 3D (C1c): forças nas faces, pressão ao longo da normal, cargas num ponto e
// gravidade. Comprimento proporcional à intensidade (`LoadGlyph.scale`) e cor por carga. A geometria da
// seta é partilhada (`userData.shared`): reconstruir só cria instâncias e materiais.
import * as THREE from "three";
import type { MeshData } from "../kernel/mesh.ts";
import type { LoadGlyph } from "./load-glyphs.ts";

/** Seta unitária com a ponta na origem e o corpo em -Y (comprimento 1). */
let arrowGeom: THREE.BufferGeometry | null = null;
function arrow() {
  if (arrowGeom) return arrowGeom;
  const shaft = new THREE.CylinderGeometry(0.025, 0.025, 0.72, 8).translate(0, -0.64, 0);
  const head = new THREE.ConeGeometry(0.08, 0.28, 12).translate(0, -0.14, 0);
  const g = new THREE.BufferGeometry();
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (const part of [shaft, head]) {
    const base = pos.length / 3;
    pos.push(...(part.getAttribute("position").array as Float32Array));
    nor.push(...(part.getAttribute("normal").array as Float32Array));
    for (const i of part.getIndex()!.array) idx.push(base + i);
    part.dispose();
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return (arrowGeom = g);
}

/** Máximo de setas por face (amostra de triângulos espaçada). */
const PER_FACE = 9;
const UP = new THREE.Vector3(0, 1, 0);

type Arrow = { tip: THREE.Vector3; dir: THREE.Vector3 };

/** Centros e normais (para fora) de uma amostra dos triângulos da face. */
function faceSamples(mesh: MeshData, start: number, count: number): Arrow[] {
  const tris = count / 3, step = Math.max(1, Math.floor(tris / PER_FACE)), out: Arrow[] = [];
  const v = (i: number) => new THREE.Vector3(mesh.vertices[3 * i], mesh.vertices[3 * i + 1], mesh.vertices[3 * i + 2]);
  for (let t = Math.floor(step / 2); t < tris && out.length < PER_FACE; t += step) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.triangles[start + 3 * t + k]);
    const pa = v(a), pb = v(b), pc = v(c);
    const n = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
    if (n.lengthSq() < 1e-20) continue;
    out.push({ tip: pa.add(pb).add(pc).divideScalar(3), dir: n.normalize() });
  }
  return out;
}

const vec = (v: readonly number[]) => new THREE.Vector3(v[0], v[1], v[2]);

/** Constrói as setas em `group` (já vazio); devolve quantas setas desenhou. */
export function buildLoadArrows(group: THREE.Group, glyphs: LoadGlyph[], mesh: MeshData | null): number {
  if (!mesh || !glyphs.length) return 0;
  const box = new THREE.Box3().setFromArray(mesh.vertices);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const centre = box.getCenter(new THREE.Vector3());
  const faceBy = new Map(mesh.faces.map((f) => [f.name, f]));
  const edgeBy = new Map(mesh.edges.map((e) => [e.name, e]));
  let total = 0;
  for (const g of glyphs) {
    const L = 0.16 * size * g.scale;
    const arrows: Arrow[] = [];
    const d = g.vec ? vec(g.vec).normalize() : null;
    for (const name of g.faces) {
      const f = faceBy.get(name);
      if (!f) continue;
      for (const s of faceSamples(mesh, f.start, f.count)) {
        if (g.kind === "pressure") {
          // p > 0 empurra contra a face: a seta vem de fora e acaba na superfície; p < 0 (sucção) sai dela.
          if ((g.p ?? 0) > 0) arrows.push({ tip: s.tip, dir: s.dir.clone().negate() });
          else arrows.push({ tip: s.tip.clone().addScaledVector(s.dir, L), dir: s.dir });
        } else if (d) arrows.push({ tip: s.tip, dir: d });
      }
    }
    for (const name of g.edges) {
      const e = edgeBy.get(name);
      if (e && d) arrows.push({ tip: vec(e.mid), dir: d });
    }
    if (g.point && d) arrows.push({ tip: vec(g.point), dir: d });
    // Gravidade: uma seta a partir do centro do modelo.
    if (g.kind === "gravity" && d) arrows.push({ tip: centre.clone().addScaledVector(d, L), dir: d });
    if (!arrows.length) continue;
    const mat = new THREE.MeshBasicMaterial({ color: g.color, depthTest: false, transparent: true, opacity: 0.95 });
    const inst = new THREE.InstancedMesh(arrow(), mat, arrows.length);
    inst.userData.shared = true;
    inst.userData.load = g.index;
    inst.renderOrder = 5;
    inst.frustumCulled = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(L, L, L);
    arrows.forEach((a, i) => inst.setMatrixAt(i, m.compose(a.tip, q.setFromUnitVectors(UP, a.dir), sc)));
    group.add(inst);
    total += arrows.length;
  }
  return total;
}

/** Liberta as instâncias (a geometria partilhada fica). */
export function disposeLoadArrows(group: THREE.Group) {
  group.traverse((o) => { if (o instanceof THREE.InstancedMesh) o.dispose(); });
}
