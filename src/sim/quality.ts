// Qualidade da malha de volume (verificação ao estilo do "Verify Mesh" do Abaqus/CAE e do "Element
// Quality" do Femap): jacobiano escalado, razão de aspeto, ângulos das faces, empeno das faces
// quadriláteras e fator de forma dos tetraedros, com estatísticas, histogramas, elementos fora dos
// limites e os piores elementos. Puro: corre no agente e na aplicação. Usa só os nós de canto.
import { type Msh, elementsOf, NODES_PER, shellBlocks, solidBlocks } from "./msh.ts";
import { SOLIDS } from "./elements.ts";

type P3 = [number, number, number];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (u: P3, v: P3): P3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);

/** Vizinhos de cada canto (3 arestas em sentido direto): hexaedro e tetraedro (numeração Gmsh = Abaqus). */
const HEX_CORNERS = [[1, 3, 4], [2, 0, 5], [3, 1, 6], [0, 2, 7], [7, 5, 0], [4, 6, 1], [5, 7, 2], [6, 4, 3]];
const TET_CORNERS = [[1, 2, 3], [2, 0, 3], [0, 1, 3], [2, 1, 0]];
const HEX_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const TET_EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];

export interface QualityLimit {
  /** Limite inferior/superior aceitável (fora dele o elemento é assinalado). */
  min?: number;
  max?: number;
  /** "error": o solver pode falhar ou dar resultados errados; "warning": precisão reduzida. */
  level: "error" | "warning";
}

export interface QualityMetric {
  key: "sj" | "ar" | "minAngle" | "maxAngle" | "warp" | "shape";
  label: string;
  unit: string;
  /** Só para alguns elementos (ex.: empeno nos hexaedros, fator de forma nos tetraedros). */
  applies: "all" | "hex" | "tet";
  count: number;
  min: number;
  max: number;
  mean: number;
  limits: QualityLimit[];
  /** Elementos fora de cada limite (pela ordem de `limits`). */
  fail: number[];
  hist: { edges: number[]; counts: number[] };
}

export interface MeshQuality {
  elements: number;
  nodes: number;
  /** Elementos por tipo ("hex8", "hex20", "tet4", "tet10"; casca "tri3", "tri6"). */
  types: Record<string, number>;
  /** Volume da malha (cantos; mm³). */
  volume: number;
  metrics: QualityMetric[];
  /** Jacobiano escalado por elemento (pela ordem de `elementsOf(solidBlocks)`), para colorir. */
  perElement: number[];
  /** Razão de aspeto por elemento (mesma ordem de perElement). */
  perElementAr: number[];
  /** Piores elementos pelo jacobiano escalado: n.º (1…), valor e centro (mm). */
  worst: { element: number; sj: number; ar: number; center: P3 }[];
  ok: boolean;
  notes: string[];
}

/** O que segue para o browser: sem os valores por elemento (já vão, por vértice, na vista da malha). */
export type MeshReport = Omit<MeshQuality, "perElement" | "perElementAr">;

/** Limites por omissão: os do Verify Mesh do Abaqus/CAE para ângulos, razão de aspeto e fator de forma; jacobiano e empeno como no Femap/NX. */
export const QUALITY_LIMITS: Record<QualityMetric["key"], QualityLimit[] | { hex: QualityLimit[]; tet: QualityLimit[] }> = {
  sj: [{ min: 0, level: "error" }, { min: 0.2, level: "warning" }],
  ar: [{ max: 10, level: "warning" }],
  minAngle: { hex: [{ min: 10, level: "warning" }], tet: [{ min: 5, level: "warning" }] },
  maxAngle: { hex: [{ max: 160, level: "warning" }], tet: [{ max: 170, level: "warning" }] },
  warp: [{ max: 10, level: "warning" }],
  shape: [{ min: 1e-4, level: "warning" }],
};

/** Um limite do avaliador de malha, com a fonte (a citar na sugestão). */
export interface AdvisorLimit { value: number; source: string }

/**
 * Limites do avaliador de malha (C9a). Cada um diz de onde vem; onde não há norma, diz-se que é
 * regra prática do GALCAD (configurável), em vez de a apresentar como limite de uma fonte.
 */
