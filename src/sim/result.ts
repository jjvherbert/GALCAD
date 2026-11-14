// Vista de resultados neutra (FEM e CFD): camadas de triângulos (superfície da peça, patches,
// cortes) com valores nodais por campo e, nas estruturas, deformadas por modo. É o que o visualizador
// e a legenda consomem, independentemente do solver. Puro.
import type { FemResult } from "./calculix.ts";

export interface ResultLayer {
  name: string;
  /** Visível ao abrir o resultado. */
  visible: boolean;
  /** Vértices (mm) e triângulos (índices). */
  positions: number[];
  triangles: number[];
  /** Valores por vértice, alinhados com `ResultView.fields` (null = campo sem significado nesta camada). */
  values: (number[] | null)[];
  /** Deslocamentos por vértice (mm), alinhados com `ResultView.modes`. */
  displacements?: number[][];
  /** Arestas da malha a desenhar (pares de índices de vértices): pré-visualização da malha. */
  edges?: number[];
}

export interface ResultView {
  /** `reverse`: escala invertida (valores baixos são os críticos, ex.: fator de segurança). */
  fields: { name: string; unit: string; reverse?: boolean }[];
  /** Rótulos das deformadas (estática: "Deformada"; modal/encurvadura: um por modo). */
  modes: string[];
  layers: ResultLayer[];
}

/** Resultado FEM como uma camada única (superfície exterior da malha). */
export function femView(r: FemResult): ResultView {
  return {
    fields: r.fields.map((f) => ({ name: f.name, unit: f.unit, ...(f.reverse ? { reverse: true } : {}) })),
    modes: r.displacements.map((d) => d.label),
    layers: [{ name: "Peça", visible: true, positions: r.positions, triangles: r.triangles, values: r.fields.map((f) => f.values), displacements: r.displacements.map((d) => d.values) }],
  };
}

/** Mínimo e máximo de um campo nas camadas visíveis (para a escala de cores comum e a legenda). */
export function fieldRange(v: ResultView, field: number, hidden: readonly string[] = []): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const l of v.layers) {
    if (!layerShown(l, hidden)) continue;
    const vals = l.values[field];
    if (!vals) continue;
    for (const x of vals) { if (x < lo) lo = x; if (x > hi) hi = x; }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Visibilidade efetiva de uma camada: `hidden` guarda as escolhas do utilizador sobre o valor por
 * omissão ("nome" esconde uma camada visível, "+nome" mostra uma escondida).
 */
export const layerShown = (l: ResultLayer, hidden: readonly string[]) => (l.visible ? !hidden.includes(l.name) : hidden.includes(`+${l.name}`));

/** Alterna a visibilidade de uma camada na lista de escolhas. */
export function toggleLayer(l: ResultLayer, hidden: readonly string[]): string[] {
  const key = l.visible ? l.name : `+${l.name}`;
  return hidden.includes(key) ? hidden.filter((x) => x !== key) : [...hidden, key];
}

/** Valores dos campos num ponto da vista (sonda): o ponto mais próximo nos triângulos das camadas visíveis. */
export interface ProbeValue {
  layer: string;
  /** Ponto da superfície do resultado (mm, geometria não deformada) e a distância ao ponto pedido. */
  point: [number, number, number];
  distance: number;
  /** Um valor por campo de `ResultView.fields` (null onde o campo não tem significado nesta camada). */
  values: (number | null)[];
  /** Deslocamento interpolado (mm) da deformada pedida, se houver. */
  disp: [number, number, number] | null;
}

type V3 = [number, number, number];

/** Ponto do triângulo abc mais próximo de p, em coordenadas baricêntricas (Ericson, Real-Time Collision Detection 5.1.5). */
function closestBary(p: V3, a: V3, b: V3, c: V3): V3 {
  const sub = (x: V3, y: V3): V3 => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x: V3, y: V3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [0, 1 - w, w]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [1 - v - w, v, w];
}

/**
 * Sonda: os campos interpolados (linearmente no triângulo) no ponto das camadas visíveis mais próximo
 * de `at`, e o deslocamento da deformada `mode`. null se não houver camadas visíveis com triângulos.
 */
export function probeResult(v: ResultView, at: V3, hidden: readonly string[] = [], mode = 0): ProbeValue | null {
  let best: { l: ResultLayer; tri: [number, number, number]; w: V3; q: V3; d: number } | null = null;
  for (const l of v.layers) {
    if (!layerShown(l, hidden)) continue;
    const P = l.positions, T = l.triangles;
    const pt = (i: number): V3 => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    for (let t = 0; t + 2 < T.length; t += 3) {
      const a = pt(T[t]), b = pt(T[t + 1]), c = pt(T[t + 2]);
      const w = closestBary(at, a, b, c);
      const q = [0, 1, 2].map((k) => w[0] * a[k] + w[1] * b[k] + w[2] * c[k]) as V3;
      const d = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      if (!best || d < best.d) best = { l, tri: [T[t], T[t + 1], T[t + 2]], w, q, d };
    }
  }
  if (!best) return null;
  const { l, tri, w } = best;
  const lerp = (arr: number[], stride: number, k: number) => w[0] * arr[stride * tri[0] + k] + w[1] * arr[stride * tri[1] + k] + w[2] * arr[stride * tri[2] + k];
  const D = l.displacements?.[mode];
  return {
    layer: l.name,
    point: best.q,
    distance: best.d,
    values: v.fields.map((_, f) => { const x = l.values[f]; return x ? lerp(x, 1, 0) : null; }),
    disp: D ? [lerp(D, 3, 0), lerp(D, 3, 1), lerp(D, 3, 2)] : null,
  };
}
