// Modelo de documento: JSON puro, sem dependências do núcleo geométrico.
// Unidades internas: milímetros e graus.
export * from "./types-base.ts";
export * from "./types-sketch.ts";
export * from "./types-solid.ts";
export * from "./types-surface.ts";
export * from "./types-gsd.ts";
import type { TopoRef, Variable, Vec3 } from "./types-base.ts";
import type { SketchFeature } from "./types-sketch.ts";
import type { AxisFeature, BodyOp, ChamferFeature, CircularPatternFeature, CsysFeature, DraftFeature, ExtrudeFeature, FilletFeature, HoleFeature, ImportFeature, LinearPatternFeature, LoftFeature, MirrorFeature, PlaneFeature, PluginFeature, RevolveFeature, RibFeature, ShellFeature, SweepFeature } from "./types-solid.ts";
import type { BoundaryFeature, CurveFeature, DeleteFaceFeature, FillFeature, KnitFeature, OffsetSurfaceFeature, ReplaceFaceFeature, RuledSurfaceFeature, SurfaceExtrudeFeature, SurfaceLoftFeature, SurfaceRevolveFeature, SurfaceSweepFeature, ThickenFeature, TrimSurfaceFeature, UntrimFeature } from "./types-surface.ts";
import type { BlendFeature, CircleSweepFeature, ExtrapolateFeature, FreeformFeature, HealFeature, MultiSectionFeature } from "./types-gsd.ts";

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
  /** Análise integrada Galkeel (registo da embarcação, laminado e painéis a verificar). */
  galkeel?: { vessel: import("../galkeel/scantling.ts").VesselRecord; laminate: import("../galkeel/scantling.ts").Laminate; panels: import("../galkeel/scantling.ts").PanelInput[]; caseRef?: string; femStudy?: string };
  /** Scripts de automação guardados com a peça (API cad.*). */
  scripts?: { name: string; code: string }[];
  /** Índice da barra de rollback: só as features antes deste índice são reconstruídas. Omitido = todas. */
  rollback?: number;
}
