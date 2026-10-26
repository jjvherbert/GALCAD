// Geometria 2D do esboço: entidades implícitas, medições e amostragem de curvas.
import type { SketchConstraint, SketchEntity, SketchFeature } from "../doc/types.ts";

export type P2 = [number, number];

/** Entidades implícitas, sempre presentes e fixas: origem e eixos do esboço. */
export const ORIGIN = "O";
export const AXIS_H = "H";
export const AXIS_V = "V";
export const IMPLICIT: Record<string, SketchEntity> = {
  [ORIGIN]: { type: "point", x: 0, y: 0, fixed: true, construction: true },
  _hx: { type: "point", x: 1, y: 0, fixed: true, construction: true },
  _vy: { type: "point", x: 0, y: 1, fixed: true, construction: true },
  [AXIS_H]: { type: "line", p1: ORIGIN, p2: "_hx", construction: true },
  [AXIS_V]: { type: "line", p1: ORIGIN, p2: "_vy", construction: true },
};
export const isImplicit = (id: string) => id in IMPLICIT;

export const allEntities = (s: Pick<SketchFeature, "entities">): Record<string, SketchEntity> => ({ ...IMPLICIT, ...s.entities });

export function pt(ents: Record<string, SketchEntity>, id: string): P2 {
  const e = ents[id];
  if (!e || e.type !== "point") throw new Error(`Ponto inexistente: ${id}`);
  return [e.x, e.y];
}

export const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
export const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: P2) => Math.hypot(a[0], a[1]);
export const dist = (a: P2, b: P2) => len(sub(a, b));
const DEG = 180 / Math.PI;

/** Pontos de que uma entidade depende. */
export function entityPoints(e: SketchEntity): string[] {
  switch (e.type) {
    case "point": return [];
    case "line": return [e.p1, e.p2];
    case "circle": return [e.c];
    case "arc": return [e.c, e.s, e.e];
    case "spline": return e.pts;
  }
}

/** Distância de um ponto à reta infinita de uma linha. */
export function pointLineDistance(p: P2, a: P2, b: P2): number {
  const d = sub(b, a);
  const L = len(d);
  return L < 1e-12 ? dist(p, a) : Math.abs(cross(d, sub(p, a))) / L;
}

/** Ângulo com sinal de l1 para l2, em graus, em (-180, 180]. */
export function lineAngle(ents: Record<string, SketchEntity>, l1: string, l2: string): number {
  const dir = (id: string) => {
    const l = ents[id];
    if (l?.type !== "line") throw new Error("Ângulo: as referências têm de ser linhas");
    return sub(pt(ents, l.p2), pt(ents, l.p1));
  };
  const a = dir(l1), b = dir(l2);
  return Math.atan2(cross(a, b), dot(a, b)) * DEG;
}

/** Valor atual de uma cota, medido na geometria. */
export function measure(ents: Record<string, SketchEntity>, c: Pick<SketchConstraint, "type" | "refs">): number {
  const [a, b] = c.refs;
  const ea = ents[a], eb = ents[b];
  switch (c.type) {
    case "distance":
      if (ea?.type === "line" && !b) return dist(pt(ents, ea.p1), pt(ents, ea.p2));
      if (ea?.type === "point" && eb?.type === "point") return dist(pt(ents, a), pt(ents, b));
      if (ea?.type === "point" && eb?.type === "line") return pointLineDistance(pt(ents, a), pt(ents, eb.p1), pt(ents, eb.p2));
      if (ea?.type === "line" && eb?.type === "point") return pointLineDistance(pt(ents, b), pt(ents, ea.p1), pt(ents, ea.p2));
      throw new Error("Distância: referências não suportadas");
    case "distanceX": return pt(ents, b)[0] - pt(ents, a)[0];
    case "distanceY": return pt(ents, b)[1] - pt(ents, a)[1];
    case "radius":
    case "diameter": {
      if (ea?.type !== "circle" && ea?.type !== "arc") throw new Error("Raio: a referência tem de ser um círculo ou arco");
      return c.type === "radius" ? ea.r : 2 * ea.r;
    }
    case "angle": return lineAngle(ents, a, b);
    default: throw new Error(`"${c.type}" não é uma cota`);
  }
}

// ---------------------------------------------------------------------------
// Curvas
// ---------------------------------------------------------------------------

export type Bezier = [P2, P2, P2, P2];

/** Spline Catmull-Rom uniforme pelos pontos, convertida em Bézier cúbicas (C1). */
export function splineBeziers(points: P2[]): Bezier[] {
  const n = points.length;
  if (n < 2) return [];
  const tan = points.map((p, i) => {
    if (n === 2) return sub(points[1], points[0]);
    if (i === 0) return sub(points[1], points[0]);
    if (i === n - 1) return sub(points[n - 1], points[n - 2]);
    return mul(sub(points[i + 1], points[i - 1]), 0.5);
  });
  const out: Bezier[] = [];
  for (let i = 0; i < n - 1; i++) {
    out.push([points[i], add(points[i], mul(tan[i], 1 / 3)), sub(points[i + 1], mul(tan[i + 1], 1 / 3)), points[i + 1]]);
  }
  return out;
}

export function bezierAt([p0, p1, p2, p3]: Bezier, t: number): P2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** Ângulo de varrimento CCW de a0 para a1, em (0, 2π]. */
export function arcSweep(a0: number, a1: number): number {
  let s = (a1 - a0) % (2 * Math.PI);
  if (s <= 1e-12) s += 2 * Math.PI;
  return s;
}

/** Amostra uma entidade curva como polilinha (para desenho e testes geométricos). */
export function sampleEntity(ents: Record<string, SketchEntity>, id: string, segs = 32): P2[] {
  const e = ents[id];
  switch (e.type) {
    case "point": return [[e.x, e.y]];
    case "line": return [pt(ents, e.p1), pt(ents, e.p2)];
    case "circle": {
      const c = pt(ents, e.c);
      return Array.from({ length: segs + 1 }, (_, i) => {
        const a = (2 * Math.PI * i) / segs;
        return [c[0] + e.r * Math.cos(a), c[1] + e.r * Math.sin(a)] as P2;
      });
    }
    case "arc": {
      const c = pt(ents, e.c);
      const sw = arcSweep(e.a0, e.a1);
      const n = Math.max(4, Math.ceil((segs * sw) / (2 * Math.PI)));
      return Array.from({ length: n + 1 }, (_, i) => {
        const a = e.a0 + (sw * i) / n;
        return [c[0] + e.r * Math.cos(a), c[1] + e.r * Math.sin(a)] as P2;
      });
    }
    case "spline": {
      const out: P2[] = [];
      for (const bz of splineBeziers(e.pts.map((p) => pt(ents, p)))) {
        for (let i = out.length ? 1 : 0; i <= 12; i++) out.push(bezierAt(bz, i / 12));
      }
      return out;
    }
  }
}
