// Qualidade da malha de volume (verificação ao estilo do "Verify Mesh" do Abaqus/CAE e do "Element
// Quality" do Femap): jacobiano escalado, razão de aspeto, ângulos das faces, empeno das faces
// quadriláteras e fator de forma dos tetraedros, com estatísticas, histogramas, elementos fora dos
// limites e os piores elementos. Puro: corre no agente e na aplicação. Usa só os nós de canto.
import { type Msh, elementsOf, solidBlocks } from "./msh.ts";
import { SOLIDS } from "./elements.ts";

type P3 = [number, number, number];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (u: P3, v: P3): P3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const angle = (u: P3, v: P3) => (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v) || 1)))) * 180) / Math.PI;

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
  /** Elementos por tipo ("hex8", "hex20", "tet4", "tet10"). */
  types: Record<string, number>;
  /** Volume da malha (cantos; mm³). */
  volume: number;
  metrics: QualityMetric[];
  /** Jacobiano escalado por elemento (pela ordem de `elementsOf(solidBlocks)`), para colorir. */
  perElement: number[];
  /** Piores elementos pelo jacobiano escalado: n.º (1…), valor e centro (mm). */
  worst: { element: number; sj: number; ar: number; center: P3 }[];
  ok: boolean;
  notes: string[];
}

/** Limites por omissão: os do Verify Mesh do Abaqus/CAE para ângulos, razão de aspeto e fator de forma; jacobiano e empeno como no Femap/NX. */
export const QUALITY_LIMITS: Record<QualityMetric["key"], QualityLimit[] | { hex: QualityLimit[]; tet: QualityLimit[] }> = {
  sj: [{ min: 0, level: "error" }, { min: 0.2, level: "warning" }],
  ar: [{ max: 10, level: "warning" }],
  minAngle: { hex: [{ min: 10, level: "warning" }], tet: [{ min: 5, level: "warning" }] },
  maxAngle: { hex: [{ max: 160, level: "warning" }], tet: [{ max: 170, level: "warning" }] },
  warp: [{ max: 10, level: "warning" }],
  shape: [{ min: 1e-4, level: "warning" }],
};

/** Medidas de um elemento pelos cantos. */
export function elementQuality(kind: "hex" | "tet", P: P3[]): { sj: number; ar: number; minAngle: number; maxAngle: number; warp?: number; shape?: number; volume: number } {
  const hex = kind === "hex";
  // jacobiano escalado: det das 3 arestas de cada canto / produto dos comprimentos (cubo/tetraedro regular = 1)
  const sjs = (hex ? HEX_CORNERS : TET_CORNERS).map((nb, i) => {
    const e = nb.map((j) => sub(P[j], P[i]));
    const d = dot(cross(e[0], e[1]), e[2]) / (len(e[0]) * len(e[1]) * len(e[2]) || 1);
    return hex ? d : Math.min(1, d * Math.SQRT2);
  });
  const sj = Math.min(...sjs);
  const el = (hex ? HEX_EDGES : TET_EDGES).map(([a, b]) => len(sub(P[a], P[b])));
  const faces = SOLIDS[hex ? 5 : 4].faces;
  let minAngle = 180, maxAngle = 0, warp = 0;
  for (const f of faces) {
    const n = f.length;
    for (let i = 0; i < n; i++) {
      const a = angle(sub(P[f[(i + n - 1) % n]], P[f[i]]), sub(P[f[(i + 1) % n]], P[f[i]]));
      minAngle = Math.min(minAngle, a); maxAngle = Math.max(maxAngle, a);
    }
    if (n === 4) {
      // empeno: ângulo entre as normais dos dois triângulos, pelas duas diagonais (o maior)
      const w1 = angle(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]])), cross(sub(P[f[2]], P[f[0]]), sub(P[f[3]], P[f[0]])));
      const w2 = angle(cross(sub(P[f[2]], P[f[1]]), sub(P[f[3]], P[f[1]])), cross(sub(P[f[3]], P[f[1]]), sub(P[f[0]], P[f[1]])));
      warp = Math.max(warp, w1, w2);
    }
  }
  if (hex) {
    // volume do hexaedro: 6 tetraedros pela diagonal 0-6
    const tets = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
    const volume = tets.reduce((s, [a, b, c, d]) => s + dot(cross(sub(P[b], P[a]), sub(P[c], P[a])), sub(P[d], P[a])) / 6, 0);
    return { sj, ar: Math.max(...el) / Math.min(...el), minAngle, maxAngle, warp, volume };
  }
  const volume = dot(cross(sub(P[1], P[0]), sub(P[2], P[0])), sub(P[3], P[0])) / 6;
  // razão de aspeto do tetraedro: maior aresta / menor altura, normalizada (regular = 1)
  const areas = faces.map((f) => len(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]))) / 2);
  const hmin = (3 * Math.abs(volume)) / Math.max(...areas);
  const ar = (Math.max(...el) / (hmin || 1e-300)) * Math.sqrt(2 / 3);
  // fator de forma (Abaqus): volume / volume do tetraedro regular com o mesmo raio da esfera circunscrita
  const a = sub(P[1], P[0]), b = sub(P[2], P[0]), c = sub(P[3], P[0]);
  const num = [cross(b, c), cross(c, a), cross(a, b)].reduce((s, v, k) => [s[0] + v[0] * [dot(a, a), dot(b, b), dot(c, c)][k], s[1] + v[1] * [dot(a, a), dot(b, b), dot(c, c)][k], s[2] + v[2] * [dot(a, a), dot(b, b), dot(c, c)][k]] as P3, [0, 0, 0] as P3);
  const R = len(num) / (12 * Math.abs(volume) || 1e-300);
  const shape = Math.abs(volume) / ((8 * Math.sqrt(3) * R ** 3) / 27);
  return { sj, ar, minAngle, maxAngle, shape, volume };
}

