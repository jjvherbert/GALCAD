// Protocolo de mensagens entre a interface e o worker do núcleo geométrico.
import type { CadDocument, SketchEntity, Vec3 } from "../doc/types.ts";
import type { CadProject, PartDoc } from "../doc/project.ts";
import type { PartSignature } from "./signature.ts";
import type { Profiles } from "../sketch/profiles.ts";
import type { Axis, Frame } from "./frame.ts";
import type { MeshData } from "./mesh.ts";
import type { FeatureStatus } from "./rebuild.ts";

export type ExportFormat = "step" | "step242" | "stl" | "3mf" | "obj" | "glb";

export type Request =
  /** `parts`: as outras peças de que esta depende (referências externas), para as reconstruir. */
  | { type: "rebuild"; doc: CadDocument; force?: boolean; parts?: PartDoc[] }
  | { type: "snapshot"; doc: PartDoc; parts: PartDoc[]; feature: string }
  /** Ficheiros do caso de simulação de um estudo da peça (pré-processador). */
  | { type: "studyCase"; doc: PartDoc; parts: PartDoc[]; study: string }
  | { type: "export"; format: ExportFormat; name: string }
  | { type: "curvature"; kind: CurvatureKind }
  | { type: "deviation" }
  | { type: "continuity" }
  | { type: "normals" }
  | { type: "combs"; edges?: string[] }
  | { type: "assembly"; project: CadProject; asmId: string; force?: boolean }
  | { type: "interference" }
  | { type: "drawing"; project: CadProject; drawingId: string; force?: boolean }
  | { type: "signatures"; project: CadProject };

export interface SignatureResponse {
  parts: Record<string, PartSignature | { error: string }>;
}

// ---------------------------------------------------------------------------
// Montagens
// ---------------------------------------------------------------------------

export interface MateStatus { ok: boolean; residual: number; error?: string }

export interface AssemblyInstance {
  /** Caminho de componentes (subconjuntos) até à peça, ex. "c2/c1". */
  path: string;
  /** Componente de topo (o que se escolhe na árvore da montagem ativa). */
  top: string;
  part: string;
  name: string;
  /** Matriz 4×4 (por colunas, como no three.js) do referencial da peça para o da montagem. */
  matrix: number[];
}

export interface AssemblyResponse {
  ok: boolean;
  /** Graus de liberdade que ficam livres (0 = totalmente definida). */
  dof: number;
  messages: string[];
  mates: Record<string, MateStatus>;
  /** Malha de cada peça, nas coordenadas da peça. */
  parts: Record<string, MeshData>;
  instances: AssemblyInstance[];
  /** Volume e área de cada peça (para massa e BOM). */
  partMass: Record<string, { volume: number; area: number }>;
  partErrors: Record<string, number>;
  mass: MassProps | null;
  ms: number;
}

export interface InterferenceResponse {
  pairs: { a: string; b: string; volume: number; mesh: MeshData }[];
}

// ---------------------------------------------------------------------------
// Desenhos
// ---------------------------------------------------------------------------

/** Curva 2D nas coordenadas da vista (mm do modelo). Arcos no sentido anti-horário, ângulos em radianos. */
export type Curve2D =
  | { k: "l"; a: [number, number]; b: [number, number] }
  | { k: "a"; c: [number, number]; r: number; a0: number; a1: number }
  | { k: "c"; c: [number, number]; r: number }
  | { k: "p"; pts: [number, number][] };

export interface ViewFrame { o: [number, number, number]; x: [number, number, number]; y: [number, number, number]; z: [number, number, number] }

export interface ViewResult {
  ok: boolean;
  error?: string;
  frame: ViewFrame;
  /** Escala efetiva da vista. */
  scale: number;
  /** Caixa da geometria [xmin, ymin, xmax, ymax] (coordenadas da vista). */
  bbox: [number, number, number, number];
  visible: Curve2D[];
  hidden: Curve2D[];
  tangent: Curve2D[];
  /** Triângulos das faces cortadas (cortes), para tracejar: x0,y0,x1,y1,x2,y2,… */
  hatch: number[];
  centerMarks: { c: [number, number]; r: number }[];
  centerLines: [[number, number], [number, number]][];
  /** Projeção de cada aresta do modelo com nome (para âncoras de cotas e notas). */
  edges: Record<string, Curve2D>;
  /** Cotas dos esboços paralelos ao plano da vista (importar cotas do modelo). */
  modelDims: { feature: string; constraint: string; type: "aligned" | "horizontal" | "vertical" | "radius" | "diameter"; a: [number, number]; b: [number, number]; value: number }[];
  /** Componente de cada aresta (vistas de montagem): nome da aresta → componente de topo. */
  edgeComponent?: Record<string, string>;
}

