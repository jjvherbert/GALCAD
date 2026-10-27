// Protocolo de mensagens entre a interface e o worker do núcleo geométrico.
import type { CadDocument, SketchEntity } from "../doc/types.ts";
import type { Profiles } from "../sketch/profiles.ts";
import type { Axis, Frame } from "./frame.ts";
import type { MeshData } from "./mesh.ts";
import type { FeatureStatus } from "./rebuild.ts";

export type ExportFormat = "step" | "stl" | "3mf" | "obj" | "glb";

export type Request =
  | { type: "rebuild"; doc: CadDocument; force?: boolean }
  | { type: "export"; format: ExportFormat; name: string }
  | { type: "curvature"; kind: CurvatureKind }
  | { type: "deviation" };

/** Desvio de tangência (graus) de cada aresta entre duas faces: 0 = tangente; ~90 = aresta viva a 90°. */
export interface DeviationResponse {
  edges: { name: string; deg: number }[];
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
}

export interface ExportResponse {
  data: Uint8Array;
  mime: string;
  ext: string;
}

export type Response =
  | { id: number; ok: true; result: RebuildResponse | ExportResponse | CurvatureResponse | DeviationResponse }
  | { id: number; ok: false; error: string };
