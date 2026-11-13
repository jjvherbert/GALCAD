// Layout automático: três vistas ortogonais e uma isométrica, com escala normalizada (ISO 5455) e folha
// escolhidas a partir da caixa envolvente do modelo.
import type { DrawingDoc, SheetSize, ViewSource } from "../doc/project.ts";
import { FRAME, SHEET_SIZES, TITLE_H } from "./render-base.ts";
import { addView } from "./edit.ts";

type Box3 = { min: [number, number, number]; max: [number, number, number] };

/** Escalas normalizadas (ISO 5455), da maior para a menor, como [numerador, denominador]. */
export const ISO_SCALES: [number, number][] = [
  [50, 1], [20, 1], [10, 1], [5, 1], [2, 1], [1, 1],
  [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [1, 200], [1, 500], [1, 1000],
];
const SIZES: SheetSize[] = ["A4", "A3", "A2", "A1", "A0"];
/** Folga mínima entre vistas e até à moldura (mm de folha). */
const GAP = 10;

/** Dimensões da vista isométrica (direção (1, −1, 1), como no kernel) da caixa, em mm do modelo. */
function isoExtent(d: [number, number, number]): [number, number] {
  // eixos da vista: x = (1, 1, 0)/√2, y = (−1, 1, 2)/√6
  const w = (d[0] + d[1]) / Math.SQRT2;
  const h = (d[0] + d[1] + 2 * d[2]) / Math.sqrt(6);
  return [w, h];
}

interface Grid { cols: [number, number]; rows: [number, number] }

function grid(d: [number, number, number], first: boolean): Grid {
  const [dx, dy, dz] = d;
  const [iw, ih] = isoExtent(d);
  // 1.º diedro: frente e lateral em cima, planta e isométrica em baixo; 3.º diedro: ao contrário
  const lower = Math.max(dy, ih);
  return { cols: [dx, Math.max(dy, iw)], rows: first ? [dz, lower] : [lower, dz] };
}

/** Maior escala normalizada com que a grelha cabe na área útil (folha menos moldura e legenda). */
function bestScale(g: Grid, w: number, h: number): [number, number] | null {
  const W = w - FRAME.left - FRAME.right - 3 * GAP;
  const H = h - FRAME.top - FRAME.bottom - TITLE_H - 3 * GAP;
  const max = Math.min(W / (g.cols[0] + g.cols[1]), H / (g.rows[0] + g.rows[1]));
  return ISO_SCALES.find(([n, m]) => n / m <= max) ?? null;
}

/**
 * Acrescenta ao desenho a frente, a planta, a lateral (vistas projetadas, conforme o método da folha) e a
 * isométrica do modelo, centradas na área útil. Escolhe a escala da folha; com `fitSheet`, escolhe também
 * a menor folha (A4 a A0, horizontal) que permite 1:1 ou a melhor escala possível.
 */
export function autoLayout(doc: DrawingDoc, source: ViewSource, box: Box3, opts: { fitSheet?: boolean } = {}): DrawingDoc {
  const d = [0, 1, 2].map((i) => Math.max(box.max[i] - box.min[i], 0)) as [number, number, number];
  const big = Math.max(...d, 1);
  // peças planas: uma espessura mínima para as vistas de topo não terem altura nula
  const dims = d.map((x) => Math.max(x, big * 0.02)) as [number, number, number];
  const first = doc.sheet.projection === "first";
  const g = grid(dims, first);

  let sheet = doc.sheet;
  if (opts.fitSheet) {
    const scaleOf = (s: SheetSize) => { const [w, h] = SHEET_SIZES[s]; const r = bestScale(g, w, h); return r ? r[0] / r[1] : 0; };
    const target = Math.min(1, scaleOf("A0"));
    const size = SIZES.find((s) => scaleOf(s) >= target) ?? "A0";
    sheet = { ...sheet, size, orientation: "landscape" };
  }
  const [w, h] = sheet.orientation === "portrait" ? [SHEET_SIZES[sheet.size][1], SHEET_SIZES[sheet.size][0]] : SHEET_SIZES[sheet.size];
  const scale = bestScale(g, w, h) ?? ISO_SCALES[ISO_SCALES.length - 1];
  const s = scale[0] / scale[1];

  // folgas iguais: a sobra reparte-se pelas três faixas de cada direção
  const W = w - FRAME.left - FRAME.right, H = h - FRAME.top - FRAME.bottom - TITLE_H;
  const gx = Math.max((W - s * (g.cols[0] + g.cols[1])) / 3, 0);
  const gy = Math.max((H - s * (g.rows[0] + g.rows[1])) / 3, 0);
  const x1 = FRAME.left + gx + (s * g.cols[0]) / 2;
  const x2 = FRAME.left + 2 * gx + s * g.cols[0] + (s * g.cols[1]) / 2;
  const top = h - FRAME.top;
  const y1 = top - gy - (s * g.rows[0]) / 2; // folha com y para cima: a 1.ª linha é a de cima
  const y2 = top - 2 * gy - s * g.rows[0] - (s * g.rows[1]) / 2;
  const [yFront, yPlan] = first ? [y1, y2] : [y2, y1];
  const yIso = first ? y2 : y1;

  let out: DrawingDoc = { ...doc, sheet: { ...sheet, scale } };
  const f = addView(out, { kind: "model", source, orientation: "front", at: [x1, yFront] });
  out = f.doc;
  out = addView(out, { kind: "projected", parent: f.id, side: first ? "below" : "above", at: [x1, yPlan] }).doc;
  out = addView(out, { kind: "projected", parent: f.id, side: "right", at: [x2, yFront] }).doc;
  out = addView(out, { kind: "model", source, orientation: "iso", at: [x2, yIso] }).doc;
  return out;
}