export const ADVISOR_LIMITS = {
  /** Ângulo máximo de arco por elemento (graus) antes de sugerir refinar. */
  arcMaxDeg: { value: 20, source: "regra prática do GALCAD (15–20° por elemento num arco); o Gmsh por omissão usa 12 elementos por volta, 30°" },
  /** Ângulo-alvo por elemento ao refinar um arco (graus). */
  arcTargetDeg: { value: 15, source: "regra prática do GALCAD (15–20° por elemento num arco)" },
  /** Elementos na espessura de zonas finas, por ordem do elemento. */
  thickness: {
    1: { value: 4, source: "Getting Started with Abaqus: elementos lineares de integração reduzida precisam de pelo menos 4 elementos na espessura em flexão (hourglass)" },
    2: { value: 2, source: "regra prática do GALCAD para elementos quadráticos em flexão (configurável)" },
  } as Record<1 | 2, AdvisorLimit>,
  /** Aresta minúscula: comprimento abaixo desta fração do tamanho de elemento. */
  tinyEdgeRatio: { value: 0.1, source: "regra prática do GALCAD (aresta < 10 % do tamanho de elemento força elementos distorcidos à volta)" },
  /** Curvatura (elementos por volta) a sugerir para arcos grosseiros: 360°/24 = 15°. */
  curvatureSuggest: { value: 24, source: "360° / 15° por elemento" },
  /** Jacobiano escalado a partir do qual o elemento está invertido (erro). */
  invertedSj: { value: 0, source: "Femap/NX e Verify Mesh do Abaqus/CAE: jacobiano escalado ≤ 0 = elemento invertido (QUALITY_LIMITS.sj)" },
  /** Primeiro elemento junto a uma aresta minúscula: até este múltiplo do comprimento dela. */
  tinyGrade: { value: 5, source: "regra prática do GALCAD (transição gradual até à aresta minúscula, razão de crescimento ≤ 1,5 por elemento como alvo)" },
} as const;

// Núcleo escalar, sem alocações por elemento: a malha ao vivo mede centenas de milhares de elementos
// em cada alteração. Os cantos do elemento em curso ficam em X (x0 y0 z0 x1 …) e o resultado em Q.
const X = new Float64Array(24);
let cx = 0, cy = 0, cz = 0;
const Q = { sj: 0, ar: 0, minAngle: 0, maxAngle: 0, warp: 0, shape: 0, volume: 0 };
const norm = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
/** (Pb − Pa) × (Pc − Pa) → cx, cy, cz. */
function crossAt(a: number, b: number, c: number): void {
  const a3 = 3 * a, b3 = 3 * b, c3 = 3 * c;
  const ux = X[b3] - X[a3], uy = X[b3 + 1] - X[a3 + 1], uz = X[b3 + 2] - X[a3 + 2];
  const vx = X[c3] - X[a3], vy = X[c3 + 1] - X[a3 + 1], vz = X[c3 + 2] - X[a3 + 2];
  cx = uy * vz - uz * vy; cy = uz * vx - ux * vz; cz = ux * vy - uy * vx;
}
const dist = (a: number, b: number) => norm(X[3 * b] - X[3 * a], X[3 * b + 1] - X[3 * a + 1], X[3 * b + 2] - X[3 * a + 2]);
/** (Pb − Pa) × (Pc − Pa) · (Pd − Pa). */
function triple(a: number, b: number, c: number, d: number): number {
  crossAt(a, b, c);
  const a3 = 3 * a, d3 = 3 * d;
  return cx * (X[d3] - X[a3]) + cy * (X[d3 + 1] - X[a3 + 1]) + cz * (X[d3 + 2] - X[a3 + 2]);
}
const vecAngle = (ux: number, uy: number, uz: number, vx: number, vy: number, vz: number) =>
  (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (norm(ux, uy, uz) * norm(vx, vy, vz) || 1)))) * 180) / Math.PI;
/** Ângulo no canto i entre Pp − Pi e Pn − Pi. */
function cornerAngle(i: number, p: number, n: number): number {
  const i3 = 3 * i, p3 = 3 * p, n3 = 3 * n;
  return vecAngle(X[p3] - X[i3], X[p3 + 1] - X[i3 + 1], X[p3 + 2] - X[i3 + 2], X[n3] - X[i3], X[n3 + 1] - X[i3 + 1], X[n3 + 2] - X[i3 + 2]);
}
const HEX_TETS = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];