export interface DrawingResponse {
  views: Record<string, ViewResult>;
  /** Massa (volume × densidade) da fonte de cada vista de modelo, para a legenda. */
  sources: Record<string, { volume: number; material?: string }>;
  /** Volume (mm³) das peças usadas nas tabelas de BOM do desenho. */
  partVolumes: Record<string, number>;
  ms: number;
}

/** Desvio de tangência (graus) de cada aresta entre duas faces: 0 = tangente; ~90 = aresta viva a 90°. */
export interface DeviationResponse {
  edges: { name: string; deg: number }[];
}

/** Caso de simulação: descrição neutra, ficheiros (texto) e avisos. */
export interface StudyCaseResponse { case: import("../sim/case.ts").SimCase; files: Record<string, string>; warnings: string[] }

/** Normais exatas por vértice da última malha (linhas de realce). */
export interface NormalsResponse { normals: Float32Array }

/** Cópia congelada de uma referência externa. */
export interface SnapshotResponse {
  revision: string;
  brep?: string;
  frame?: { o: Vec3; x: Vec3; y: Vec3; z: Vec3 };
  axis?: { o: Vec3; d: Vec3 };
}

/**
 * Continuidade de cada aresta entre duas faces (classe A): folga (G0), ângulo entre normais (G1),
 * diferença relativa da curvatura normal transversal (G2) e da sua derivada (G3).
 * `cls`: −1 = folga; 0 = só posição (G0); 1 = G1; 2 = G2; 3 = G3.
 */
export interface ContinuityResponse {
  edges: { name: string; gap: number; deg: number; dk: number; dk3: number; cls: -1 | 0 | 1 | 2 | 3 }[];
  limits: { gap: number; deg: number; dk: number; dk3: number };
}

/** Pentes de curvatura (porcupine): segmentos (pares de pontos) das cerdas e da envolvente. */
export interface CombsResponse {
  quills: Float32Array;
  envelope: Float32Array;
  /** Curvatura máxima (1/mm) e escala usada (mm por 1/mm). */
  maxK: number;
  scale: number;
  edges: number;
}

/** Análise de curvatura: gaussiana (K = k1·k2) ou média (H = (k1+k2)/2), em 1/mm. */
export type CurvatureKind = "gauss" | "mean";

/** Curvatura em cada vértice da última malha (mesma ordem de `MeshData.vertices`). */
export interface CurvatureResponse {
  kind: CurvatureKind;
  values: Float32Array;
  min: number;
  max: number;
}

/** Corpo de superfície (folha) do resultado. */
export interface SheetInfo {
  id: string;
  faces: number;
  area: number; // mm²
  freeEdges: number;
}

export interface SketchView {
  frame: Frame;
  entities: Record<string, SketchEntity>;
  ok: boolean;
  dof: number;
  profiles: Pick<Profiles, "errors"> & { regions: number };
  /** Regiões escolhíveis (contornos selecionados): assinatura, ponto interior e triângulos 2D. */
  regionList: { sig: string[]; seed: [number, number]; area: number; tris: number[] }[];
}

export interface MassProps {
  volume: number; // mm³
  area: number; // mm²
  center: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] };
  solids: number;
}

import type { CheckResult, RuleStatus } from "../doc/knowledge.ts";

export interface RebuildResponse {
  status: Record<string, FeatureStatus>;
  variables: { values: Record<string, number>; errors: Record<string, string> };
  ms: number;
  reused: number;
  mesh: MeshData | null;
  sketches: Record<string, SketchView>;
  planes: Record<string, Frame>;
  axes: Record<string, Axis>;
  csys: Record<string, Frame>;
  mass: MassProps | null;
  sheets: SheetInfo[];
  /** Knowledgeware: estado das regras, resultado das verificações e configuração aplicada. */
  rules?: RuleStatus[];
  checks?: CheckResult[];
  config?: string;
}

export interface ExportResponse {
  data: Uint8Array;
  mime: string;
  ext: string;
}

export type Response =
  | { id: number; ok: true; result: RebuildResponse | ExportResponse | CurvatureResponse | DeviationResponse | ContinuityResponse | CombsResponse | SnapshotResponse | NormalsResponse | StudyCaseResponse | AssemblyResponse | InterferenceResponse | DrawingResponse | SignatureResponse }
  | { id: number; ok: false; error: string };
