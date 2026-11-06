// Modelo de documento: esboço (entidades, restrições, feature de esboço).
import type { Expr, PlaneRef, TopoRef } from "./types-base.ts";

// ---------------------------------------------------------------------------
// Esboço
// ---------------------------------------------------------------------------

/**
 * Entidades de esboço. `ext`: entidade convertida de uma aresta do modelo ("converter entidades");
 * a geometria é recalculada pelo núcleo a cada reconstrução, por projeção da aresta no plano do esboço,
 * e os seus pontos ficam fixos para o solver.
 */
export type SketchEntity =
  | { type: "point"; x: number; y: number; construction?: boolean; fixed?: boolean }
  | { type: "line"; p1: string; p2: string; construction?: boolean; ext?: TopoRef }
  | { type: "circle"; c: string; r: number; construction?: boolean; ext?: TopoRef }
  /** Arco no sentido anti-horário de s para e, centro c. */
  | { type: "arc"; c: string; s: string; e: string; r: number; a0: number; a1: number; construction?: boolean; ext?: TopoRef }
  /** Spline interpolada que passa pelos pontos (Catmull-Rom → Bézier cúbicas, continuidade C1). */
  | { type: "spline"; pts: string[]; construction?: boolean };

export type SketchEntityType = SketchEntity["type"];

/** Restrições geométricas (sem valor) e cotas (com valor). */
export type ConstraintType =
  | "coincident" // [ponto, ponto]
  | "pointOn" // [ponto, linha|círculo|arco]
  | "midpoint" // [ponto, linha]
  | "horizontal" // [linha] ou [ponto, ponto]
  | "vertical" // [linha] ou [ponto, ponto]
  | "parallel" // [linha, linha]
  | "perpendicular" // [linha, linha]
  | "collinear" // [linha, linha]
  | "tangent" // [linha|círculo|arco, círculo|arco]
  | "equal" // [linha, linha] ou [círculo|arco, círculo|arco]
  | "concentric" // [círculo|arco, círculo|arco]
  | "symmetric" // [ponto, ponto, linha]
  | "fix" // [ponto]
  // cotas
  | "distance" // [ponto, ponto] | [ponto, linha] | [linha] (comprimento)
  | "distanceX" // [ponto, ponto] (horizontal, com sinal: x2 - x1)
  | "distanceY" // [ponto, ponto] (vertical, com sinal: y2 - y1)
  | "radius" // [círculo|arco]
  | "diameter" // [círculo|arco]
  | "angle"; // [linha, linha] (graus, com sinal pelo sentido das linhas)

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  refs: string[];
  value?: Expr;
  /** Cota de referência (medida, não comanda a geometria). */
  driven?: boolean;
  /** Posição da etiqueta da cota no esboço (só apresentação). */
  pos?: [number, number];
}

export const DIMENSION_TYPES: ReadonlySet<ConstraintType> = new Set([
  "distance", "distanceX", "distanceY", "radius", "diameter", "angle",
]);

export interface SketchFeature {
  type: "sketch";
  plane: PlaneRef;
  entities: Record<string, SketchEntity>;
  constraints: SketchConstraint[];
}
