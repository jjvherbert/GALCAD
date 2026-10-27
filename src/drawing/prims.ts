// Primitivas vetoriais de uma folha de desenho (mm, origem no canto inferior esquerdo, y para cima)
// e os símbolos normalizados desenhados com elas (independentes da fonte de texto).
import type { GdtChar } from "../doc/project.ts";

export type P = [number, number];

/** Camadas, com espessura e tipo de linha segundo a ISO 128-20 (linhas grossas 0,5 / finas 0,25). */
export type Layer = "visible" | "hidden" | "tangent" | "center" | "hatch" | "dim" | "text" | "frame" | "thin" | "section" | "annot" | "error";

export const LAYER_STYLE: Record<Layer, { lw: number; dash: number[] | null; color: string; dxfColor: number; dxfLtype: "CONTINUOUS" | "DASHED" | "CENTER" }> = {
  visible: { lw: 0.5, dash: null, color: "#000000", dxfColor: 7, dxfLtype: "CONTINUOUS" },
  hidden: { lw: 0.25, dash: [3, 1.5], color: "#000000", dxfColor: 8, dxfLtype: "DASHED" },
  tangent: { lw: 0.18, dash: null, color: "#555555", dxfColor: 9, dxfLtype: "CONTINUOUS" },
  center: { lw: 0.18, dash: [8, 1.5, 1, 1.5], color: "#000000", dxfColor: 1, dxfLtype: "CENTER" },
  hatch: { lw: 0.18, dash: null, color: "#000000", dxfColor: 8, dxfLtype: "CONTINUOUS" },
  dim: { lw: 0.25, dash: null, color: "#000000", dxfColor: 3, dxfLtype: "CONTINUOUS" },
  text: { lw: 0.25, dash: null, color: "#000000", dxfColor: 7, dxfLtype: "CONTINUOUS" },
  frame: { lw: 0.7, dash: null, color: "#000000", dxfColor: 7, dxfLtype: "CONTINUOUS" },
  thin: { lw: 0.25, dash: null, color: "#000000", dxfColor: 7, dxfLtype: "CONTINUOUS" },
  section: { lw: 0.7, dash: null, color: "#000000", dxfColor: 1, dxfLtype: "CONTINUOUS" },
  annot: { lw: 0.25, dash: null, color: "#000000", dxfColor: 5, dxfLtype: "CONTINUOUS" },
  error: { lw: 0.25, dash: null, color: "#dc2626", dxfColor: 1, dxfLtype: "CONTINUOUS" },
};

export type Prim = (
  | { t: "line"; a: P; b: P }
  | { t: "poly"; pts: P[]; closed?: boolean; fill?: boolean }
  | { t: "circle"; c: P; r: number; fill?: boolean }
  /** Arco anti-horário de a0 a a1 (radianos). */
  | { t: "arc"; c: P; r: number; a0: number; a1: number }
  | { t: "text"; at: P; text: string; h: number; angle?: number; align?: "start" | "middle" | "end"; valign?: "baseline" | "middle" | "top"; bold?: boolean }
) & { layer: Layer; ref?: string };

/** Tamanho da fonte (em) para uma altura de maiúsculas `h` (Helvetica: maiúsculas ≈ 0,72 em). */
export const FONT_EM = 1 / 0.72;

/** Larguras da Helvetica (AFM, ‰ do em) para ASCII 32–126; o resto usa a letra base ou 556. */
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

export function charWidth(ch: string): number {
  if (ch === "⌀") return 800 / FONT_EM; // ~0,8 h
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return HELV[code - 32];
  const base = ch.normalize("NFD")[0];
  const b = base.charCodeAt(0);
  return b >= 32 && b <= 126 ? HELV[b - 32] : 556;
}

/** Largura de um texto (mm) com altura de maiúsculas `h`. */
export const textWidth = (s: string, h: number) => [...s].reduce((w, ch) => w + charWidth(ch), 0) / 1000 * h * FONT_EM;

const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const rot = (a: P, ang: number): P => [a[0] * Math.cos(ang) - a[1] * Math.sin(ang), a[0] * Math.sin(ang) + a[1] * Math.cos(ang)];

