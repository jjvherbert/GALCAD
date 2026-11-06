// Rato do visualizador: premir, mover, largar, duplo clique e roda (rodar, deslocar, zoom,
// rolar, caixa, gestos e arrasto de polos). O estado do arrasto vive em `MouseState`; o
// `Viewport` dá o resto (câmara, elementos, callbacks) através de `MouseHost`.
import * as THREE from "three";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { Vec3 } from "../doc/types.ts";
import type { Pick, PickKind } from "./store.ts";
import type { GestureDir, Settings } from "./settings.ts";
import { type PoleNet, poleAt } from "./viewport-poles.ts";
import type { Hit } from "./viewport-select.ts";
import * as cam from "./viewport-camera.ts";

export type Drag = {
  button: number;
  mode: "rotate" | "pan" | "zoom" | "roll" | "box" | "gesture" | "pending" | "pole";
  pole?: { k: number; start: THREE.Vector3; plane: THREE.Plane; delta: THREE.Vector3 };
  start: [number, number];
  last: [number, number];
  path: [number, number][];
  moved: boolean;
  shift: boolean;
  ctrl: boolean;
};

export type MouseState = { drag: Drag | null; lastMiddleUp: number; wheelAt: number };

export const newMouseState = (): MouseState => ({ drag: null, lastMiddleUp: 0, wheelAt: 0 });

/** O que os handlers precisam do `Viewport` (estado mutável lido na hora, via getters). */
export interface MouseHost {
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly ray: THREE.Raycaster;
  readonly el: HTMLElement;
  readonly boxEl: HTMLDivElement;
  readonly gestureEl: HTMLDivElement;
  readonly target: THREE.Vector3;
  readonly settings: Settings;
  readonly poleNet: PoleNet | null;
  readonly poleAxis: "free" | "X" | "Y" | "Z";
  readonly lastResult: RebuildResponse | null;
  pivot: THREE.Vector3 | null;
  local(ev: { clientX: number; clientY: number }): [number, number];
  hitTest(ev: { clientX: number; clientY: number }, accept?: PickKind[] | null): Hit | null;
  toPick(h: Hit): Pick;
  setHover(h: Hit | null): void;
  pushHistory(): void;
  rotateBy(degX: number, degY: number, aboutPoint: THREE.Vector3): void;
  panBy(dx: number, dy: number): void;
  zoomAt(factor: number, at?: [number, number]): void;
  roll(deg: number): void;
  drawPoles(preview?: { k: number; p: THREE.Vector3 }): void;
  fit(result: RebuildResponse | null): void;
  setPivot(p: THREE.Vector3 | null): void;
  publish(): void;
  finishAnim(): void;
  boxSelect(a: [number, number], b: [number, number]): Pick[];
  onPick(p: Pick, additive: boolean, at: [number, number]): void;
  onEmptyClick(): void;
  onContextMenu(at: [number, number], pick: Pick | null): void;
  onGesture(dir: GestureDir): void;
  onBoxSelect(picks: Pick[], additive: boolean): void;
  onDoubleClick(pick: Pick): void;
  onGestureTrack(dir: GestureDir | null, at: [number, number] | null): void;
  onPoleSelect(i: number, j: number): void;
  onPoleMoved(i: number, j: number, d: Vec3): void;
}

export function onDown(v: MouseHost, s: MouseState, e: PointerEvent) {
  v.finishAnim();
  const p = v.local(e);
  v.renderer.domElement.setPointerCapture(e.pointerId);
  let mode: Drag["mode"] = "pending";
  const pk = e.button === 0 ? poleAt(v.poleNet, v.camera, v.renderer.domElement, e) : -1;
  if (pk >= 0 && v.poleNet) {
    const n = v.poleNet.poles;
    const start = new THREE.Vector3(n[pk * 3], n[pk * 3 + 1], n[pk * 3 + 2]);
    const normal = new THREE.Vector3();
    v.camera.getWorldDirection(normal);
    s.drag = { button: 0, mode: "pole", start: p, last: p, path: [p], moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey,
      pole: { k: pk, start, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start), delta: new THREE.Vector3() } };
    return;
  }
  if (e.button === 1) mode = e.ctrlKey ? "pan" : e.shiftKey ? "zoom" : e.altKey ? "roll" : "rotate";
  else if (e.button === 2) mode = "gesture";
  else if (e.button === 0) mode = v.hitTest(e) ? "pending" : "box";
  s.drag = { button: e.button, mode, start: p, last: p, path: [p], moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  if (e.button === 1) {
    e.preventDefault();
    if (mode === "rotate" && !v.pivot) v.pivot = v.target.clone();
  }
}

