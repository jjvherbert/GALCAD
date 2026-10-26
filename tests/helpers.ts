// Utilitários de teste: inicialização do núcleo em Node e construção rápida de esboços.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { initSolver } from "../src/sketch/solver.ts";
import type { PlaneRef, SketchConstraint, SketchEntity, SketchFeature } from "../src/doc/types.ts";

let ready: Promise<void> | null = null;
export function initKernel(): Promise<void> {
  ready ??= (async () => {
    setOC(await (opencascade as unknown as () => Promise<never>)());
    await initSolver();
  })();
  return ready;
}

/** Construtor de esboços com ids legíveis. */
export class SketchBuilder {
  entities: Record<string, SketchEntity> = {};
  constraints: SketchConstraint[] = [];
  private n = 0;
  private plane: PlaneRef;
  constructor(plane: PlaneRef = { kind: "std", name: "XY" }) {
    this.plane = plane;
  }
  private id(p: string) { return `${p}${++this.n}`; }
  point(x: number, y: number, extra: Partial<Extract<SketchEntity, { type: "point" }>> = {}) {
    const id = this.id("p");
    this.entities[id] = { type: "point", x, y, ...extra };
    return id;
  }
  line(a: string, b: string, construction = false) {
    const id = this.id("l");
    this.entities[id] = { type: "line", p1: a, p2: b, construction };
    return id;
  }
  circle(x: number, y: number, r: number) {
    const c = this.point(x, y);
    const id = this.id("c");
    this.entities[id] = { type: "circle", c, r };
    return id;
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number) {
    const c = this.point(cx, cy);
    const s = this.point(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    const e = this.point(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
    const id = this.id("a");
    this.entities[id] = { type: "arc", c, s, e, r, a0, a1 };
    return { id, c, s, e };
  }
  constrain(type: SketchConstraint["type"], refs: string[], value?: number | string) {
    const id = this.id("k");
    this.constraints.push({ id, type, refs, value });
    return id;
  }
  /** Retângulo de x0,y0 com w×h, totalmente definido (cotas w e h, canto fixado em x0,y0). */
  rect(x0: number, y0: number, w: number | string, h: number | string, wv = 10, hv = 10) {
    const a = this.point(x0, y0), b = this.point(x0 + wv, y0), c = this.point(x0 + wv, y0 + hv), d = this.point(x0, y0 + hv);
    const l = [this.line(a, b), this.line(b, c), this.line(c, d), this.line(d, a)];
    for (const [i, t] of [[0, "horizontal"], [2, "horizontal"], [1, "vertical"], [3, "vertical"]] as const) this.constrain(t, [l[i]]);
    this.constrain("distance", [l[0]], w);
    this.constrain("distance", [l[1]], h);
    if (x0 === 0 && y0 === 0) this.constrain("coincident", [a, "O"]);
    else { this.constrain("distanceX", ["O", a], x0); this.constrain("distanceY", ["O", a], y0); }
    return { pts: [a, b, c, d], lines: l };
  }
  build(): Omit<SketchFeature, "type"> & { type: "sketch" } {
    return { type: "sketch", plane: this.plane, entities: this.entities, constraints: this.constraints };
  }
}
