// Malhas dos resultados de simulação no visualizador 3D (camadas FEM/CFD coloridas e deformada).
import * as THREE from "three";
import { type ResultView, fieldRange, layerShown } from "../sim/result.ts";
import { sequentialColor } from "./viewport-style.ts";

export interface SimView { field: number; disp: number; scale: number; hidden: string[]; anim?: boolean }

/** Período da deformada animada (ms). */
export const SIM_ANIM_PERIOD = 1600;

/** Fator da deformada animada no instante `t` (ms): oscila entre −1 e 1, como um modo de vibração. */
export function simAnimPhase(t: number, period = SIM_ANIM_PERIOD): number {
  return Math.sin((2 * Math.PI * t) / period);
}

/** Posições animadas: `pos = base + s·dk` (a deformada ampliada `dk` já vem multiplicada pela ampliação). */
export function applySimPhase(pos: Float32Array, base: ArrayLike<number>, dk: Float32Array, s: number): void {
  for (let i = 0; i < pos.length; i++) pos[i] = base[i] + s * dk[i];
}

interface SimAnimLayer { pos: Float32Array; base: ArrayLike<number>; dk: Float32Array; attrs: THREE.BufferAttribute[] }

/** Avança a deformada animada dos resultados em `group` (nada faz se a animação não estiver ligada). */
export function stepSimAnim(group: THREE.Group, t: number): void {
  const anim = group.userData.anim as SimAnimLayer[] | undefined;
  if (!anim?.length) return;
  const s = simAnimPhase(t);
  for (const a of anim) {
    applySimPhase(a.pos, a.base, a.dk, s);
    for (const at of a.attrs) at.needsUpdate = true;
  }
}

/**
 * Junta a `group` as camadas visíveis de `r`: cores do campo escolhido na paleta sequencial, com a
 * mesma escala em todas as camadas, e deformada ampliada. `edges` (o contorno da peça) só se passa nos
 * resultados FEM, para o mostrar a cinzento por baixo da deformada. Devolve a ampliação usada.
 */
export function buildSimLayers(group: THREE.Group, r: ResultView, view: SimView, size: number, edges: THREE.LineSegments | null): { dmax: number; k: number } {
  const range = fieldRange(r, view.field, view.hidden);
  // ampliação comum a todas as camadas (a maior deformação vale 8 % da cena)
  let dmax = 0;
  for (const l of r.layers) {
    const d = l.displacements?.[view.disp];
    if (d) for (let i = 0; i < d.length; i += 3) dmax = Math.max(dmax, Math.hypot(d[i], d[i + 1], d[i + 2]));
  }
  const k = view.scale > 0 ? view.scale : dmax > 0 ? (0.08 * size) / dmax : 0;
  const c = new THREE.Color();
  const anim: SimAnimLayer[] = [];
  for (const l of r.layers) {
    if (!layerShown(l, view.hidden)) continue;
    const pos = new Float32Array(l.positions);
    const d = l.displacements?.[view.disp];
    if (d) for (let i = 0; i < pos.length; i++) pos[i] += d[i] * k;
    const vals = l.values[view.field];
    const col = new Float32Array(pos.length);
    if (vals && range) {
      const [lo, hi] = range;
      // campo constante (ex.: malha toda perfeita): cor do meio da escala, para as arestas se verem
      vals.forEach((x, i) => { sequentialColor(hi > lo ? (x - lo) / (hi - lo) : 0.5, c); col.set([c.r, c.g, c.b], i * 3); });
    } else col.fill(0.75);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(l.triangles);
    g.computeVertexNormals();
    // deformada animada: guarda a posição de base e a deformada ampliada para o ciclo do visualizador
    const ai = view.anim && d && k > 0 ? anim.push({ pos, base: l.positions, dk: Float32Array.from(d, (x) => x * k), attrs: [g.getAttribute("position") as THREE.BufferAttribute] }) - 1 : -1;
    group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
    // arestas dos elementos (pré-visualização da malha)
    if (l.edges?.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      eg.setIndex(l.edges);
      if (ai >= 0) anim[ai].attrs.push(eg.getAttribute("position") as THREE.BufferAttribute);
      group.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1f2937, transparent: true, opacity: 0.55 })));
    }
  }
  // contorno da peça não deformada, a cinzento, como referência
  if (edges && dmax > 0) {
    const ref = new THREE.LineSegments(edges.geometry, new THREE.LineBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.6 }));
    ref.userData.shared = true;
    group.add(ref);
  }
  group.userData.anim = anim;
  return { dmax, k };
}
