// Modelo de documento: superfícies avançadas ao estilo do CATIA GSD (Fase 4).
import type { Expr, PlaneRef, TopoRef, Vec3 } from "./types-base.ts";
import type { Continuity, CurveRef } from "./types-surface.ts";

// ---------------------------------------------------------------------------
// Fase 4: superfícies ao estilo do CATIA GSD
// ---------------------------------------------------------------------------

/** Tangência de um extremo de uma multi-secção a uma face de suporte (que contém a secção). */
export interface SectionTangent {
  face: TopoRef;
  /** Tensão (1 = normal). */
  weight?: Expr;
  flip?: boolean;
}

/**
 * Superfície multi-secção: secções por ordem, guias opcionais (a superfície passa exatamente por
 * secções e guias — superfície de Gordon), spine opcional (orienta as secções intermédias) e
 * tangência às faces de suporte na primeira e na última secção.
 */
export interface MultiSectionFeature {
  type: "multiSection";
  sections: CurveRef[];
  guides?: CurveRef[];
  spine?: CurveRef;
  startTangent?: SectionTangent;
  endTangent?: SectionTangent;
}

/** Um dos lados de uma concordância: curva, face de suporte, continuidade e tensão. */
export interface BlendSide {
  curve: CurveRef;
  /** Face de suporte (por defeito, a face da aresta, se for aresta livre). */
  support?: TopoRef;
  continuity: Continuity;
  tension?: Expr;
  /** Inverte o sentido de saída da face de suporte. */
  flip?: boolean;
}

/** Concordância (blend) entre duas curvas, com contacto/tangência/curvatura às faces de suporte. */
export interface BlendFeature {
  type: "blend";
  side1: BlendSide;
  side2: BlendSide;
}

/** Varrimento circular: por 3 guias, por 2 guias e raio, ou tubo em torno de uma curva central. */
export interface CircleSweepFeature {
  type: "circleSweep";
  mode: "threeGuides" | "twoGuidesRadius" | "centerRadius";
  guides: CurveRef[];
  radius?: Expr;
  /** Duas guias e raio: o outro centro possível e/ou o arco maior. */
  flip?: boolean;
  long?: boolean;
}

/** Extrapolar um corpo de superfície a partir de arestas livres, em tangência ou curvatura. */
export interface ExtrapolateFeature {
  type: "extrapolate";
  sheet: string;
  edges: TopoRef[];
  length: Expr;
  continuity: "tangent" | "curvature";
  /** Juntar a extensão ao corpo (por defeito, sim). */
  assemble?: boolean;
}

/** Curar (healing): fecha folgas até à distância indicada, corrige faces e simplifica. */
export interface HealFeature {
  type: "heal";
  sheets: string[];
  distance: Expr;
  /** Ângulo (graus) abaixo do qual uma aresta não tangente é assinalada como "quase tangente". */
  tangency?: Expr;
  simplify?: boolean;
}

/** Deslocamento de um polo de controlo (índices a partir de 0), em mm, no referencial global. */
export interface PoleMove {
  i: number;
  j: number;
  d: Vec3;
}

/**
 * Superfície de forma livre com controlo direto dos polos NURBS: um patch novo num plano (grelha
 * nu × nv de polos) ou uma face existente convertida em B-spline. Os deslocamentos ficam guardados por
 * índice de polo, por isso o patch continua paramétrico (tamanho, plano) por baixo das edições.
 */
export interface FreeformFeature {
  type: "freeform";
  source:
    | { kind: "patch"; plane: PlaneRef; width: Expr; height: Expr; nu: number; nv: number; degree?: number }
    | { kind: "face"; face: TopoRef; nu?: number; nv?: number };
  moves: PoleMove[];
}