export function onMove(v: MouseHost, s: MouseState, e: PointerEvent) {
  const p = v.local(e);
  const d = s.drag;
  if (!d) { v.setHover(v.hitTest(e)); return; }
  const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
  if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > 4) {
    d.moved = true;
    if (d.mode === "rotate" || d.mode === "pan" || d.mode === "zoom" || d.mode === "roll") v.pushHistory();
  }
  d.last = p;
  if (!d.moved) return;
  switch (d.mode) {
    case "rotate": v.rotateBy(dx * 0.5, dy * 0.5, v.pivot ?? v.target); break;
    case "pan": v.panBy(dx, dy); break;
    case "zoom": v.zoomAt(Math.exp(dy * 0.01), d.start); break;
    case "roll": v.roll(dx * 0.5); break;
    case "box": cam.drawBox(v.boxEl, d.start, p); break;
    case "pole": {
      const pl = d.pole!;
      const r = v.renderer.domElement.getBoundingClientRect();
      v.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
      const hit = new THREE.Vector3();
      if (!v.ray.ray.intersectPlane(pl.plane, hit)) break;
      const delta = hit.sub(pl.start);
      if (v.poleAxis !== "free") {
        const ax = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) }[v.poleAxis];
        delta.copy(ax.multiplyScalar(delta.dot(ax)));
      }
      pl.delta.copy(delta);
      v.drawPoles({ k: pl.k, p: pl.start.clone().add(delta) });
      break;
    }
    case "gesture": {
      d.path.push(p);
      cam.drawGesture(v.gestureEl, d.path);
      v.onGestureTrack(cam.gestureDir(d.start, p), [e.clientX, e.clientY]);
      break;
    }
  }
}

export function onUp(v: MouseHost, s: MouseState, e: PointerEvent) {
  const d = s.drag;
  s.drag = null;
  if (!d) return;
  const p = v.local(e);
  if (d.button === 1) {
    const now = performance.now();
    if (!d.moved) {
      if (now - s.lastMiddleUp < 350) { v.fit(v.lastResult); s.lastMiddleUp = 0; return; }
      s.lastMiddleUp = now;
      // clique no meio sobre a geometria: centro de rotação nesse ponto
      const h = v.hitTest(e, null);
      v.setPivot(h ? h.point : null);
    }
    v.publish();
    return;
  }
  if (d.button === 2) {
    v.gestureEl.replaceChildren();
    v.onGestureTrack(null, null);
    const dir = cam.gestureDir(d.start, p);
    if (d.moved && dir) v.onGesture(dir);
    else {
      const h = v.hitTest(e, null);
      v.onContextMenu([e.clientX, e.clientY], h ? v.toPick(h) : null);
    }
    return;
  }
  if (d.button !== 0) return;
  if (d.mode === "pole" && d.pole && v.poleNet) {
    const nv = v.poleNet.nv;
    const i = Math.floor(d.pole.k / nv), j = d.pole.k % nv;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    if (d.moved) v.onPoleMoved(i, j, [r3(d.pole.delta.x), r3(d.pole.delta.y), r3(d.pole.delta.z)]);
    else v.onPoleSelect(i, j);
    return;
  }
  if (d.mode === "box") {
    v.boxEl.style.display = "none";
    if (d.moved) { v.onBoxSelect(v.boxSelect(d.start, p), d.ctrl || d.shift); return; }
    v.onEmptyClick();
    return;
  }
  if (d.moved) return;
  const h = v.hitTest(e);
  if (!h) { v.onEmptyClick(); return; }
  v.onPick(v.toPick(h), e.ctrlKey || e.shiftKey || e.metaKey, [e.clientX, e.clientY]);
}

export function onDblClick(v: MouseHost, e: MouseEvent) {
  if (e.button !== 0) return;
  const h = v.hitTest(e, null);
  if (h) {
    const pick = v.toPick(h);
    v.el.dataset.lastDblClick = pick.kind === "face" || pick.kind === "edge" ? `${pick.kind}:${pick.name}` : pick.kind;
    v.onDoubleClick(pick);
  }
}

export function onWheel(v: MouseHost, s: MouseState, e: WheelEvent) {
  v.finishAnim();
  e.preventDefault();
  // uma sequência de roda conta como uma só mudança de vista no histórico
  if (performance.now() - s.wheelAt > 500) v.pushHistory();
  s.wheelAt = performance.now();
  // SolidWorks: roda para a frente (deltaY < 0) afasta; "reverseWheel" inverte
  let f = Math.exp(-e.deltaY * 0.0015);
  if (v.settings.reverseWheel) f = 1 / f;
  v.zoomAt(f, v.local(e));
}
