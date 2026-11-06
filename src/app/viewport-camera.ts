// Câmara do visualizador: estado, rotação/rolamento/deslocação/zoom, passo das transições e
// desenho da caixa e dos gestos do rato.
import * as THREE from "three";
import type { GestureDir } from "./settings.ts";

/** Estado da câmara (posição, centro, "para cima", zoom e meia-altura da vista). */
export interface CamState { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number; size: number }

/** Transição em curso: início, duração, estados inicial e final e as orientações respetivas. */
export interface CamAnim { t0: number; ms: number; a: CamState; b: CamState; qa: THREE.Quaternion; qb: THREE.Quaternion }

/** Direção do centro para a câmara (unitária). */
export function viewDirOf(camera: THREE.Camera, target: THREE.Vector3): THREE.Vector3 { return camera.position.clone().sub(target).normalize(); }

/** Cópia do estado atual da câmara. */
export function saveCam(camera: THREE.OrthographicCamera, target: THREE.Vector3, size: number): CamState {
  return { pos: camera.position.clone(), target: target.clone(), up: camera.up.clone(), zoom: camera.zoom, size };
}

/** Repõe um estado na câmara e no centro; devolve a meia-altura (`size`) a guardar. */
export function applyCam(camera: THREE.OrthographicCamera, target: THREE.Vector3, s: CamState): number {
  camera.position.copy(s.pos); target.copy(s.target); camera.up.copy(s.up); camera.zoom = s.zoom;
  camera.lookAt(target);
  return s.size;
}

/** Roda câmara e centro (graus) em torno dos eixos do ecrã, centrado em `aboutPoint`. */
export function rotateCam(cam: THREE.Camera, target: THREE.Vector3, aboutPoint: THREE.Vector3, degX: number, degY: number) {
  const about = aboutPoint.clone(); // pode ser o próprio target, que também é rodado
  const up = cam.up.clone().normalize();
  const back = viewDirOf(cam, target);
  const right = up.clone().cross(back).normalize();
  const screenUp = back.clone().cross(right).normalize();
  const q = new THREE.Quaternion().setFromAxisAngle(screenUp, (-degX * Math.PI) / 180)
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, (-degY * Math.PI) / 180));
  const rot = (v: THREE.Vector3) => v.sub(about).applyQuaternion(q).add(about);
  rot(cam.position); rot(target);
  cam.up.copy(screenUp.applyQuaternion(q));
  cam.lookAt(target);
}

/** Rola a vista (graus) em torno da direção de visão. */
export function rollCam(camera: THREE.Camera, target: THREE.Vector3, deg: number) {
  camera.up.applyAxisAngle(viewDirOf(camera, target), (deg * Math.PI) / 180);
  camera.lookAt(target);
}

/** Desloca câmara e centro em pixels (`wpp`: unidades do mundo por pixel). */
export function panCam(camera: THREE.Camera, target: THREE.Vector3, dx: number, dy: number, wpp: number) {
  const back = viewDirOf(camera, target);
  const right = camera.up.clone().cross(back).normalize();
  const up = back.clone().cross(right).normalize();
  const delta = right.multiplyScalar(-dx * wpp).add(up.multiplyScalar(dy * wpp));
  camera.position.add(delta);
  target.add(delta);
}

/** Zoom por um fator (> 1 afasta, < 1 aproxima), mantendo fixo o ponto `p` de uma vista w × h. */
export function zoomCam(camera: THREE.OrthographicCamera, target: THREE.Vector3, factor: number, p: [number, number], w: number, h: number) {
  const before = screenToWorld(camera, p, w, h);
  camera.zoom = Math.min(1e4, Math.max(1e-3, camera.zoom / factor));
  camera.updateProjectionMatrix();
  const after = screenToWorld(camera, p, w, h);
  const delta = before.sub(after);
  camera.position.add(delta);
  target.add(delta);
}

/** Ponto do ecrã (pixels de uma vista w × h) no plano próximo, em coordenadas do mundo. */
export function screenToWorld(camera: THREE.Camera, p: [number, number], w: number, h: number): THREE.Vector3 {
  return new THREE.Vector3((p[0] / w) * 2 - 1, -(p[1] / h) * 2 + 1, 0).unproject(camera);
}

/**
 * Passo da transição: põe a câmara e o centro no estado interpolado e devolve a meia-altura (`size`)
 * interpolada, ou null se a transição já terminou (o chamador salta para o fim).
 */
export function stepCam(an: CamAnim, camera: THREE.OrthographicCamera, target: THREE.Vector3): number | null {
  const t = Math.min(1, (performance.now() - an.t0) / an.ms);
  if (t >= 1) return null;
  const u = 1 - Math.pow(1 - t, 3); // desaceleração suave no fim
  const q = an.qa.clone().slerp(an.qb, u);
  const at = an.a.target.clone().lerp(an.b.target, u);
  const dist = THREE.MathUtils.lerp(an.a.pos.distanceTo(an.a.target), an.b.pos.distanceTo(an.b.target), u);
  target.copy(at);
  camera.quaternion.copy(q);
  camera.position.copy(at).add(new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(dist));
  camera.up.set(0, 1, 0).applyQuaternion(q);
  camera.zoom = Math.exp(THREE.MathUtils.lerp(Math.log(an.a.zoom), Math.log(an.b.zoom), u));
  return THREE.MathUtils.lerp(an.a.size, an.b.size, u);
}

/** Direção de um gesto do botão direito (a partir de 40 px), ou null. */
export function gestureDir(a: [number, number], b: [number, number]): GestureDir | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 40) return null;
  const ang = (Math.atan2(-dy, dx) * 180) / Math.PI; // 0 = direita, 90 = cima
  const dirs: GestureDir[] = ["right", "upRight", "up", "upLeft", "left", "downLeft", "down", "downRight"];
  return dirs[((Math.round(ang / 45) % 8) + 8) % 8];
}

/** Mostra a caixa de seleção entre `a` e `b` (pixels da vista). */
export function drawBox(el: HTMLElement, a: [number, number], b: [number, number]) {
  const s = el.style;
  s.display = "block";
  s.left = `${Math.min(a[0], b[0])}px`; s.top = `${Math.min(a[1], b[1])}px`;
  s.width = `${Math.abs(b[0] - a[0])}px`; s.height = `${Math.abs(b[1] - a[1])}px`;
  // → janela (contínua): só o que está totalmente dentro; ← cruzamento (tracejada): o que toca
  el.classList.toggle("crossing", b[0] < a[0]);
}

/** Desenha o rasto do gesto do botão direito. */
export function drawGesture(el: HTMLElement, path: [number, number][]) {
  const svg = `<svg width="100%" height="100%"><polyline points="${path.map((p) => p.join(",")).join(" ")}" /></svg>`;
  el.innerHTML = svg;
}
