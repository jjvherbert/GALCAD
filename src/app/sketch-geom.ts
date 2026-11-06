// Geometria auxiliar do editor de esboço 2D.
import type { SketchEntity } from "../doc/types.ts";
import { type P2, pt } from "../sketch/geometry.ts";

/** Circunferência por três pontos. */
export function circleThrough(a: P2, b: P2, c: P2): { c: P2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

export function segDist(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function projectOn(ents: Record<string, SketchEntity>, id: string, p: P2): P2 {
  const e = ents[id];
  if (e.type === "line") {
    const a = pt(ents, e.p1), b = pt(ents, e.p2);
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    return [a[0] + t * dx, a[1] + t * dy];
  }
  if (e.type === "circle" || e.type === "arc") {
    const c = pt(ents, e.c);
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    return [c[0] + e.r * Math.cos(a), c[1] + e.r * Math.sin(a)];
  }
  return p;
}
