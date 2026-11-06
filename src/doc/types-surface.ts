// Modelo de documento: features de superfícies.
import type { AxisRef, Expr, PlaneRef, TopoRef, Vec3 } from "./types-base.ts";
import type { BodyOp } from "./types-solid.ts";

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

/**
 * Orientação do perfil ao longo do caminho: "frenet" (segue a curvatura), "fixed" (constante),
 * "binormal" (binormal fixa numa direção), "support" (normal das faces de suporte do caminho) ou
 * "guide" (uma curva guia controla a rotação do perfil).
 */
export type SweepOrientation = "frenet" | "fixed" | "binormal" | "support" | "guide";

/** Opções avançadas de varrimento (estilo GSD): orientação, guia e lei de escala. */
export interface SweepOptions {
  orientation?: SweepOrientation;
  binormal?: AxisRef;
  support?: TopoRef[];
  guide?: CurveRef;
  /**
   * Papel da guia: "orient" (só roda o perfil), "contact" (o perfil toca a guia, largura constante)
   * ou "border" (a guia é o bordo da superfície e a largura varia).
   */
  guideMode?: "orient" | "contact" | "border";
  /** Escala do perfil no fim do caminho (1 = constante), com lei linear ou em S. */
  scale?: Expr;
  scaleLaw?: "linear" | "s";
}

export interface SurfaceSweepFeature extends SweepOptions {
  type: "surfaceSweep";
  profile: string;
  path: string;
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
  /** Juntar (estilo GSD): erro se o resultado não ficar ligado num só conjunto de faces. */
  checkConnected?: boolean;
  /** Erro se alguma aresta costurada tiver um desvio de tangência acima de 0,5°. */
  checkTangency?: boolean;
  /** Unir faces da mesma superfície (simplificar o resultado). */
  simplify?: boolean;
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
  /** Aparar mútuo (ferramenta = superfície): as duas superfícies aparam-se e as partes mantidas são costuradas. */
  mutual?: boolean;
}

/** Apagar faces de um sólido: o resultado passa a corpo de superfície (para reconstruir com superfícies). */
export interface DeleteFaceFeature {
  type: "deleteFace";
  faces: TopoRef[];
  /** "patch": apagar e remendar — o buraco é preenchido e o sólido mantém-se (como "Delete and Patch"). */
  mode?: "delete" | "patch";
  /** Continuidade do remendo com as faces vizinhas. */
  continuity?: Continuity;
}


/** Alvo de uma interseção/projeção: plano, corpo de superfície, faces escolhidas ou o corpo sólido inteiro. */
export type SurfaceTarget =
  | { kind: "plane"; plane: PlaneRef }
  | { kind: "sheet"; sheet: string }
  | { kind: "faces"; faces: TopoRef[] }
  | { kind: "body" };

/** Definição de uma curva 3D. */
export type CurveDef =
  /** Spline que passa pelos pontos (interpolação C2). */
  | { kind: "points"; points: [Expr, Expr, Expr][]; closed?: boolean }
  /** Esboço projetado em faces segundo a normal do esboço. */
  | { kind: "projected"; sketch: string; onto: SurfaceTarget }
  /** Interseção de duas superfícies/planos/corpos. */
  | { kind: "intersection"; a: SurfaceTarget; b: SurfaceTarget }
  /** Curva composta: arestas encadeadas (do modelo ou de outras curvas). */
  | { kind: "composite"; edges: TopoRef[] }
  /** Hélice em torno de um eixo. */
  | { kind: "helix"; axis: AxisRef; radius: Expr; pitch: Expr; height: Expr; lefthand?: boolean; startAngle?: Expr }
  /** Curva prolongada (extrapolação) no início e/ou no fim, em tangência ou curvatura. */
  | { kind: "extend"; curve: CurveRef; start?: Expr; end?: Expr; continuity?: "tangent" | "curvature" };

export interface CurveFeature {
  type: "curve";
  def: CurveDef;
}

/** Curva de entrada de uma superfície: curva 3D, aresta do modelo ou esboço (uma cadeia). */
export type CurveRef = { kind: "curve"; feature: string } | { kind: "edge"; ref: TopoRef } | { kind: "sketch"; sketch: string };

/**
 * Superfície limite (boundary): curvas em duas direções. Os limites (primeira e última curva de cada
 * direção) podem ter tangência/curvatura às faces vizinhas; as curvas intermédias guiam a forma.
 * Só com a direção 1, é um loft suave pelas curvas.
 */
export interface BoundaryFeature {
  type: "boundary";
  dir1: CurveRef[];
  dir2: CurveRef[];
  cont1?: Continuity;
  cont2?: Continuity;
}

/** Superfície regrada a partir de arestas: normal ou tangente à face vizinha, ou numa direção. */
export interface RuledSurfaceFeature {
  type: "ruled";
  edges: TopoRef[];
  /** "angle": linha a um ângulo da superfície (0° = tangente, 90° = normal), como o "line sweep" do GSD. */
  mode: "normal" | "tangent" | "direction" | "angle";
  angle?: Expr;
  /** Face de referência para normal/tangente (por defeito, a face vizinha de cada aresta; obrigatória em arestas entre duas faces). */
  face?: TopoRef;
  direction?: AxisRef;
  distance: Expr;
  flip?: boolean;
}

/** Desaparar: faces até aos limites naturais da superfície (ou à caixa UV, se a superfície for infinita). */
export interface UntrimFeature {
  type: "untrim";
  faces: TopoRef[];
}

/** Substituir faces do sólido por um corpo de superfície (o sólido estende-se ou apara-se até ela). */
export interface ReplaceFaceFeature {
  type: "replaceFace";
  faces: TopoRef[];
  sheet: string;
}
