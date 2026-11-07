// Vista 3D: navegação da câmara (histórico, pivô, rotação, pan, zoom, enquadramento, vistas, esboço) e transições animadas.
import * as THREE from "three";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { Vec3 } from "../doc/types.ts";
import { VIEWS, type ViewName } from "./viewport-views.ts";
import { modelSize } from "./viewport-scene.ts";
import * as cam from "./viewport-camera.ts";
import type { Viewport } from "./viewport.ts";

export function viewDir(v: Viewport): THREE.Vector3 { return cam.viewDirOf(v.camera, v.target); }

export function save(v: Viewport): cam.CamState { return cam.saveCam(v.camera, v.target, v.size); }
export function restore(v: Viewport, s: cam.CamState) { v.size = cam.applyCam(v.camera, v.target, s); v.resize(); }
export function pushHistory(v: Viewport) { v.history.push(save(v)); if (v.history.length > 30) v.history.shift(); }

export function previousView(v: Viewport) { const s = v.history.pop(); if (s) smooth(v, () => restore(v, s)); }

export function setPivot(v: Viewport, p: THREE.Vector3 | null) {
  v.pivot = p ? p.clone() : null;
  v.pivotMarker.visible = !!p;
  if (p) { v.pivotMarker.position.copy(p); v.pivotMarker.scale.setScalar(v.worldPerPx() * 4); }
}

export function rotateBy(v: Viewport, degX: number, degY: number, aboutPoint: THREE.Vector3 = v.pivot ?? v.target) {
  finishAnim(v);
  cam.rotateCam(v.camera, v.target, aboutPoint, degX, degY);
  if (v.pivotMarker.visible) v.pivotMarker.scale.setScalar(v.worldPerPx() * 4);
  v.publish();
}

export function roll(v: Viewport, deg: number) {
  finishAnim(v);
  cam.rollCam(v.camera, v.target, deg);
  v.publish();
}

export function panBy(v: Viewport, dx: number, dy: number) {
  finishAnim(v);
  cam.panCam(v.camera, v.target, dx, dy, v.worldPerPx());
  v.publish();
}

export function zoomAt(v: Viewport, factor: number, at?: [number, number]) {
  finishAnim(v);
  const w = v.el.clientWidth, h = v.el.clientHeight;
  cam.zoomCam(v.camera, v.target, factor, at ?? [w / 2, h / 2], w, h);
  v.publish();
}

export function fit(v: Viewport, result: RebuildResponse | null, record = true) {
  if (record) pushHistory(v);
  smooth(v, () => fitNow(v, result, false));
}

export function fitNow(v: Viewport, result: RebuildResponse | null, record: boolean) {
  if (record) pushHistory(v);
  const m = result?.mass;
  const c = m ? new THREE.Vector3((m.bbox.min[0] + m.bbox.max[0]) / 2, (m.bbox.min[1] + m.bbox.max[1]) / 2, (m.bbox.min[2] + m.bbox.max[2]) / 2) : new THREE.Vector3();
  v.size = modelSize(result) * 0.6;
  const dir = viewDir(v);
  v.target.copy(c);
  v.camera.position.copy(c).addScaledVector(dir, v.size * 20);
  v.camera.zoom = 1;
  v.camera.lookAt(v.target);
  setPivot(v, null);
  v.resize();
}

export function view(v: Viewport, name: ViewName, result: RebuildResponse | null, instant = false) {
  pushHistory(v);
  const was = v.animate;
  if (instant) v.animate = false;
  smooth(v, () => {
    const w = VIEWS[name];
    v.camera.up.set(...w.up);
    v.camera.position.copy(v.target).add(new THREE.Vector3(...w.dir).normalize().multiplyScalar(1000));
    v.camera.lookAt(v.target);
    fitNow(v, result, false);
  });
  v.animate = was;
}