/** Seta de cota cheia (ISO 129: 15°, ~3 mm) com a ponta em `tip`, a apontar na direção `dir`. */
export function arrow(tip: P, dir: P, layer: Layer = "dim", len = 3): Prim {
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const d: P = [dir[0] / l, dir[1] / l];
  const n: P = [-d[1], d[0]];
  const w = len * Math.tan((7.5 * Math.PI) / 180) * 1.1;
  const base = add(tip, mul(d, -len));
  return { t: "poly", pts: [tip, add(base, mul(n, w)), add(base, mul(n, -w))], closed: true, fill: true, layer };
}

/** Símbolo do método de projeção (ISO 5456-2): tronco de cone e as duas circunferências. */
export function projectionSymbol(c: P, method: "first" | "third", s = 1): Prim[] {
  const out: Prim[] = [];
  const trap = (x: number): Prim => ({ t: "poly", closed: true, layer: "thin", pts: [[x - 5 * s, c[1] - 1.5 * s], [x + 5 * s, c[1] - 3 * s], [x + 5 * s, c[1] + 3 * s], [x - 5 * s, c[1] + 1.5 * s]] });
  const circ = (x: number): Prim[] => [{ t: "circle", c: [x, c[1]], r: 3 * s, layer: "thin" }, { t: "circle", c: [x, c[1]], r: 1.5 * s, layer: "thin" }];
  const xl = c[0] - 6 * s, xr = c[0] + 6 * s;
  if (method === "first") out.push(trap(xl), ...circ(xr));
  else out.push(...circ(xl), trap(xr));
  out.push({ t: "line", a: [c[0] - 12 * s, c[1]], b: [c[0] + 10 * s, c[1]], layer: "center" });
  return out;
}

/** Símbolo da característica geométrica (ISO 1101) dentro de uma caixa de lado `s` centrada em `c`. */
export function gdtSymbol(ch: GdtChar, c: P, s: number): Prim[] {
  const k = s * 0.32;
  const L: Layer = "annot";
  const p = (x: number, y: number): P => [c[0] + x * k, c[1] + y * k];
  switch (ch) {
    case "straightness": return [{ t: "line", a: p(-1.2, 0), b: p(1.2, 0), layer: L }];
    case "flatness": return [{ t: "poly", closed: true, pts: [p(-1.2, -0.6), p(0.6, -0.6), p(1.2, 0.6), p(-0.6, 0.6)], layer: L }];
    case "circularity": return [{ t: "circle", c, r: k, layer: L }];
    case "cylindricity": return [{ t: "circle", c, r: k * 0.8, layer: L }, { t: "line", a: p(-1.4, -1), b: p(-0.3, 1), layer: L }, { t: "line", a: p(0.3, -1), b: p(1.4, 1), layer: L }];
    case "profileLine": return [{ t: "arc", c: p(0, -0.6), r: k * 1.2, a0: 0, a1: Math.PI, layer: L }];
    case "profileSurface": return [{ t: "arc", c: p(0, -0.6), r: k * 1.2, a0: 0, a1: Math.PI, layer: L }, { t: "line", a: p(-1.2, -0.6), b: p(1.2, -0.6), layer: L }];
    case "parallelism": return [{ t: "line", a: p(-1, -1), b: p(0, 1), layer: L }, { t: "line", a: p(0, -1), b: p(1, 1), layer: L }];
    case "perpendicularity": return [{ t: "line", a: p(0, -1), b: p(0, 1), layer: L }, { t: "line", a: p(-1.2, -1), b: p(1.2, -1), layer: L }];
    case "angularity": return [{ t: "line", a: p(-1.2, -1), b: p(1.2, -1), layer: L }, { t: "line", a: p(-1.2, -1), b: p(1.2, 0.8), layer: L }];
    case "position": return [{ t: "circle", c, r: k * 0.8, layer: L }, { t: "line", a: p(-1.3, 0), b: p(1.3, 0), layer: L }, { t: "line", a: p(0, -1.3), b: p(0, 1.3), layer: L }];
    case "concentricity": return [{ t: "circle", c, r: k * 1.1, layer: L }, { t: "circle", c, r: k * 0.5, layer: L }];
    case "symmetry": return [{ t: "line", a: p(-1.3, 0), b: p(1.3, 0), layer: L }, { t: "line", a: p(-0.8, 0.7), b: p(0.8, 0.7), layer: L }, { t: "line", a: p(-0.8, -0.7), b: p(0.8, -0.7), layer: L }];
    case "runout": return [{ t: "line", a: p(-1, -1), b: p(0.9, 0.9), layer: L }, arrow(p(1, 1), [1, 1], L, k * 0.9)];
    case "totalRunout": return [
      { t: "line", a: p(-1.4, -1), b: p(0.6, -1), layer: L }, { t: "line", a: p(-1.4, -1), b: p(0.1, 0.9), layer: L }, { t: "line", a: p(-0.4, -1), b: p(1.1, 0.9), layer: L },
      arrow(p(0.2, 1), [0.6, 1], L, k * 0.8), arrow(p(1.2, 1), [0.6, 1], L, k * 0.8),
    ];
  }
}

