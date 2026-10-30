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

/**
 * Malha de um caso FEM (resolvida pelo núcleo; o Gmsh só a executa). Curvas e superfícies pelas
 * tags do Gmsh (= ordem do OpenCASCADE), com a caixa envolvente de cada curva para conferir.
 */
export interface FemCaseMesh {
  size: number;
  minSize: number;
  curvature: number;
  order: 1 | 2;
  local: { group: string; size: number }[];
  /** Tetraedros (por omissão) ou hexaedros. */
  element?: "tet" | "hex";
  /**
   * Hexaedros: volumes estruturados (transfinitos: cada volume tem 6 faces de 4 arestas) ou
   * subdivisão de toda a malha em hexaedros (qualquer geometria, qualidade inferior).
   */
  hexMethod?: "structured" | "subdivision";
  /** Volumes mapeados (transfinitos) e superfícies mapeadas (quadriláteros nos hexaedros). */
  volumes?: number[];
  surfaces?: number[];
  /** Integração dos hexaedros: modos incompatíveis (C3D8I), completa ou reduzida. */
  integration?: "incompatible" | "full" | "reduced";
  /**
   * Seeds das arestas: n.º de elementos e distribuição (progressão geométrica, "bump" nas duas
   * pontas/no meio) — as do utilizador e as propagadas pelas faces mapeadas.
   */
  curves?: { tag: number; n: number; progression?: number; bump?: number; box: { min: V3; max: V3 }; length: number; user?: boolean }[];
}

export interface FemCase {
  format: "cadp-sim-case";
  version: 1;
  physics: "fem";
  solver: "calculix" | "code_aster";
  title: string;
  analysis: "static" | "modal" | "buckling" | "thermal";
  /** Estática não linear: geometria (grandes deslocamentos), plasticidade bilinear, incrementos. */
  nonlinear?: { geometry: boolean; plasticity: boolean; increments: number };
  modes: number;
  material: SimMaterial;
  /** Grupo físico → tags das faces. */
  groups: Record<string, number[]>;
  faces: CaseFace[];
  loads: FemCaseLoad[];
  mesh: FemCaseMesh;
  bbox: { min: V3; max: V3 };
  /**
   * Montagens: um corpo por volume (volume Gmsh k+1 → grupo B<k+1>) com o seu material e caixa
   * envolvente; sem `bodies` o caso tem um só corpo (grupo SOLID).
   */
  bodies?: { group: string; path: string; name: string; material: SimMaterial; bbox: { min: V3; max: V3 } }[];
  /** Sondas: grupo de faces (média por área) ou ponto (nó mais próximo), mm. */
  probes?: { key: string; name: string; quantity: "u" | "ux" | "uy" | "uz" | "vm" | "T"; group?: string; point?: V3; stat?: "mean" | "max" }[];
  /**
   * Contacto entre faces de corpos diferentes (grupos escravo/mestre): colado (`tie`, por omissão) ou
   * com atrito de Coulomb μ e separação (`contact`, penalidade face a face).
   */
  ties?: { name: string; slave: string; master: string; tolerance: number; slaveBody?: string; masterBody?: string; kind?: "tie" | "contact"; mu?: number }[];
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
