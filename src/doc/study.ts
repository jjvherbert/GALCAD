// Estudos de simulação (pré-processador FEM/CFD, etapa F1). Fazem parte da peça e ligam as
// condições às faces pelo nome topológico: mudar o modelo regenera a malha e os ficheiros do solver.
//
// Unidades no documento: comprimentos em mm (como o CAD); FEM em mm–N–MPa–t–s (o deck do CalculiX
// usa este sistema coerente); propriedades térmicas e de fluidos em SI, convertidas na exportação.
import type { Expr, TopoRef, Vec3 } from "./types.ts";

/** Material isotrópico linear (com a origem dos valores). */
export interface SimMaterial {
  name: string;
  /** Módulo de Young (MPa). */
  E: number;
  nu: number;
  /** Massa volúmica (g/cm³). */
  density: number;
  /** Coeficiente de dilatação térmica (1/K). */
  alpha?: number;
  /** Condutividade térmica (W/(m·K)). */
  k?: number;
  /** Tensão de cedência (MPa), para o fator de segurança e a plasticidade. */
  yield?: number;
  /** Módulo tangente depois da cedência (MPa), curva bilinear com encruamento isotrópico. */
  tangent?: number;
  source?: string;
}

export type FemLoad =
  | { kind: "fixed"; faces: TopoRef[] }
  | { kind: "displacement"; faces: TopoRef[]; ux?: Expr; uy?: Expr; uz?: Expr }
  /** Força total (N) distribuída uniformemente pela área das faces. */
  | { kind: "force"; faces: TopoRef[]; f: [Expr, Expr, Expr] }
  /** Pressão (MPa), positiva a empurrar contra a face. */
  | { kind: "pressure"; faces: TopoRef[]; p: Expr }
  /** Aceleração da gravidade (mm/s²). */
  | { kind: "gravity"; g: [Expr, Expr, Expr] }
  /** Temperatura imposta (°C). */
  | { kind: "temperature"; faces: TopoRef[]; t: Expr }
  /** Convecção: coeficiente (W/(m²·K)) e temperatura do fluido (°C). */
  | { kind: "convection"; faces: TopoRef[]; h: Expr; tInf: Expr }
  /** Fluxo de calor (W/m²) a entrar nas faces. */
  | { kind: "heatFlux"; faces: TopoRef[]; q: Expr };

export interface SimMesh {
  /** Tamanho máximo dos elementos (mm). */
  size: Expr;
  /** Tamanho mínimo (mm); omitido = tamanho / 10. */
  minSize?: Expr;
  /** Elementos por volta de 2π nas zonas curvas (0 = sem refinamento por curvatura). */
  curvature?: number;
  /** Ordem dos elementos: 1 (tetraedros lineares) ou 2 (quadráticos, recomendado em estruturas). */
  order: 1 | 2;
  /** Refinamento local em faces. */
  local?: { faces: TopoRef[]; size: Expr }[];
}

/** Não linearidades da análise estática. */
export interface FemNonlinear {
  /** Grandes deslocamentos e rotações (NLGEOM / GROT_GDEP). */
  geometry?: boolean;
  /** Plasticidade de von Mises com encruamento isotrópico bilinear (cedência e módulo tangente do material). */
  plasticity?: boolean;
  /** N.º de incrementos de carga (mínimo; o solver pode subdividir). */
  increments?: number;
}

/**
 * Sonda: grandeza num ponto (nó mais próximo) ou média ponderada pela área sobre faces. É o que se
 * deve usar na convergência da malha (os máximos junto a singularidades não convergem).
 */
export interface Probe {
  name: string;
  quantity: "u" | "ux" | "uy" | "uz" | "vm" | "T";
  at: { kind: "faces"; faces: TopoRef[] } | { kind: "point"; point: [Expr, Expr, Expr] };
  /** Nas faces: média ponderada pela área (por omissão) ou máximo nos nós. */
  stat?: "mean" | "max";
}

export interface FemStudy {
  id: string;
  name: string;
  physics: "fem";
  /** CalculiX (por omissão) ou code_aster (EDF, GPL), para os mesmos casos. */
  solver: "calculix" | "code_aster";
  analysis: "static" | "modal" | "buckling" | "thermal";
  nonlinear?: FemNonlinear;
  material: SimMaterial;
  loads: FemLoad[];
  /** Modos próprios (modal) ou de encurvadura. */
  modes?: number;
  mesh: SimMesh;
  /**
   * Montagens: material de cada corpo pelo caminho da instância ("c1", "c2/c1"); os restantes usam
   * `material`. Nas montagens as faces das condições são "caminho/face".
   */
  bodyMaterials?: Record<string, SimMaterial>;
  /** Sondas (grandezas em pontos ou médias em faces) para resultados e convergência. */
  probes?: Probe[];
  /** Montagens: faces planas coincidentes entre corpos coladas (bonded) ou independentes. */
  /**
   * Contacto entre corpos nas faces planas coincidentes: colado (TIE), com atrito de Coulomb e
   * separação (penalidade face a face, CalculiX), ou nenhum.
   */
  contact?: { mode: "bonded" | "friction" | "none"; tolerance?: number; mu?: number };
}

