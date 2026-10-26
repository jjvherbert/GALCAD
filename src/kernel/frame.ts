// Referenciais 3D: planos de esboço, planos e eixos de referência.
import type { StdAxis, StdPlane, Vec3 } from "../doc/types.ts";
import { v3 } from "./occ.ts";

/** Referencial ortonormado: origem, eixos x/y no plano e normal z = x × y. */
export interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export interface Axis {
  o: Vec3;
  d: Vec3;
}

export const STD_FRAMES: Record<StdPlane, Frame> = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
};

export const STD_AXES: Record<StdAxis, Axis> = {
  X: { o: [0, 0, 0], d: [1, 0, 0] },
  Y: { o: [0, 0, 0], d: [0, 1, 0] },
  Z: { o: [0, 0, 0], d: [0, 0, 1] },
};

export const to3D = (f: Frame, p: [number, number]): Vec3 => v3.add(f.o, v3.add(v3.mul(f.x, p[0]), v3.mul(f.y, p[1])));
export const to2D = (f: Frame, p: Vec3): [number, number] => { const d = v3.sub(p, f.o); return [v3.dot(d, f.x), v3.dot(d, f.y)]; };

/** Referencial de um plano dado por origem e normal: x = projeção do X global (ou Y, se paralelo). */
export function frameFromPlane(origin: Vec3, normal: Vec3): Frame {
  const z = v3.norm(normal);
  // origem: projeção da origem global no plano (estável quando a face muda de tamanho)
  const o = v3.sub([0, 0, 0], v3.mul(z, v3.dot(v3.sub([0, 0, 0], origin), z)));
  const ref: Vec3 = Math.abs(v3.dot(z, [1, 0, 0])) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = v3.norm(v3.sub(ref, v3.mul(z, v3.dot(ref, z))));
  return { o, x, y: v3.cross(z, x), z };
}

/** Roda um vetor em torno de um eixo unitário (fórmula de Rodrigues). */
export function rotateVec(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const k = v3.norm(axis);
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return v3.add(v3.add(v3.mul(v, c), v3.mul(v3.cross(k, v), s)), v3.mul(k, v3.dot(k, v) * (1 - c)));
}

export function rotatePoint(p: Vec3, axis: Axis, angleRad: number): Vec3 {
  return v3.add(axis.o, rotateVec(v3.sub(p, axis.o), axis.d, angleRad));
}

export function rotateFrame(f: Frame, axis: Axis, angleRad: number): Frame {
  return {
    o: rotatePoint(f.o, axis, angleRad),
    x: rotateVec(f.x, axis.d, angleRad),
    y: rotateVec(f.y, axis.d, angleRad),
    z: rotateVec(f.z, axis.d, angleRad),
  };
}

export const offsetFrame = (f: Frame, d: number): Frame => ({ ...f, o: v3.add(f.o, v3.mul(f.z, d)) });
export const flipFrame = (f: Frame): Frame => ({ o: f.o, x: f.x, y: v3.mul(f.y, -1), z: v3.mul(f.z, -1) });

/** Interseção de dois planos (eixo). */
export function planesIntersection(a: Frame, b: Frame): Axis {
  const d = v3.cross(a.z, b.z);
  if (v3.len(d) < 1e-9) throw new Error("Os planos são paralelos");
  // ponto comum: resolver n1·p = d1, n2·p = d2 com p no plano perpendicular a d pela origem
  const d1 = v3.dot(a.z, a.o), d2 = v3.dot(b.z, b.o);
  const n1n2 = v3.dot(a.z, b.z);
  const det = 1 - n1n2 * n1n2;
  const c1 = (d1 - d2 * n1n2) / det, c2 = (d2 - d1 * n1n2) / det;
  return { o: v3.add(v3.mul(a.z, c1), v3.mul(b.z, c2)), d: v3.norm(d) };
}

/** Referencial a partir de origem e rotações sucessivas em X, Y, Z (graus). */
export function frameFromEuler(o: Vec3, rx: number, ry: number, rz: number): Frame {
  const D = Math.PI / 180;
  let f: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  for (const [ax, a] of [[[1, 0, 0], rx], [[0, 1, 0], ry], [[0, 0, 1], rz]] as [Vec3, number][]) {
    f = rotateFrame(f, { o: [0, 0, 0], d: ax }, a * D);
  }
  return { ...f, o };
}

/** Planos de um sistema de coordenadas. */
export function csysPlane(f: Frame, name: StdPlane): Frame {
  if (name === "XY") return f;
  if (name === "XZ") return { o: f.o, x: f.x, y: f.z, z: v3.mul(f.y, -1) };
  return { o: f.o, x: f.y, y: f.z, z: f.x };
}

export function csysAxis(f: Frame, name: StdAxis): Axis {
  return { o: f.o, d: name === "X" ? f.x : name === "Y" ? f.y : f.z };
}
