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
  analysis: "static" | "modal" | "buckling" | "thermal" | "dynamic";
  /**
   * Dinâmica transitória: esquema, duração e passo (s; no explícito sem `dt` o agente usa o passo
   * estável da malha), amplitude das cargas (pares tempo–fator, interpolação linear), Rayleigh
   * C = α·M + β·K e n.º de instantes guardados.
   */
  dynamic?: { scheme: "implicit" | "explicit"; duration: number; dt?: number; amplitude: [number, number][]; alpha: number; beta: number; frames: number };
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

/** Fator da amplitude no instante t (interpolação linear; constante fora da tabela). Sem dinâmica: 1. */
export function amplitudeAt(c: FemCase, t: number): number {
  const a = c.dynamic?.amplitude;
  if (!a?.length) return 1;
  if (t <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) if (t <= a[i][0]) return a[i - 1][1] + ((a[i][1] - a[i - 1][1]) * (t - a[i - 1][0])) / (a[i][0] - a[i - 1][0] || 1);
  return a[a.length - 1][1];
}

/** Tabela da amplitude (pares tempo–fator) de uma carga em degrau, rampa, meio seno ou seno. */
export function amplitudeTable(load: "step" | "ramp" | "halfsine" | "sine", duration: number, rise?: number, period?: number): [number, number][] {
  if (load === "step") return [[0, 1], [duration, 1]];
  if (load === "ramp") {
    const r = Math.min(rise ?? duration, duration);
    return r >= duration ? [[0, 0], [duration, 1]] : [[0, 0], [r, 1], [duration, 1]];
  }
  const T = period ?? duration;
  const end = load === "halfsine" ? Math.min(T, duration) : duration;
  // 24 pontos por meio período (o seno amostrado com erro < 0,5 %)
  const n = Math.max(24, Math.ceil((48 * end) / T));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (end * i) / n;
    pts.push([t, load === "halfsine" ? Math.sin((Math.PI * t) / T) : Math.sin((2 * Math.PI * t) / T)]);
  }
  if (load === "halfsine" && end < duration) pts.push([duration, 0]);
  return pts.map(([t, v]) => [t, Math.abs(v) < 1e-12 ? 0 : v]);
}