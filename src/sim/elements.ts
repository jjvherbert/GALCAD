// Topologia dos elementos finitos sólidos (tetraedros e hexaedros, ordem 1 e 2) e das faces de
// fronteira (triângulos e quadriláteros), com as numerações do Gmsh, do CalculiX/Abaqus e do code_aster.
// Puro: usado pelos decks, pela leitura de resultados e pelas cargas consistentes.

export interface SolidType {
  kind: "tet" | "hex";
  order: 1 | 2;
  /** Tipo de elemento Gmsh. */
  gmsh: number;
  nodes: number;
  corners: number;
  /** Para cada posição do nó no CalculiX/Abaqus, o índice do nó no Gmsh. */
  toCcx: number[];
  /** Para cada posição no code_aster, o índice no Gmsh. */
  toAster: number[];
  /** Nome no code_aster. */
  aster: string;
  /**
   * Faces pela numeração do CalculiX (F1, F2, …: S1, S2, … nos *DLOAD/*SURFACE), com os índices dos
   * cantos na numeração do CalculiX; a ordem dá a normal para DENTRO do elemento.
   */
  faces: number[][];
}

export interface FaceType {
  kind: "tri" | "quad";
  gmsh: number;
  nodes: number;
  corners: number;
  /** Fração da área atribuída a cada nó (ordem Gmsh) numa tração uniforme: cargas nodais consistentes. */
  weights: number[];
  aster: string;
  toAster: number[];
}

const id = (n: number) => Array.from({ length: n }, (_, i) => i);

// Gmsh hex20: arestas 8:(0,1) 9:(0,3) 10:(0,4) 11:(1,2) 12:(1,5) 13:(2,3) 14:(2,6) 15:(3,7) 16:(4,5) 17:(4,7) 18:(5,6) 19:(6,7)
// Abaqus C3D20: 9:(1,2) 10:(2,3) 11:(3,4) 12:(4,1) 13:(5,6) 14:(6,7) 15:(7,8) 16:(8,5) 17:(1,5) 18:(2,6) 19:(3,7) 20:(4,8)
// code_aster HEXA20: as mesmas arestas que o Abaqus, mas as 4 verticais antes das do topo
const HEX20_CCX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 9, 16, 18, 19, 17, 10, 12, 14, 15];
const HEX20_ASTER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 9, 10, 12, 14, 15, 16, 18, 19, 17];
const HEX_FACES = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
/** Faces do tetraedro (CalculiX): F1 = 1-2-3, F2 = 1-4-2, F3 = 2-4-3, F4 = 3-4-1. */
const TET_FACES = [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];

export const SOLIDS: Record<number, SolidType> = {
  4: { kind: "tet", order: 1, gmsh: 4, nodes: 4, corners: 4, toCcx: id(4), toAster: id(4), aster: "TETRA4", faces: TET_FACES },
  // Gmsh tet10 → CalculiX C3D10: as arestas 2-4 e 3-4 vêm trocadas (nós 9 e 10)
  11: { kind: "tet", order: 2, gmsh: 11, nodes: 10, corners: 4, toCcx: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8], toAster: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8], aster: "TETRA10", faces: TET_FACES },
  5: { kind: "hex", order: 1, gmsh: 5, nodes: 8, corners: 8, toCcx: id(8), toAster: id(8), aster: "HEXA8", faces: HEX_FACES },
  17: { kind: "hex", order: 2, gmsh: 17, nodes: 20, corners: 8, toCcx: HEX20_CCX, toAster: HEX20_ASTER, aster: "HEXA20", faces: HEX_FACES },
};

export const FACES: Record<number, FaceType> = {
  2: { kind: "tri", gmsh: 2, nodes: 3, corners: 3, weights: [1 / 3, 1 / 3, 1 / 3], aster: "TRIA3", toAster: id(3) },
  // tri6: a tração uniforme vai toda para os nós intermédios (1/3 cada; cantos 0)
  9: { kind: "tri", gmsh: 9, nodes: 6, corners: 3, weights: [0, 0, 0, 1 / 3, 1 / 3, 1 / 3], aster: "TRIA6", toAster: id(6) },
  3: { kind: "quad", gmsh: 3, nodes: 4, corners: 4, weights: [1 / 4, 1 / 4, 1 / 4, 1 / 4], aster: "QUAD4", toAster: id(4) },
  // quad8 (serendipity): cantos −1/12, intermédios 1/3 (soma 1)
  16: { kind: "quad", gmsh: 16, nodes: 8, corners: 4, weights: [-1 / 12, -1 / 12, -1 / 12, -1 / 12, 1 / 3, 1 / 3, 1 / 3, 1 / 3], aster: "QUAD8", toAster: id(8) },
};

export const isSolidType = (t: number) => t in SOLIDS;
export const isFaceType = (t: number) => t in FACES;

type P3 = [number, number, number];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (u: P3, v: P3): P3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];

/** Vetor área (normal × área) de uma face pelos cantos, na ordem dada (quad: soma de 2 triângulos). */
export function areaVector(corners: P3[]): P3 {
  const a = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
  const out: P3 = [a[0] / 2, a[1] / 2, a[2] / 2];
  if (corners.length === 4) {
    const b = cross(sub(corners[2], corners[0]), sub(corners[3], corners[0]));
    for (let k = 0; k < 3; k++) out[k] += b[k] / 2;
  }
  return out;
}

/** Chave de uma face pelos nós de canto (independente da ordem). */
export const faceKey = (nodes: number[]) => [...nodes].sort((x, y) => x - y).join(",");

