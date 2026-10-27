// Geometria 2D dos desenhos (pura, sem núcleo): curvas, caixas, recortes, tracejado e consultas.
import type { Curve2D } from "../kernel/protocol.ts";

export type P = [number, number];

export const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Ângulo normalizado em [0, 2π). */
export const normAngle = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** Pontos de uma curva (os arcos em segmentos de no máximo ~5°). */
export function curvePoints(c: Curve2D): P[] {
  switch (c.k) {
    case "l": return [c.a, c.b];
    case "p": return c.pts;
    case "c": case "a": {
      const a0 = c.k === "c" ? 0 : c.a0;
      let sweep = c.k === "c" ? 2 * Math.PI : normAngle(c.a1 - c.a0);
      if (c.k === "a" && sweep < 1e-9) sweep = 2 * Math.PI;
      const n = Math.max(4, Math.ceil(sweep / (Math.PI / 36)));
      return Array.from({ length: n + 1 }, (_, i) => { const t = a0 + (sweep * i) / n; return [c.c[0] + c.r * Math.cos(t), c.c[1] + c.r * Math.sin(t)] as P; });
    }
  }
}

export function curvesBBox(cs: Curve2D[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) for (const p of curvePoints(c)) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

export function transformCurve(c: Curve2D, f: (p: P) => P, s: number): Curve2D {
  switch (c.k) {
    case "l": return { k: "l", a: f(c.a), b: f(c.b) };
    case "p": return { k: "p", pts: c.pts.map(f) };
    case "c": return { k: "c", c: f(c.c), r: c.r * s };
    case "a": return { k: "a", c: f(c.c), r: c.r * s, a0: c.a0, a1: c.a1 };
  }
}

/** Distância de um ponto a uma curva. */
export function distToCurve(p: P, c: Curve2D): number {
  if (c.k === "c") return Math.abs(dist(p, c.c) - c.r);
  if (c.k === "a") {
    const ang = normAngle(Math.atan2(p[1] - c.c[1], p[0] - c.c[0]));
    const within = normAngle(ang - c.a0) <= normAngle(c.a1 - c.a0) + 1e-9;
    if (within) return Math.abs(dist(p, c.c) - c.r);
  }
  const pts = curvePoints(c);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSeg(p, pts[i], pts[i + 1]));
  return best;
}

export function distToSeg(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Retira as linhas ocultas que coincidem com linhas visíveis (ex.: a face de trás de um prisma). */
export function dropCoincident(hidden: Curve2D[], visible: Curve2D[], tol: number): Curve2D[] {
  const vb = visible.map((c) => ({ c, b: curvesBBox([c]) }));
  const near = (p: P) => vb.some(({ c, b }) => p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol && distToCurve(p, c) < tol);
  return hidden.filter((h) => {
    const pts = curvePoints(h);
    const samples = pts.length > 2 ? pts : [pts[0], lerp(pts[0], pts[1], 0.25), lerp(pts[0], pts[1], 0.5), lerp(pts[0], pts[1], 0.75), pts[1]];
    return !samples.every(near);
  });
}

/** Recorta uma polilinha por um círculo: devolve as partes dentro. */
export function clipPolylineCircle(pts: P[], c: P, r: number): P[][] {
  const inside = (p: P) => dist(p, c) <= r;
  const out: P[][] = [];
  let cur: P[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    // interseções do segmento com o círculo (parâmetros t ∈ [0, 1])
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const fx = a[0] - c[0], fy = a[1] - c[1];
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    const ts: number[] = [];
    if (A > 0 && disc > 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) if (t > 0 && t < 1) ts.push(t);
    }
    const knots = [0, ...ts.sort((x, y) => x - y), 1];
    for (let k = 0; k < knots.length - 1; k++) {
      const p0 = lerp(a, b, knots[k]), p1 = lerp(a, b, knots[k + 1]);
      if (inside(lerp(p0, p1, 0.5))) {
        if (!cur.length) cur.push(p0);
        cur.push(p1);
      } else if (cur.length) { out.push(cur); cur = []; }
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

export function clipCurvesCircle(cs: Curve2D[], c: P, r: number): Curve2D[] {
  const out: Curve2D[] = [];
  for (const k of cs) {
    if ((k.k === "c" || k.k === "a") && dist(k.c, c) + k.r <= r) { out.push(k); continue; }
    for (const pts of clipPolylineCircle(curvePoints(k), c, r)) out.push(pts.length === 2 ? { k: "l", a: pts[0], b: pts[1] } : { k: "p", pts });
  }
  return out;
}

/**
 * Tracejado de corte (ISO 128-50): linhas a `angle` com espaçamento `spacing`, recortadas pelos
 * triângulos das faces cortadas (x0,y0,x1,y1,x2,y2,…). Devolve segmentos.
 */
export function hatchTriangles(tris: number[], spacing: number, angle = Math.PI / 4): [P, P][] {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  // coordenadas rodadas: u ao longo das linhas, v perpendicular
  const toUV = (x: number, y: number): P => [x * ca + y * sa, -x * sa + y * ca];
  const fromUV = (u: number, v: number): P => [u * ca - v * sa, u * sa + v * ca];
  const segs: [P, P][] = [];
  for (let i = 0; i < tris.length; i += 6) {
    const q = [toUV(tris[i], tris[i + 1]), toUV(tris[i + 2], tris[i + 3]), toUV(tris[i + 4], tris[i + 5])];
    const vmin = Math.min(...q.map((p) => p[1])), vmax = Math.max(...q.map((p) => p[1]));
    for (let v = Math.ceil(vmin / spacing) * spacing; v <= vmax; v += spacing) {
      const us: number[] = [];
      for (let k = 0; k < 3; k++) {
        const a = q[k], b = q[(k + 1) % 3];
        if ((a[1] - v) * (b[1] - v) > 0 || a[1] === b[1]) continue;
        us.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      if (us.length >= 2) {
        const u0 = Math.min(...us), u1 = Math.max(...us);
        if (u1 - u0 > 1e-9) segs.push([fromUV(u0, v), fromUV(u1, v)]);
      }
    }
  }
  return segs;
}

/** Ponto de uma curva usado como âncora. */
export function curveAnchor(c: Curve2D, at: "start" | "end" | "mid" | "center"): P {
  if (at === "center" && (c.k === "c" || c.k === "a")) return c.c;
  const pts = curvePoints(c);
  if (at === "start") return pts[0];
  if (at === "end") return pts[pts.length - 1];
  if (c.k === "l") return lerp(c.a, c.b, 0.5);
  return pts[Math.floor(pts.length / 2)];
}

/** Arco que passa por três pontos (a → m → b), no sentido anti-horário de a0 para a1. */
export function arcThrough(a: P, m: P, b: P): Curve2D | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sq = (p: P) => p[0] * p[0] + p[1] * p[1];
  const c: P = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
  const r = dist(c, a);
  const ang = (p: P) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const t0 = ang(a), tm = ang(m), t1 = ang(b);
  // anti-horário de a para b passa por m?
  const ccw = normAngle(tm - t0) < normAngle(t1 - t0);
  return ccw ? { k: "a", c, r, a0: t0, a1: t1 } : { k: "a", c, r, a0: t1, a1: t0 };
}