/** Medidas do sólido em X (hexaedro: 8 cantos; tetraedro: 4) para Q (empeno só no hexaedro, forma só no tetraedro). */
function measureSolid(hex: boolean): void {
  // jacobiano escalado: det das 3 arestas de cada canto / produto dos comprimentos (cubo/tetraedro regular = 1)
  const C = hex ? HEX_CORNERS : TET_CORNERS;
  let sj = Infinity;
  for (let i = 0; i < C.length; i++) {
    const [j, k, l] = C[i];
    const d = triple(i, j, k, l) / (dist(i, j) * dist(i, k) * dist(i, l) || 1);
    const s = hex ? d : Math.min(1, d * Math.SQRT2);
    if (s < sj) sj = s;
  }
  let minE = Infinity, maxE = -Infinity;
  for (const [a, b] of hex ? HEX_EDGES : TET_EDGES) { const e = dist(a, b); if (e < minE) minE = e; if (e > maxE) maxE = e; }
  const faces = SOLIDS[hex ? 5 : 4].faces;
  let minAngle = 180, maxAngle = 0, warp = 0, maxArea = -Infinity;
  for (const f of faces) {
    const n = f.length;
    for (let i = 0; i < n; i++) {
      const a = cornerAngle(f[i], f[(i + n - 1) % n], f[(i + 1) % n]);
      if (a < minAngle) minAngle = a;
      if (a > maxAngle) maxAngle = a;
    }
    if (n === 4) {
      // empeno: ângulo entre as normais dos dois triângulos, pelas duas diagonais (o maior)
      crossAt(f[0], f[1], f[2]); let ux = cx, uy = cy, uz = cz;
      crossAt(f[0], f[2], f[3]);
      const w1 = vecAngle(ux, uy, uz, cx, cy, cz);
      crossAt(f[1], f[2], f[3]); ux = cx; uy = cy; uz = cz;
      crossAt(f[1], f[3], f[0]);
      const w2 = vecAngle(ux, uy, uz, cx, cy, cz);
      if (w1 > warp) warp = w1;
      if (w2 > warp) warp = w2;
    } else if (!hex) {
      crossAt(f[0], f[1], f[2]);
      const area = norm(cx, cy, cz) / 2;
      if (area > maxArea) maxArea = area;
    }
  }
  Q.sj = sj; Q.minAngle = minAngle; Q.maxAngle = maxAngle;
  if (hex) {
    // volume do hexaedro: 6 tetraedros pela diagonal 0-6
    let volume = 0;
    for (const [a, b, c, d] of HEX_TETS) volume += triple(a, b, c, d) / 6;
    Q.ar = maxE / minE; Q.warp = warp; Q.volume = volume;
    return;
  }
  const volume = triple(0, 1, 2, 3) / 6, V = Math.abs(volume);
  // razão de aspeto do tetraedro: maior aresta / menor altura, normalizada (regular = 1)
  const hmin = (3 * V) / maxArea;
  Q.ar = (maxE / (hmin || 1e-300)) * Math.sqrt(2 / 3);
  // fator de forma (Abaqus): volume / volume do tetraedro regular com o mesmo raio da esfera circunscrita
  const ax = X[3] - X[0], ay = X[4] - X[1], az = X[5] - X[2];
  const bx = X[6] - X[0], by = X[7] - X[1], bz = X[8] - X[2];
  const ex = X[9] - X[0], ey = X[10] - X[1], ez = X[11] - X[2];
  const aa = ax * ax + ay * ay + az * az, bb = bx * bx + by * by + bz * bz, ee = ex * ex + ey * ey + ez * ez;
  const nx = (by * ez - bz * ey) * aa + (ey * az - ez * ay) * bb + (ay * bz - az * by) * ee;
  const ny = (bz * ex - bx * ez) * aa + (ez * ax - ex * az) * bb + (az * bx - ax * bz) * ee;
  const nz = (bx * ey - by * ex) * aa + (ex * ay - ey * ax) * bb + (ax * by - ay * bx) * ee;
  const R = norm(nx, ny, nz) / (12 * V || 1e-300);
  Q.shape = V / ((8 * Math.sqrt(3) * R ** 3) / 27);
  Q.volume = volume;
}

