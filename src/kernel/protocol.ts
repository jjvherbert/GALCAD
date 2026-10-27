// Protocolo de mensagens entre a interface e o worker do núcleo geométrico.
import type { CadDocument, SketchEntity } from "../doc/types.ts";
import type { Profiles } from "../sketch/profiles.ts";
import type { Axis, Frame } from "./frame.ts";
import type { MeshData } from "./mesh.ts";
import type { FeatureStatus } from "./rebuild.ts";

export type ExportFormat = "step" | "stl" | "3mf" | "obj" | "glb";

export type Request =
  | { type: "rebuild"; doc: CadDocument; force?: boolean }
  | { type: "export"; format: ExportFormat; name: string };

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
}

export interface ExportResponse {
  data: Uint8Array;
  mime: string;
  ext: string;
}

export type Response =
  | { id: number; ok: true; result: RebuildResponse | ExportResponse }
  | { id: number; ok: false; error: string };
