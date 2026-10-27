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

// ---------------------------------------------------------------------------
// Publicações e referências externas (Fase 4.5)
// ---------------------------------------------------------------------------

/** O que uma peça publica: uma face/aresta, uma feature (plano, eixo, esboço, curva, superfície) ou o corpo. */
export type PublishedRef = TopoRef | { kind: "feature"; feature: string } | { kind: "body" };

/** Geometria publicada com um nome estável: outras peças e os mates referem-na por esse nome. */
export interface Publication {
  name: string;
  ref: PublishedRef;
  comment?: string;
}

export interface FrameData { o: Vec3; x: Vec3; y: Vec3; z: Vec3 }

/**
 * Referência externa controlada: cópia de uma publicação de outra peça. Ligada (atualiza com a
 * origem) ou congelada (fica a cópia guardada). A posição é a da origem da peça de origem ou uma
 * matriz lida de uma montagem (componente de origem → componente desta peça).
 */
export interface ExternalFeature {
  type: "external";
  part: string;
  publication: string;
  mode: "linked" | "frozen";
  /** Matriz 4×4 (coluna maior, como a das instâncias) da peça de origem no referencial desta peça. */
  placement?: { m: number[]; assembly?: string; from?: string; to?: string };
  /** Cópia congelada: revisão da origem e geometria (BRep em texto, plano ou eixo). */
  frozen?: { revision: string; brep?: string; frame?: FrameData; axis?: { o: Vec3; d: Vec3 } };
  /** Corpo publicado: operação com o corpo desta peça. */
  op?: BodyOp;
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
  | DeleteFaceFeature
  | CurveFeature
  | BoundaryFeature
  | RuledSurfaceFeature
  | UntrimFeature
  | ReplaceFaceFeature
  | MultiSectionFeature
  | BlendFeature
  | CircleSweepFeature
  | ExtrapolateFeature
  | HealFeature
  | FreeformFeature
  | ExternalFeature;

export type FeatureType = FeatureData["type"];

export type Feature = FeatureData & {
  id: string;
  name: string;
  suppressed?: boolean;
};

export type FeatureOf<T extends FeatureType> = Extract<Feature, { type: T }>;

// ---------------------------------------------------------------------------
// Knowledgeware (Fase 4.4): regras, verificações e tabela de configurações
// ---------------------------------------------------------------------------

/** Regra: se a condição for verdadeira (≠ 0), atribui valores a variáveis (aplicadas por ordem). */
export interface Rule {
  name: string;
  /** Condição (expressão); vazia = sempre. */
  condition?: string;
  /** Atribuições "variável = expressão". */
  assign: { variable: string; expr: string }[];
  /** Senão: atribuições quando a condição é falsa. */
  otherwise?: { variable: string; expr: string }[];
  disabled?: boolean;
}

/**
 * Verificação: expressão que tem de ser verdadeira, avaliada depois da reconstrução com as variáveis
 * e as medidas do modelo (volume, area, massa, dimX, dimY, dimZ).
 */
export interface Check {
  name: string;
  expr: string;
  message?: string;
  severity: "info" | "warning" | "error";
}

/**
 * Tabela de configurações (famílias de peças, "design table"): cada linha é uma configuração e cada
 * coluna uma variável ("L"), o estado de supressão de uma feature ("$s:f7", valor S/U) ou uma
 * propriedade da peça ("$p:number", "$p:description").
 */
export interface ConfigTable {
  active?: string;
  columns: string[];
  rows: { name: string; values: Record<string, string> }[];
}

export interface CadDocument {
  format: "cadp";
  version: 1;
  name: string;
  units: "mm";
  variables: Variable[];
  features: Feature[];
  rules?: Rule[];
  checks?: Check[];
  configurations?: ConfigTable;
  publications?: Publication[];
  /** Estudos de simulação FEM/CFD (pré-processador). */
  studies?: import("./study.ts").Study[];
  /** PMI 3D semântico, vistas de modelo e atributos (Fase 5). */
  pmi?: import("./pmi.ts").PmiItem[];
  modelViews?: import("./pmi.ts").ModelView[];
  attributes?: import("./pmi.ts").Attribute[];
  /** Índice da barra de rollback: só as features antes deste índice são reconstruídas. Omitido = todas. */
  rollback?: number;
}
