// Rede de controlo (polos) da forma livre em edição: desenho no 3D e escolha do polo sob o cursor.
import * as THREE from "three";

/** Rede de controlo de uma superfície de forma livre (polos linha a linha, u maior). */
export interface PoleNet { nu: number; nv: number; poles: number[] }

/**
 * Desenha a rede no grupo (já vazio): polos (o selecionado e o pré-visualizado a vermelho) e linhas
 * entre vizinhos. Publica o número de polos e a posição no ecrã do polo central em `data`.
 */
export function drawPoleNet(group: THREE.Group, net: PoleNet | null, sel: number, camera: THREE.Camera, canvas: HTMLCanvasElement, data: DOMStringMap, preview?: { k: number; p: THREE.Vector3 }) {
  data.poles = net ? String(net.nu * net.nv) : "";
  if (!net) return;
  const pos = new Float32Array(net.poles);
  if (preview) pos.set([preview.p.x, preview.p.y, preview.p.z], preview.k * 3);
  const col = new Float32Array(pos.length);
  const c = new THREE.Color();
  for (let k = 0; k < pos.length / 3; k++) { c.set(k === sel || k === preview?.k ? 0xdc2626 : 0x7c3aed); col.set([c.r, c.g, c.b], k * 3); }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false }));
  pts.renderOrder = 9;
  const seg: number[] = [];
  const at = (i: number, j: number) => [pos[(i * net.nv + j) * 3], pos[(i * net.nv + j) * 3 + 1], pos[(i * net.nv + j) * 3 + 2]];
  for (let i = 0; i < net.nu; i++) for (let j = 0; j < net.nv; j++) {
    if (i + 1 < net.nu) seg.push(...at(i, j), ...at(i + 1, j));
    if (j + 1 < net.nv) seg.push(...at(i, j), ...at(i, j + 1));
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.7, depthTest: false }));
  lines.renderOrder = 8;
  group.add(lines, pts);
  // posição no ecrã do polo central (ajuda os testes de interface a arrastá-lo)
  const kc = (net.nu >> 1) * net.nv + (net.nv >> 1);
  const v = new THREE.Vector3(pos[kc * 3], pos[kc * 3 + 1], pos[kc * 3 + 2]).project(camera);
  const r = canvas.getBoundingClientRect();
  data.poleCenter = `${Math.round(r.left + ((v.x + 1) / 2) * r.width)},${Math.round(r.top + ((1 - v.y) / 2) * r.height)}`;
}

/** Índice do polo sob o cursor (a menos de 9 px), ou −1. */
export function poleAt(net: PoleNet | null, camera: THREE.Camera, canvas: HTMLCanvasElement, ev: { clientX: number; clientY: number }): number {
  if (!net) return -1;
  const r = canvas.getBoundingClientRect();
  const v = new THREE.Vector3();
  let best = -1, bestD = 9;
  for (let k = 0; k < net.poles.length / 3; k++) {
    v.set(net.poles[k * 3], net.poles[k * 3 + 1], net.poles[k * 3 + 2]).project(camera);
    const d = Math.hypot(((v.x + 1) / 2) * r.width - (ev.clientX - r.left), ((1 - v.y) / 2) * r.height - (ev.clientY - r.top));
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