export interface CfdMesh {
  /** Tamanho das células de fundo (mm). */
  size: Expr;
  /** Níveis de refinamento junto às superfícies (mín., máx.) no snappyHexMesh. */
  surfaceLevel?: [number, number];
  /** Camadas prismáticas junto às paredes (0 = sem camadas). */
  layers?: number;
}

export interface CfdStudy {
  id: string;
  name: string;
  physics: "cfd";
  solver: "openfoam" | "su2";
  /** Interno: o corpo é o volume de fluido (conduta, câmara). Externo: o corpo é um obstáculo num domínio em caixa. */
  regime: "internal" | "external";
  fluid: { name: string; rho: number; nu: number };
  turbulence: "laminar" | "kOmegaSST" | "kEpsilon";
  /** Interno: faces de entrada (velocidade imposta, m/s) e de saída (pressão 0). */
  inlet?: { faces: TopoRef[]; velocity: [Expr, Expr, Expr] };
  outlet?: { faces: TopoRef[] };
  /**
   * Externo: velocidade do escoamento não perturbado (m/s) e domínio em múltiplos da maior dimensão do
   * corpo: [a montante, a jusante, lados].
   */
  freestream?: { velocity: [Expr, Expr, Expr]; domain?: [number, number, number] };
  iterations: number;
  mesh: CfdMesh;
}

export type Study = FemStudy | CfdStudy;

/** Materiais de referência (valores nominais à temperatura ambiente; confirmar na ficha do material). */
export const SIM_MATERIALS: SimMaterial[] = [
  { name: "Aço S235JR", E: 210000, nu: 0.3, density: 7.85, alpha: 12e-6, k: 50, yield: 235, tangent: 2100, source: "EN 10025-2 (valores nominais)" },
  { name: "Aço inox AISI 316L", E: 193000, nu: 0.3, density: 8.0, alpha: 16e-6, k: 16, yield: 170, tangent: 1930, source: "EN 10088-2 (valores nominais)" },
  { name: "Alumínio EN AW-6082 T6", E: 70000, nu: 0.33, density: 2.7, alpha: 23e-6, k: 170, yield: 250, tangent: 700, source: "EN 755-2 (valores nominais)" },
  { name: "Alumínio EN AW-5083 H111", E: 70000, nu: 0.33, density: 2.66, alpha: 24e-6, k: 117, yield: 125, tangent: 700, source: "EN 485-2 (valores nominais)" },
  { name: "PRFV (laminado E-vidro/poliéster, isotrópico equivalente)", E: 12000, nu: 0.3, density: 1.6, alpha: 25e-6, k: 0.3, yield: 100, source: "Valor indicativo — laminados reais são ortotrópicos: usar o módulo de compósitos" },
];

/** Fluidos de referência (20 °C, 1 atm). */
export const SIM_FLUIDS: CfdStudy["fluid"][] = [
  { name: "Água doce (20 °C)", rho: 998.2, nu: 1.004e-6 },
  { name: "Água do mar (15 °C)", rho: 1025.9, nu: 1.188e-6 },
  { name: "Ar (20 °C)", rho: 1.204, nu: 1.516e-5 },
];

export function newFemStudy(id: string, n: number): FemStudy {
  return { id, name: `Estudo estático ${n}`, physics: "fem", solver: "calculix", analysis: "static", material: { ...SIM_MATERIALS[0] }, loads: [], modes: 6, mesh: { size: 5, order: 2, curvature: 12 } };
}

export function newCfdStudy(id: string, n: number): CfdStudy {
  return {
    id, name: `Estudo CFD ${n}`, physics: "cfd", solver: "openfoam", regime: "internal", fluid: { ...SIM_FLUIDS[0] }, turbulence: "kOmegaSST",
    inlet: { faces: [], velocity: [1, 0, 0] }, outlet: { faces: [] }, freestream: { velocity: [1, 0, 0], domain: [3, 6, 2] }, iterations: 500, mesh: { size: 5, surfaceLevel: [1, 2], layers: 3 },
  };
}

/** Todas as referências a faces de um estudo (para dependências e validação). */
export function studyFaces(s: Study): TopoRef[] {
  if (s.physics === "fem") return [...s.loads.flatMap((l) => ("faces" in l ? l.faces : [])), ...(s.mesh.local ?? []).flatMap((l) => l.faces)];
  return [...(s.inlet?.faces ?? []), ...(s.outlet?.faces ?? [])];
}

export type { Vec3 };