/** Medidas do triângulo em X para Q (a área fica em Q.volume). */
function measureTri(): void {
  crossAt(0, 1, 2);
  const a2 = norm(cx, cy, cz);
  const L0 = dist(0, 1), L1 = dist(1, 2), L2 = dist(2, 0);
  const s = Math.min(a2 / (L0 * L2 || 1), a2 / (L0 * L1 || 1), a2 / (L1 * L2 || 1));
  let minAngle = Infinity, maxAngle = -Infinity;
  for (let i = 0; i < 3; i++) { const a = cornerAngle(i, (i + 1) % 3, (i + 2) % 3); if (a < minAngle) minAngle = a; if (a > maxAngle) maxAngle = a; }
  const maxL = Math.max(L0, L1, L2), hmin = a2 / maxL;
  Q.sj = s / (Math.sqrt(3) / 2); Q.ar = hmin > 0 ? (maxL / hmin) * (Math.sqrt(3) / 2) : 1e6;
  Q.minAngle = minAngle; Q.maxAngle = maxAngle; Q.volume = a2 / 2;
}

function loadPoints(P: P3[], n: number): void {
  for (let k = 0; k < n; k++) { X[3 * k] = P[k][0]; X[3 * k + 1] = P[k][1]; X[3 * k + 2] = P[k][2]; }
}

/** Medidas de um elemento pelos cantos. */
export function elementQuality(kind: "hex" | "tet", P: P3[]): { sj: number; ar: number; minAngle: number; maxAngle: number; warp?: number; shape?: number; volume: number } {
  const hex = kind === "hex";
  loadPoints(P, hex ? 8 : 4);
  measureSolid(hex);
  return hex
    ? { sj: Q.sj, ar: Q.ar, minAngle: Q.minAngle, maxAngle: Q.maxAngle, warp: Q.warp, volume: Q.volume }
    : { sj: Q.sj, ar: Q.ar, minAngle: Q.minAngle, maxAngle: Q.maxAngle, shape: Q.shape, volume: Q.volume };
}

const LABELS: Record<QualityMetric["key"], [string, string, QualityMetric["applies"]]> = {
  sj: ["Jacobiano escalado", "", "all"],
  ar: ["Razão de aspeto", "", "all"],
  minAngle: ["Menor ângulo das faces", "°", "all"],
  maxAngle: ["Maior ângulo das faces", "°", "all"],
  warp: ["Empeno das faces", "°", "hex"],
  shape: ["Fator de forma (tetraedros)", "", "tet"],
};

/**
 * Medidas de um triângulo de casca pelos cantos (sem sinal: a casca não tem lado de dentro): jacobiano
 * escalado = menor seno dos cantos / sen 60° (1 no equilátero), razão de aspeto = maior aresta / menor
 * altura · √3/2 (1 no equilátero), ângulos e área.
 */
export function triangleQuality(P: P3[]): { sj: number; ar: number; minAngle: number; maxAngle: number; area: number } {
  loadPoints(P, 3); measureTri();
  return { sj: Q.sj, ar: Q.ar, minAngle: Q.minAngle, maxAngle: Q.maxAngle, area: Q.volume };
}

/**
 * Qualidade de toda a malha do caso: volume (grupos SOLID ou B1, B2, …) ou, com `shell`, os triângulos
 * do grupo SHELL (limites dos tetraedros nos ângulos; `volume` passa a ser a área, mm²).
 */
