// Modelo de documento: features de sólidos.
import type { AxisRef, Expr, PlaneRef, TopoRef, Vec3 } from "./types-base.ts";
import type { SweepOptions } from "./types-surface.ts";

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * Região escolhida de um esboço (como "contornos selecionados" no SolidWorks): identificada pelas
 * entidades que a delimitam (estável quando as cotas mudam) e por um ponto interior (recurso).
 */
export interface RegionRef {
  sig: string[];
  seed: [number, number];
}

/** Operação booleana com o corpo existente. "new" junta sem fundir (corpo separado). */
export type BodyOp = "add" | "cut" | "intersect" | "new";

export type EndCondition =
  | { type: "blind"; depth: Expr }
  | { type: "midplane"; depth: Expr } // simétrico em relação ao plano do esboço
  | { type: "throughAll" }
  | { type: "upToFace"; face: TopoRef; offset?: Expr };

export interface ExtrudeFeature {
  type: "extrude";
  sketch: string;
  /** Regiões a usar; omitido = todos os contornos fechados. */
  regions?: RegionRef[];
  op: BodyOp;
  end: EndCondition;
  /** Segunda direção (sentido oposto), opcional. */
  end2?: EndCondition;
  flip?: boolean;
  /** Ângulo de saída (graus), aplicado às faces laterais. */
  draft?: Expr;
}

export interface RevolveFeature {
  type: "revolve";
  sketch: string;
  regions?: RegionRef[];
  axis: AxisRef;
  op: BodyOp;
  angle: Expr;
  midplane?: boolean;
  flip?: boolean;
}

export interface SweepFeature extends SweepOptions {
  type: "sweep";
  profile: string; // esboço com perfil fechado
  path: string; // esboço com caminho aberto ou fechado (ou curva 3D)
  op: BodyOp;
}

export interface LoftFeature {
  type: "loft";
  sections: string[]; // esboços, por ordem
  op: BodyOp;
  ruled?: boolean;
}

export type HoleKind = "simple" | "clearance" | "tapped";
export type HoleHead = "none" | "counterbore" | "countersink";

export interface HoleFeature {
  type: "hole";
  /** Esboço com os pontos de centro dos furos (pontos que não são de construção nem extremos de outras entidades). */
  sketch: string;
  kind: HoleKind;
  /** Rosca métrica ISO (ex.: "M6") para furos de passagem e roscados. */
  size?: string;
  /** Furo simples: diâmetro. */
  diameter?: Expr;
  /** Furo de passagem: ajuste ISO 273. */
  fit?: "close" | "normal" | "loose";
  head?: HoleHead;
  headDiameter?: Expr;
  headDepth?: Expr; // rebaixo
  headAngle?: Expr; // escareado (graus)
  end: { type: "blind"; depth: Expr } | { type: "throughAll" };
  /** Ponta cónica do furo cego (graus); 0 = fundo plano. */
  tipAngle?: Expr;
  /** Comprimento roscado (furos roscados cegos). Rosca cosmética: só metadados. */
  threadDepth?: Expr;
  flip?: boolean;
}

export interface FilletFeature {
  type: "fillet";
  /** Arestas; uma face seleciona todas as suas arestas. */
  refs: TopoRef[];
  radius: Expr;
}

export interface ChamferFeature {
  type: "chamfer";
  refs: TopoRef[];
  distance: Expr;
  /** Segunda distância (chanfro assimétrico); omitida = igual. */
  distance2?: Expr;
}

export interface ShellFeature {
  type: "shell";
  /** Faces removidas (abertas). */
  faces: TopoRef[];
  thickness: Expr;
  outward?: boolean;
}

export interface DraftFeature {
  type: "draft";
  faces: TopoRef[];
  neutral: PlaneRef;
  angle: Expr;
  flip?: boolean;
}

export interface RibFeature {
  type: "rib";
  /** Esboço com contorno aberto. */
  sketch: string;
  thickness: Expr;
  /** Inverte o lado do material (em direção ao corpo). */
  flip?: boolean;
}

export interface LinearPatternFeature {
  type: "linearPattern";
  /** Features a repetir (extrusão, revolução, sweep, loft, furo, nervura) ou vazio para repetir o corpo. */
  features: string[];
  direction: AxisRef;
  count: Expr;
  spacing: Expr;
  flip?: boolean;
  direction2?: AxisRef;
  count2?: Expr;
  spacing2?: Expr;
  flip2?: boolean;
}

export interface CircularPatternFeature {
  type: "circularPattern";
  features: string[];
  axis: AxisRef;
  count: Expr;
  /** Ângulo total (graus) distribuído pelas instâncias. 360 = volta completa. */
  angle: Expr;
}

export interface MirrorFeature {
  type: "mirror";
  /** Features a espelhar, ou vazio para espelhar o corpo inteiro. */
  features: string[];
  plane: PlaneRef;
}

export interface PlaneFeature {
  type: "plane";
  base: PlaneRef;
  offset: Expr;
  /** Rotação (graus) em torno de um eixo contido no plano base. */
  angle?: Expr;
  axis?: AxisRef;
  flip?: boolean;
}

export interface AxisFeature {
  type: "axis";
  mode: "twoPlanes" | "edge" | "twoPoints";
  planes?: [PlaneRef, PlaneRef];
  edge?: TopoRef;
  points?: [Vec3, Vec3];
}

export interface CsysFeature {
  type: "csys";
  origin: [Expr, Expr, Expr];
  /** Rotações sucessivas em torno de X, Y, Z (graus). */
  rotation: [Expr, Expr, Expr];
}

export interface ImportFeature {
  type: "import";
  format: "step";
  fileName: string;
  /** Conteúdo do ficheiro (texto STEP). */
  data: string;
  op: BodyOp;
}

export interface PluginFeature {
  type: "plugin";
  plugin: string;
  kind: string;
  params: Record<string, Expr>;
  op: BodyOp;
}