export const GDT_LABELS: Record<GdtChar, string> = {
  straightness: "Retitude", flatness: "Planeza", circularity: "Circularidade", cylindricity: "Cilindricidade",
  profileLine: "Perfil de uma linha", profileSurface: "Perfil de uma superfície", parallelism: "Paralelismo",
  perpendicularity: "Perpendicularidade", angularity: "Inclinação", position: "Posição", concentricity: "Concentricidade / coaxialidade",
  symmetry: "Simetria", runout: "Batimento circular", totalRunout: "Batimento total",
};

/** Símbolo de estado de superfície (ISO 21920-1 / ISO 1302) com o vértice em `tip`. */
export function surfaceSymbol(tip: P, process: "any" | "removal" | "noRemoval", value: string, h = 3.5): Prim[] {
  const L: Layer = "annot";
  const s60 = Math.sin(Math.PI / 3), c60 = Math.cos(Math.PI / 3);
  const short = h * 1.4, long = h * 2.8;
  const a = add(tip, [-short * c60, short * s60]);
  const b = add(tip, [long * c60, long * s60]);
  const out: Prim[] = [{ t: "line", a: tip, b: a, layer: L }, { t: "line", a: tip, b, layer: L }];
  if (process === "removal") out.push({ t: "line", a, b: add(tip, [short * c60, short * s60]), layer: L });
  if (process === "noRemoval") out.push({ t: "circle", c: add(tip, [0, short * 0.55]), r: short * 0.4, layer: L });
  if (value) {
    const w = textWidth(value, h * 0.8) + 2;
    out.push({ t: "line", a: b, b: add(b, [w, 0]), layer: L });
    out.push({ t: "text", at: add(b, [1, 0.8]), text: value, h: h * 0.8, layer: "text" });
  }
  return out;
}

/** Símbolo elementar de soldadura (ISO 2553) assente na linha de referência, centrado em x. */
export function weldGlyph(kind: "fillet" | "butt" | "v" | "spot", base: P, below: boolean, h = 3.5): Prim[] {
  const L: Layer = "annot";
  const sg = below ? -1 : 1;
  const p = (x: number, y: number): P => [base[0] + x, base[1] + sg * y];
  switch (kind) {
    case "fillet": return [{ t: "poly", closed: true, pts: [p(-h / 2, 0), p(-h / 2, h), p(h / 2, 0)], layer: L }];
    case "butt": return [{ t: "line", a: p(-h / 4, 0), b: p(-h / 4, h), layer: L }, { t: "line", a: p(h / 4, 0), b: p(h / 4, h), layer: L }];
    case "v": return [{ t: "line", a: p(0, 0), b: p(-h / 2, h), layer: L }, { t: "line", a: p(0, 0), b: p(h / 2, h), layer: L }];
    case "spot": return [{ t: "circle", c: p(0, h / 2), r: h / 2, layer: L }];
  }
}

export { add, mul, rot };