export function meshQuality(m: Msh, bodies?: { group: string }[], shell = false): MeshQuality {
  // sem alocações por elemento: coordenadas num Float64Array indexado pela etiqueta do nó, valores das
  // medidas em Float64Array e o tipo (0 = hexaedro, 1 = tetraedro) em Uint8Array
  const blocks = shell ? shellBlocks(m) : solidBlocks(m, bodies);
  let total = 0;
  for (const b of blocks) total += b.conn.length / NODES_PER[b.type];
  let maxTag = 0;
  for (const t of m.nodes.keys()) if (t > maxTag) maxTag = t;
  const XYZ = new Float64Array(3 * (maxTag + 1));
  for (const [t, p] of m.nodes) { XYZ[3 * t] = p[0]; XYZ[3 * t + 1] = p[1]; XYZ[3 * t + 2] = p[2]; }
  const used = new Uint8Array(maxTag + 1);
  let nUsed = 0;
  const KEYS = ["sj", "ar", "minAngle", "maxAngle", "warp", "shape"] as const;
  const val = KEYS.map(() => new Float64Array(total)), kindOf = KEYS.map(() => new Uint8Array(total)), cnt = KEYS.map(() => 0);
  const push = (k: number, v: number, kind: number) => { val[k][cnt[k]] = v; kindOf[k][cnt[k]++] = kind; };
  const types: Record<string, number> = {};
  const perElement: number[] = new Array(total), perElementAr: number[] = new Array(total);
  const worst: MeshQuality["worst"] = [];
  let volume = 0, i = 0;
  for (const b of blocks) {
    const per = NODES_PER[b.type], n = b.conn.length / per;
    let key: string, nc: number, kind: number;
    if (shell) { key = b.type === 9 ? "tri6" : "tri3"; nc = 3; kind = 1; }
    else { const st = SOLIDS[b.type]; key = `${st.kind}${st.nodes}`; nc = st.corners; kind = st.kind === "hex" ? 0 : 1; }
    if (n === 0) continue;
    types[key] = (types[key] ?? 0) + n;
    const conn = b.conn;
    for (let base = 0; base < conn.length; base += per, i++) {
      for (let k = 0; k < per; k++) { const t = conn[base + k]; if (!used[t]) { used[t] = 1; nUsed++; } }
      for (let k = 0; k < nc; k++) { const t3 = 3 * conn[base + k]; X[3 * k] = XYZ[t3]; X[3 * k + 1] = XYZ[t3 + 1]; X[3 * k + 2] = XYZ[t3 + 2]; }
      if (shell) measureTri(); else measureSolid(kind === 0);
      volume += Q.volume;
      push(0, Q.sj, kind); push(1, Q.ar, kind); push(2, Q.minAngle, kind); push(3, Q.maxAngle, kind);
      if (!shell) { if (kind === 0) push(4, Q.warp, kind); else push(5, Q.shape, kind); }
      perElement[i] = Q.sj; perElementAr[i] = Q.ar;
      // 10 piores pelo jacobiano (ordenação estável: empates ficam pela ordem dos elementos)
      let pos = worst.length;
      while (pos > 0 && worst[pos - 1].sj > Q.sj) pos--;
      if (pos < 10) {
        let sx = 0, sy = 0, sz = 0;
        for (let k = 0; k < nc; k++) { sx += X[3 * k]; sy += X[3 * k + 1]; sz += X[3 * k + 2]; }
        worst.splice(pos, 0, { element: i + 1, sj: Q.sj, ar: Q.ar, center: [sx / nc, sy / nc, sz / nc] });
        if (worst.length > 10) worst.pop();
      }
    }
  }
  const metrics: QualityMetric[] = [];
  let errors = 0;
  KEYS.forEach((key, ki) => {
    const count = cnt[ki];
    if (!count) return;
    const v = val[ki], kd = kindOf[ki];
    const [label, unit, applies] = LABELS[key];
    const L = QUALITY_LIMITS[key];
    const limitsOf = (kind: "hex" | "tet") => (Array.isArray(L) ? L : L[kind]);
    let hasHex = false, hasTet = false;
    for (let j = 0; j < count; j++) if (kd[j]) hasTet = true; else hasHex = true;
    const limits = hasHex !== hasTet ? limitsOf(hasTet ? "tet" : "hex") : limitsOf("hex");
    const LH = limitsOf("hex"), LT = limitsOf("tet");
    const fail = limits.map(() => 0);
    let min = Infinity, max = -Infinity, sum = 0;
    for (let j = 0; j < count; j++) {
      const x = v[j];
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
      const LK = kd[j] ? LT : LH;
      for (let li = 0; li < limits.length; li++) {
        const l = LK[li];
        if (l && ((l.min !== undefined && x < l.min) || (l.max !== undefined && x > l.max))) fail[li]++;
      }
    }
    limits.forEach((l, li) => { if (l.level === "error") errors += fail[li]; });
    // histograma de 10 classes (jacobiano e ângulos em gamas fixas, para comparar malhas)
    const range: [number, number] = key === "sj" ? [Math.min(0, min), 1] : key === "minAngle" || key === "maxAngle" ? [0, 180] : key === "shape" ? [0, 1] : [Math.min(min, 1), Math.max(max, 1 + 1e-9)];
    const r0 = range[0], span = range[1] - range[0];
    const edges = Array.from({ length: 11 }, (_, e) => r0 + (span * e) / 10);
    const counts = new Array(10).fill(0);
    for (let j = 0; j < count; j++) counts[Math.min(9, Math.max(0, Math.floor(((v[j] - r0) / (span || 1)) * 10)))]++;
    metrics.push({ key, label, unit, applies, count, min, max, mean: sum / count, limits, fail, hist: { edges, counts } });
  });
  const notes: string[] = [];
  if (errors) notes.push(`${errors} elemento(s) invertido(s) ou degenerado(s) (jacobiano ≤ 0): o cálculo não é fiável — refaça a malha`);
  const warn = metrics.reduce((s, x) => s + x.limits.reduce((t, l, li) => t + (l.level === "warning" ? x.fail[li] : 0), 0), 0);
  if (warn) notes.push(`${warn} assinalamento(s) de qualidade (elementos distorcidos): confirme se estão em zonas que importam para o resultado`);
  return { elements: total, nodes: nUsed, types, volume, metrics, perElement, perElementAr, worst, ok: errors === 0, notes };
}

