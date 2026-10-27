// Modelo de documento: JSON puro, sem dependências do núcleo geométrico.
// Unidades internas: milímetros e graus.

/** Valor numérico ou expressão (ex.: "L/2", "2*Espessura + 1", "30 deg"). */
export type Expr = number | string;

export interface Variable {
  name: string;
  expr: string;
  comment?: string;
}

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// Referências
// ---------------------------------------------------------------------------

/** Pista geométrica guardada no momento da seleção, usada só como recurso quando o nome deixa de existir. */
export interface GeoHint {
  c: Vec3; // centroide
  n?: Vec3; // normal (faces planas) ou direção (arestas retas)
}

/** Referência persistente a uma face ou aresta, pelo nome topológico gerado pelo histórico. */
export interface TopoRef {
  kind: "face" | "edge";
  name: string;
  hint?: GeoHint;
}

export type StdPlane = "XY" | "XZ" | "YZ";
export type StdAxis = "X" | "Y" | "Z";

export type PlaneRef =
  | { kind: "std"; name: StdPlane }
  | { kind: "datum"; feature: string } // plano de referência
  | { kind: "csys"; feature: string; name: StdPlane } // plano de um sistema de coordenadas
  | { kind: "face"; ref: TopoRef }; // face plana do modelo

export type AxisRef =
  | { kind: "std"; name: StdAxis }
  | { kind: "datum"; feature: string } // eixo de referência
  | { kind: "csys"; feature: string; name: StdAxis }
  | { kind: "edge"; ref: TopoRef } // aresta reta ou circular (eixo do círculo)
  | { kind: "sketchLine"; sketch: string; entity: string }; // linha de um esboço (normalmente de construção)

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

export interface SweepFeature {
  type: "sweep";
  profile: string; // esboço com perfil fechado
  path: string; // esboço com caminho aberto ou fechado
  op: BodyOp;
  /** "frenet": o perfil segue a curvatura; "fixed": orientação constante. */
  orientation?: "frenet" | "fixed";
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

// ---------------------------------------------------------------------------
// Superfícies (corpos de superfície, identificados pelo id da feature que os criou)
// ---------------------------------------------------------------------------

export type Continuity = "contact" | "tangent" | "curvature";

/** Superfície extrudida a partir das cadeias (abertas ou fechadas) de um esboço. */
export interface SurfaceExtrudeFeature {
  type: "surfaceExtrude";
  sketch: string;
  end: { type: "blind"; depth: Expr } | { type: "midplane"; depth: Expr };
  flip?: boolean;
}

export interface SurfaceRevolveFeature {
  type: "surfaceRevolve";
  sketch: string;
  axis: AxisRef;
  angle: Expr;
  midplane?: boolean;
}

export interface SurfaceSweepFeature {
  type: "surfaceSweep";
  profile: string;
  path: string;
  orientation?: "frenet" | "fixed";
}

export interface SurfaceLoftFeature {
  type: "surfaceLoft";
  sections: string[];
  ruled?: boolean;
}

/** Preenchimento N-lados de um contorno de arestas, com continuidade às faces vizinhas. */
export interface FillFeature {
  type: "fill";
  edges: TopoRef[];
  continuity: Continuity;
}

export interface OffsetSurfaceFeature {
  type: "offsetSurface";
  faces: TopoRef[];
  distance: Expr;
}

/** Costurar superfícies num só corpo de superfície (ou num sólido, se fechar). */
export interface KnitFeature {
  type: "knit";
  sheets: string[];
  makeSolid?: boolean;
  op?: BodyOp;
  tolerance?: Expr;
}

/** Dar espessura a um corpo de superfície (superfície → sólido). */
export interface ThickenFeature {
  type: "thicken";
  sheet: string;
  thickness: Expr;
  side: "front" | "back" | "both";
  op: BodyOp;
}

/** Aparar um corpo de superfície por um plano, outro corpo de superfície ou um esboço; ficam as partes indicadas. */
export interface TrimSurfaceFeature {
  type: "trimSurface";
  sheet: string;
  tool: { kind: "plane"; plane: PlaneRef } | { kind: "sheet"; sheet: string } | { kind: "sketch"; sketch: string };
  /** Pontos (3D) nas partes a manter. */
  keep: Vec3[];
}

/** Apagar faces de um sólido: o resultado passa a corpo de superfície (para reconstruir com superfícies). */
export interface DeleteFaceFeature {
  type: "deleteFace";
  faces: TopoRef[];
}


export type FeatureData =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | HoleFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | DraftFeature
  | RibFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature
  | PlaneFeature
  | AxisFeature
  | CsysFeature
  | ImportFeature
  | PluginFeature
  | SurfaceExtrudeFeature
  | SurfaceRevolveFeature
  | SurfaceSweepFeature
  | SurfaceLoftFeature
  | FillFeature
  | OffsetSurfaceFeature
  | KnitFeature
  | ThickenFeature
  | TrimSurfaceFeature
  | DeleteFaceFeature;

export type FeatureType = FeatureData["type"];

export type Feature = FeatureData & {
  id: string;
  name: string;
  suppressed?: boolean;
};

export type FeatureOf<T extends FeatureType> = Extract<Feature, { type: T }>;

export interface CadDocument {
  format: "cadp";
  version: 1;
  name: string;
  units: "mm";
  variables: Variable[];
  features: Feature[];
  /** Índice da barra de rollback: só as features antes deste índice são reconstruídas. Omitido = todas. */
  rollback?: number;
}