/** Triângulos (cantos) de uma face com a normal para FORA, a partir da ordem de normal para dentro. */
export function outwardTriangles(c: number[]): [number, number, number][] {
  return c.length === 3 ? [[c[0], c[2], c[1]]] : [[c[0], c[3], c[2]], [c[0], c[2], c[1]]];
}

// ---------------------------------------------------------------------------
// Integração nas faces: áreas nodais consistentes (∫Nᵢ dA) e vetores área nodais (∫Nᵢ n dA)
// ---------------------------------------------------------------------------

/** Funções de forma das faces (numeração Gmsh) em coordenadas naturais (ξ, η). */
function shape(type: number, x: number, y: number): number[] {
  switch (type) {
    case 2: return [1 - x - y, x, y];
    case 9: {
      const L = [1 - x - y, x, y];
      return [L[0] * (2 * L[0] - 1), L[1] * (2 * L[1] - 1), L[2] * (2 * L[2] - 1), 4 * L[0] * L[1], 4 * L[1] * L[2], 4 * L[2] * L[0]];
    }
    case 3: return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ((1 + a * x) * (1 + b * y)) / 4);
    case 16: return [
      ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ((1 + a * x) * (1 + b * y) * (a * x + b * y - 1)) / 4),
      ((1 - x * x) * (1 - y)) / 2, ((1 + x) * (1 - y * y)) / 2, ((1 - x * x) * (1 + y)) / 2, ((1 - x) * (1 - y * y)) / 2,
    ];
  }
  throw new Error(`Face do tipo Gmsh ${type} sem funções de forma`);
}

/** Derivadas das funções de forma em ξ e η (analíticas). */
function dshape(type: number, x: number, y: number): [number[], number[]] {
  switch (type) {
    case 2: return [[-1, 1, 0], [-1, 0, 1]];
    case 9: {
      const L = [1 - x - y, x, y], dx = [-1, 1, 0], dy = [-1, 0, 1];
      const d = (D: number[]) => [0, 1, 2].map((i) => (4 * L[i] - 1) * D[i]).concat([[0, 1], [1, 2], [2, 0]].map(([i, j]) => 4 * (D[i] * L[j] + L[i] * D[j])));
      return [d(dx), d(dy)];
    }
    case 3: {
      const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      return [c.map(([a, b]) => (a * (1 + b * y)) / 4), c.map(([a, b]) => (b * (1 + a * x)) / 4)];
    }
    case 16: {
      const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      return [
        [...c.map(([a, b]) => (a * (1 + b * y) * (2 * a * x + b * y)) / 4), -x * (1 - y), (1 - y * y) / 2, -x * (1 + y), -(1 - y * y) / 2],
        [...c.map(([a, b]) => (b * (1 + a * x) * (a * x + 2 * b * y)) / 4), -(1 - x * x) / 2, -(1 + x) * y, (1 - x * x) / 2, -(1 - x) * y],
      ];
    }
  }
  throw new Error(`Face do tipo Gmsh ${type} sem funções de forma`);
}

const G3 = [[-Math.sqrt(0.6), 5 / 9], [0, 8 / 9], [Math.sqrt(0.6), 5 / 9]];
const TA = 0.445948490915965, TB = 0.091576213509771, WA = 0.223381589678011 / 2, WB = 0.109951743655322 / 2;
/** Regras de Gauss: quadrilátero 3×3 e triângulo de 6 pontos (grau 4), [ξ, η, peso]. */
const GAUSS: Record<"tri" | "quad", [number, number, number][]> = {
  quad: G3.flatMap(([a, wa]) => G3.map(([b, wb]) => [a, b, wa * wb] as [number, number, number])),
  tri: [[TA, TA, WA], [1 - 2 * TA, TA, WA], [TA, 1 - 2 * TA, WA], [TB, TB, WB], [1 - 2 * TB, TB, WB], [TB, 1 - 2 * TB, WB]],
};

/**
 * Integrais de uma face (nós pela ordem Gmsh): área, área nodal consistente ∫Nᵢ dA (a fração de uma
 * tração uniforme que vai para cada nó) e vetor área nodal ∫Nᵢ n dA (pressão), com a normal pela
 * regra da mão direita na ordem dos nós. Exato nas faces planas; isoparamétrico nas curvas.
 */
export function faceIntegrals(type: number, pts: P3[]): { area: number; nodal: number[]; vec: P3[] } {
  const ft = FACES[type];
  if (type === 2) {
    // triângulo linear: exato
    const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])), area = Math.hypot(n[0], n[1], n[2]) / 2;
    const v: P3 = [n[0] / 6, n[1] / 6, n[2] / 6];
    return { area, nodal: [area / 3, area / 3, area / 3], vec: [v, [...v], [...v]] };
  }
  const nodal = new Array(ft.nodes).fill(0), vec: P3[] = Array.from({ length: ft.nodes }, () => [0, 0, 0]);
  let area = 0;
  for (const [x, y, w] of GAUSS[ft.kind]) {
    const [Dx, Dy] = dshape(type, x, y);
    const dx: P3 = [0, 0, 0], dy: P3 = [0, 0, 0];
    pts.forEach((p, i) => { for (let k = 0; k < 3; k++) { dx[k] += Dx[i] * p[k]; dy[k] += Dy[i] * p[k]; } });
    const n = cross(dx, dy);
    const J = Math.hypot(n[0], n[1], n[2]);
    area += w * J;
    shape(type, x, y).forEach((Ni, i) => {
      nodal[i] += w * Ni * J;
      for (let k = 0; k < 3; k++) vec[i][k] += w * Ni * n[k];
    });
  }
  return { area, nodal, vec };
}
