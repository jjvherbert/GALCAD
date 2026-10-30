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
  fields: { name: string; unit: string }[];
  /** Rótulos das deformadas (estática: "Deformada"; modal/encurvadura: um por modo). */
  modes: string[];
  layers: ResultLayer[];
}

/** Resultado FEM como uma camada única (superfície exterior da malha). */
export function femView(r: FemResult): ResultView {
  return {
    fields: r.fields.map((f) => ({ name: f.name, unit: f.unit })),
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
