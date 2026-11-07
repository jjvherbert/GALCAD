// Vista 3D: adaptador entre o Viewport e o tratamento do rato (viewport-mouse.ts).
import type * as mouse from "./viewport-mouse.ts";
import type { Viewport } from "./viewport.ts";

/** Adaptador para `viewport-mouse.ts`: getters (é criado antes do construtor atribuir os campos), setas para métodos e callbacks. */
export function mouseHostOf(v: Viewport): mouse.MouseHost {
  return {
    get camera() { return v.camera; },
    get renderer() { return v.renderer; },
    get ray() { return v.ray; },
    get el() { return v.el; },
    get boxEl() { return v.boxEl; },
    get gestureEl() { return v.gestureEl; },
    get target() { return v.target; },
    get settings() { return v.settings; },
    get poleNet() { return v.poleNet; },
    get poleAxis() { return v.poleAxis; },
    get lastResult() { return v.lastResult; },
    get pivot() { return v.pivot; },
    set pivot(p) { v.pivot = p; },
    local: (ev) => v.local(ev),
    hitTest: (ev, accept) => v.hitTest(ev, accept),
    toPick: (h) => v.toPick(h),
    setHover: (h) => v.setHover(h),
    pushHistory: () => v.pushHistory(),
    rotateBy: (x, y, about) => v.rotateBy(x, y, about),
    panBy: (dx, dy) => v.panBy(dx, dy),
    zoomAt: (f, at) => v.zoomAt(f, at),
    roll: (deg) => v.roll(deg),
    drawPoles: (preview) => v.drawPoles(preview),
    fit: (r) => v.fit(r),
    setPivot: (p) => v.setPivot(p),
    publish: () => v.publish(),
    finishAnim: () => v.finishAnim(),
    boxSelect: (p, q) => v.boxSelect(p, q),
    onPick: (p, add, at) => v.onPick(p, add, at),
    onEmptyClick: () => v.onEmptyClick(),
    onContextMenu: (at, pick) => v.onContextMenu(at, pick),
    onGesture: (d) => v.onGesture(d),
    onBoxSelect: (picks, add) => v.onBoxSelect(picks, add),
    onDoubleClick: (pick) => v.onDoubleClick(pick),
    onGestureTrack: (d, at) => v.onGestureTrack(d, at),
    onPoleSelect: (i, j) => v.onPoleSelect(i, j),
    onPoleMoved: (i, j, d) => v.onPoleMoved(i, j, d),
  };
}
