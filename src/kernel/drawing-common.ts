// Desenhos: tipos e auxiliares partilhados (fonte de uma vista, referenciais normalizados, projeção 2D, vista falhada).
import { type StdView } from "../doc/project.ts";
import { type Vec3 } from "../doc/types.ts";
import { type ViewFrame, type ViewResult } from "./protocol.ts";
import { type TopoDS_Shape, v3 } from "./occ.ts";
import { type SketchResult } from "./context.ts";
import { type PmiItem } from "../doc/pmi.ts";
import { type PmiState } from "./pmi.ts";

export type P = [number, number];

/** Fonte de uma vista: forma em coordenadas da montagem/peça e arestas nomeadas (pontos 3D). */
export interface Source {
  shape: TopoDS_Shape;
  edges: { name: string; pts: Vec3[]; type: string; component?: string }[];
  sketches: { id: string; s: SketchResult; constraints: { id: string; type: string; refs: string[] }[] }[];
  volume: number;
  material?: string;
  /** PMI 3D da peça (vistas de peças; as montagens não têm PMI próprio). */
  pmi?: { item: PmiItem; state: PmiState }[];
}

export const STD_VIEWS: Record<Exclude<StdView, "iso">, ViewFrame> = {
  front: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  back: { o: [0, 0, 0], x: [-1, 0, 0], y: [0, 0, 1], z: [0, 1, 0] },
  top: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  bottom: { o: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
  right: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
  left: { o: [0, 0, 0], x: [0, -1, 0], y: [0, 0, 1], z: [-1, 0, 0] },
};

export function stdFrame(v: StdView): ViewFrame {
  if (v !== "iso") return STD_VIEWS[v];
  const z = v3.norm([1, -1, 1]);
  const y = v3.norm(v3.sub([0, 0, 1], v3.mul(z, v3.dot([0, 0, 1], z))));
  return { o: [0, 0, 0], x: v3.cross(y, z), y, z };
}

/**
 * Vista projetada: o lado em que fica na folha e o método de projeção dizem de onde se olha.
 * 1.º diedro (ISO): a vista colocada à direita é a vista da esquerda; em cima, a vista de baixo.
 */
export function projectedFrame(P: ViewFrame, side: "right" | "left" | "above" | "below", method: "first" | "third"): ViewFrame {
  const from = method === "third" ? side : ({ right: "left", left: "right", above: "below", below: "above" } as const)[side];
  const n = (a: Vec3) => v3.mul(a, -1);
  switch (from) {
    case "right": return { o: P.o, x: n(P.z), y: P.y, z: P.x };
    case "left": return { o: P.o, x: P.z, y: P.y, z: n(P.x) };
    case "above": return { o: P.o, x: P.x, y: n(P.z), z: P.y };
    case "below": return { o: P.o, x: P.x, y: P.z, z: n(P.y) };
  }
}

export const proj = (f: ViewFrame, p: Vec3): P => { const d = v3.sub(p, f.o); return [v3.dot(d, f.x), v3.dot(d, f.y)]; };
export const unproj = (f: ViewFrame, q: P): Vec3 => v3.add(f.o, v3.add(v3.mul(f.x, q[0]), v3.mul(f.y, q[1])));

export function failed(error: string): ViewResult {
  return { ok: false, error, frame: STD_VIEWS.front, scale: 1, bbox: [0, 0, 0, 0], visible: [], hidden: [], tangent: [], hatch: [], centerMarks: [], centerLines: [], edges: {}, modelDims: [] };
}