export function normalTo(v: Viewport, o: Vec3, n: Vec3, up?: Vec3) {
  pushHistory(v);
  smooth(v, () => {
    const nn = new THREE.Vector3(...n).normalize();
    // "para cima" do ecrã: o eixo dado, ou o Z global projetado (ou Y, se a normal for vertical)
    let u = up ? new THREE.Vector3(...up) : new THREE.Vector3(0, 0, 1);
    if (Math.abs(u.dot(nn)) > 0.99) u = new THREE.Vector3(0, 1, 0);
    u.sub(nn.clone().multiplyScalar(u.dot(nn))).normalize();
    const dist = v.camera.position.distanceTo(v.target) || 1000;
    v.target.set(...o);
    v.camera.up.copy(u);
    v.camera.position.copy(v.target).addScaledVector(nn, dist);
    v.camera.lookAt(v.target);
    v.publish();
  });
}

export function setSketchCamera(v: Viewport, frame: { o: Vec3; x: Vec3; y: Vec3; z: Vec3 }, k: number, tx: number, ty: number, canvas: HTMLElement, animated: boolean) {
  const base = !v.sketchBase;
  if (base) v.sketchBase = save(v);
  const apply = () => {
    const r = canvas.getBoundingClientRect(), vr = v.el.getBoundingClientRect();
    const W = v.el.clientWidth || 1, H = v.el.clientHeight || 1;
    const uc = (W / 2 - (r.left - vr.left) - tx) / k, vc = (ty - (H / 2 - (r.top - vr.top))) / k;
    const target = new THREE.Vector3(...frame.o).addScaledVector(new THREE.Vector3(...frame.x), uc).addScaledVector(new THREE.Vector3(...frame.y), vc);
    v.target.copy(target);
    v.camera.up.set(...frame.y);
    v.camera.position.copy(target).addScaledVector(new THREE.Vector3(...frame.z).normalize(), v.size * 20);
    v.camera.zoom = Math.min(1e4, Math.max(1e-3, (2 * k * v.size) / H));
    v.camera.lookAt(target);
    v.updateProj();
    v.publish();
  };
  if (base && animated) smooth(v, apply, 420);
  else { finishAnim(v); apply(); v.camera.updateMatrixWorld(true); }
}

export function leaveSketchView(v: Viewport) {
  const b = v.sketchBase;
  v.sketchBase = null;
  if (b) smooth(v, () => restore(v, b));
}

export function smooth(v: Viewport, change: () => void, ms = 380) {
  if (v.smoothing) { change(); return; }
  const a = save(v); // a transição seguinte parte de onde a câmara está agora…
  finishAnim(v); // …mas a mudança calcula-se a partir do estado final da anterior (ex.: Ctrl+5 e logo F)
  v.el.dataset.animating = "";
  v.smoothing = true;
  try { change(); } finally { v.smoothing = false; }
  const b = save(v);
  const moved = a.pos.distanceTo(b.pos) + a.target.distanceTo(b.target) + a.up.distanceTo(b.up) + Math.abs(a.zoom - b.zoom) + Math.abs(a.size - b.size) > 1e-6;
  if (!v.animate || !moved) return;
  const qb = v.camera.quaternion.clone();
  v.camera.position.copy(a.pos); v.camera.up.copy(a.up); v.camera.lookAt(a.target);
  const qa = v.camera.quaternion.clone();
  v.anim = { t0: performance.now(), ms, a, b, qa, qb };
  v.el.dataset.animating = "1";
  stepAnim(v);
}

export function stepAnim(v: Viewport) {
  const an = v.anim;
  if (!an) return;
  const size = cam.stepCam(an, v.camera, v.target);
  if (size === null) { finishAnim(v); return; }
  v.size = size;
  v.updateProj();
}

export function finishAnim(v: Viewport) {
  const an = v.anim;
  if (!an) return;
  v.anim = null;
  v.el.dataset.animating = "";
  v.size = cam.applyCam(v.camera, v.target, an.b);
  v.updateProj();
  v.camera.updateMatrixWorld(true); // a seleção por raio usa já a câmara final
  v.publish();
}
