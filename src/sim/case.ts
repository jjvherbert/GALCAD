// Caso de simulação resolvido (números, grupos de faces por tag Gmsh/OCC): a descrição neutra que
// os adaptadores (Gmsh, CalculiX, OpenFOAM, SU2) traduzem. Gerado pelo núcleo a partir do estudo;
// viaja no ficheiro `case.json` do caso exportado e é lido pelo agente local.
import type { SimMaterial } from "../doc/study.ts";

export type V3 = [number, number, number];

/** Face do corpo: tag (índice 1… pela ordem do OpenCASCADE, igual ao do Gmsh), centroide e área (mm, mm²). */
export interface CaseFace { tag: number; name: string; center: V3; area: number }

export type FemCaseLoad =
  | { kind: "fixed"; group: string }
  | { kind: "displacement"; group: string; u: (number | null)[] }
  | { kind: "force"; group: string; f: V3 }
  | { kind: "pressure"; group: string; p: number }
  | { kind: "gravity"; g: V3 }
  | { kind: "temperature"; group: string; t: number }
  | { kind: "convection"; group: string; h: number; tInf: number }
  | { kind: "heatFlux"; group: string; q: number };

export interface FemCase {
  format: "cadp-sim-case";
  version: 1;
  physics: "fem";
  solver: "calculix";
  title: string;
  analysis: "static" | "modal" | "buckling" | "thermal";
  modes: number;
  material: SimMaterial;
  /** Grupo físico → tags das faces. */
  groups: Record<string, number[]>;
  faces: CaseFace[];
  loads: FemCaseLoad[];
  mesh: { size: number; minSize: number; curvature: number; order: 1 | 2; local: { group: string; size: number }[] };
  bbox: { min: V3; max: V3 };
  hypotheses: string[];
}

export interface CfdCase {
  format: "cadp-sim-case";
  version: 1;
  physics: "cfd";
  solver: "openfoam" | "su2";
  title: string;
  regime: "internal" | "external";
  fluid: { name: string; rho: number; nu: number };
  turbulence: "laminar" | "kOmegaSST" | "kEpsilon";
  /** Patches (internos: inlet/outlet/walls; externos: body) → tags das faces do corpo. */
  groups: Record<string, number[]>;
  faces: CaseFace[];
  /** Velocidade de entrada / do escoamento livre (m/s). */
  velocity: V3;
  /** Domínio externo (mm): caixa. */
  domain?: { min: V3; max: V3 };
  /** Ponto (mm) dentro da região de fluido (para o snappyHexMesh). */
  insidePoint: V3;
  iterations: number;
  mesh: { size: number; surfaceLevel: [number, number]; layers: number };
  bbox: { min: V3; max: V3 };
  /** Dimensão característica (mm) e número de Reynolds estimado. */
  refLength: number;
  reynolds: number;
  hypotheses: string[];
}

export type SimCase = FemCase | CfdCase;

/** Grupos físicos gerados para cada carga (`L1_FIXED`, …) e os do refinamento local (`R1`, …). */
export const loadGroup = (i: number, kind: string) => `L${i + 1}_${kind.toUpperCase()}`;