/**
 * Passo de tempo estável do explícito (diferenças centrais), com margem: 0,35·Lc/cd, Lc = V/Amáx
 * (hexaedros) ou a menor altura 3V/Amáx (tetraedros), metade nos elementos quadráticos; cd =
 * √(E(1−ν)/(ρ(1+ν)(1−2ν))) em mm/s (E em MPa, ρ em g/cm³). Abaixo do limite que o CalculiX calcula,
 * para não ativar o escalamento seletivo de massa.
 */
export function stableIncrement(m: Msh, materials: { group: string; E: number; nu: number; density: number }[]): { dt: number; element: number; lc: number } {
  let best = { dt: Infinity, element: 0, lc: 0 };
  let el = 0;
  for (const mat of materials) {
    const rho = mat.density * 1e-9;
    const cd = Math.sqrt((mat.E * (1 - mat.nu)) / (rho * (1 + mat.nu) * (1 - 2 * mat.nu)));
    for (const e of elementsOf(solidBlocks(m, [{ group: mat.group }]))) {
      el++;
      const st = SOLIDS[e.type];
      const P = e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n)!) as P3[];
      const V = Math.abs(elementQuality(st.kind, P).volume);
      const Amax = Math.max(...st.faces.map((f) => (f.length === 3 ? len(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]))) / 2 : len(cross(sub(P[f[2]], P[f[0]]), sub(P[f[3]], P[f[1]]))) / 2)));
      const lc = ((st.kind === "tet" ? 3 : 1) * V) / (Amax || 1e-300) * (st.order === 2 ? 0.5 : 1);
      const dt = (0.35 * lc) / cd;
      if (dt < best.dt) best = { dt, element: el, lc };
    }
  }
  return best;
}

/**
 * Passo estável do explícito numa casca (S3/S6): 0,35·Lc/c com Lc a menor altura do triângulo
 * (metade nos quadráticos) e c = √(E/(ρ(1−ν²))) a velocidade das ondas de membrana em mm/s; num
 * laminado, E é o maior módulo das camadas (a direção mais rápida manda no passo).
 */
export function stableIncrementShell(m: Msh, mat: { E: number; nu: number; density: number }): { dt: number; element: number; lc: number } {
  let best = { dt: Infinity, element: 0, lc: 0 };
  let el = 0;
  const c = Math.sqrt(mat.E / (mat.density * 1e-9 * (1 - mat.nu * mat.nu)));
  for (const e of elementsOf(shellBlocks(m))) {
    el++;
    const P = e.nodes.slice(0, 3).map((n) => m.nodes.get(n)!) as P3[];
    const A = len(cross(sub(P[1], P[0]), sub(P[2], P[0]))) / 2;
    const hmax = Math.max(len(sub(P[1], P[0])), len(sub(P[2], P[1])), len(sub(P[0], P[2])));
    const lc = ((2 * A) / (hmax || 1e-300)) * (e.type === 9 ? 0.5 : 1);
    const dt = (0.35 * lc) / c;
    if (dt < best.dt) best = { dt, element: el, lc };
  }
  return best;
}

/** Elementos fora de um limite estimados pelo histograma (para limites escolhidos na UI, sem recalcular a
 *  malha): conta os intervalos cujo centro viola o limite. Exato quando o limite cai numa fronteira de intervalo. */
export function failFromHist(hist: { edges: number[]; counts: number[] }, limit: { min?: number; max?: number }): number {
  let n = 0;
  hist.counts.forEach((c, i) => {
    const mid = (hist.edges[i] + hist.edges[i + 1]) / 2;
    if ((limit.min !== undefined && mid < limit.min) || (limit.max !== undefined && mid > limit.max)) n += c;
  });
  return n;
}