const LABELS: Record<QualityMetric["key"], [string, string, QualityMetric["applies"]]> = {
  sj: ["Jacobiano escalado", "", "all"],
  ar: ["Razão de aspeto", "", "all"],
  minAngle: ["Menor ângulo das faces", "°", "all"],
  maxAngle: ["Maior ângulo das faces", "°", "all"],
  warp: ["Empeno das faces", "°", "hex"],
  shape: ["Fator de forma (tetraedros)", "", "tet"],
};

/** Qualidade de toda a malha de volume do caso (grupos SOLID ou B1, B2, …). */
export function meshQuality(m: Msh, bodies?: { group: string }[]): MeshQuality {
  const types: Record<string, number> = {};
  const vals: Record<QualityMetric["key"], { v: number; kind: "hex" | "tet" }[]> = { sj: [], ar: [], minAngle: [], maxAngle: [], warp: [], shape: [] };
  const perElement: number[] = [];
  const info: { sj: number; ar: number; center: P3 }[] = [];
  const used = new Set<number>();
  let volume = 0;
  for (const e of elementsOf(solidBlocks(m, bodies))) {
    const st = SOLIDS[e.type];
    types[`${st.kind}${st.nodes}`] = (types[`${st.kind}${st.nodes}`] ?? 0) + 1;
    e.nodes.forEach((n) => used.add(n));
    const P = e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n)!) as P3[];
    const q = elementQuality(st.kind, P);
    volume += q.volume;
    for (const k of Object.keys(vals) as QualityMetric["key"][]) { const v = q[k]; if (v !== undefined) vals[k].push({ v, kind: st.kind }); }
    perElement.push(q.sj);
    info.push({ sj: q.sj, ar: q.ar, center: [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / P.length) as P3 });
  }
  const metrics: QualityMetric[] = [];
  let errors = 0;
  for (const key of Object.keys(vals) as QualityMetric["key"][]) {
    const list = vals[key];
    if (!list.length) continue;
    const [label, unit, applies] = LABELS[key];
    const L = QUALITY_LIMITS[key];
    const limitsOf = (kind: "hex" | "tet") => (Array.isArray(L) ? L : L[kind]);
    const kinds = [...new Set(list.map((x) => x.kind))];
    const limits = kinds.length === 1 ? limitsOf(kinds[0]) : limitsOf("hex");
    const fail = limits.map((_, i) => list.filter((x) => { const l = limitsOf(x.kind)[i]; return l && ((l.min !== undefined && x.v < l.min) || (l.max !== undefined && x.v > l.max)); }).length);
    limits.forEach((l, i) => { if (l.level === "error") errors += fail[i]; });
    const v = list.map((x) => x.v);
    const min = Math.min(...v), max = Math.max(...v);
    // histograma de 10 classes (jacobiano e ângulos em gamas fixas, para comparar malhas)
    const range: [number, number] = key === "sj" ? [Math.min(0, min), 1] : key === "minAngle" || key === "maxAngle" ? [0, 180] : key === "shape" ? [0, 1] : [Math.min(min, 1), Math.max(max, 1 + 1e-9)];
    const edges = Array.from({ length: 11 }, (_, i) => range[0] + ((range[1] - range[0]) * i) / 10);
    const counts = new Array(10).fill(0);
    for (const x of v) counts[Math.min(9, Math.max(0, Math.floor(((x - range[0]) / (range[1] - range[0] || 1)) * 10)))]++;
    metrics.push({ key, label, unit, applies, count: v.length, min, max, mean: v.reduce((a, b) => a + b, 0) / v.length, limits, fail, hist: { edges, counts } });
  }
  const worst = info.map((x, i) => ({ element: i + 1, ...x })).sort((a, b) => a.sj - b.sj).slice(0, 10);
  const notes: string[] = [];
  if (errors) notes.push(`${errors} elemento(s) invertido(s) ou degenerado(s) (jacobiano ≤ 0): o cálculo não é fiável — refaça a malha`);
  const warn = metrics.reduce((s, x) => s + x.limits.reduce((t, l, i) => t + (l.level === "warning" ? x.fail[i] : 0), 0), 0);
  if (warn) notes.push(`${warn} assinalamento(s) de qualidade (elementos distorcidos): confirme se estão em zonas que importam para o resultado`);
  return { elements: perElement.length, nodes: used.size, types, volume, metrics, perElement, worst, ok: errors === 0, notes };
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
