// Folha de desenho: formatos, esquadria, formato numérico, colocação das vistas e contexto de render.
import type { DrawingDoc, DrawingView, SheetSize } from "../doc/project.ts";
import type { DrawingResponse } from "../kernel/protocol.ts";
import type { P, Prim } from "./prims.ts";

export const SHEET_SIZES: Record<SheetSize, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };

export function sheetSize(d: DrawingDoc): [number, number] {
  const [w, h] = SHEET_SIZES[d.sheet.size];
  return d.sheet.orientation === "portrait" ? [h, w] : [w, h];
}

/** Margens da esquadria (ISO 5457): 20 mm à esquerda (arquivo), 10 mm nos outros lados. */
export const FRAME = { left: 20, right: 10, top: 10, bottom: 10 };
export const TITLE_W = 180, TITLE_H = 36;

export interface ViewPlacement { at: P; c: P; s: number; box: [number, number, number, number] }

export interface Layout {
  w: number;
  h: number;
  prims: Prim[];
  views: Record<string, ViewPlacement>;
  /** Caixa de cada anotação na folha (para escolher e arrastar). */
  ann: Record<string, [number, number, number, number]>;
  warnings: string[];
}

/** Formato de números em pt-PT: vírgula decimal, sem zeros à direita. */
export function fmtNum(v: number, precision = 2): string {
  const s = v.toFixed(precision).replace(/\.?0+$/, "");
  return (s === "-0" ? "0" : s).replace(".", ",");
}

/** Colocação das vistas: as projetadas ficam alinhadas com a vista-mãe (não se desalinham ao arrastar). */
export function placements(d: DrawingDoc, res: DrawingResponse | null): Record<string, ViewPlacement> {
  const out: Record<string, ViewPlacement> = {};
  const byId = new Map(d.views.map((v) => [v.id, v]));
  const place = (v: DrawingView, depth = 0): ViewPlacement | null => {
    if (out[v.id]) return out[v.id];
    const r = res?.views[v.id];
    if (!r || !r.ok || depth > 20) return null;
    const c: P = [(r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2];
    let at: P = v.at;
    if (v.kind === "projected") {
      const pv = byId.get(v.parent);
      const pp = pv && place(pv, depth + 1);
      if (pp) {
        const horiz = v.side === "right" || v.side === "left";
        // mesma coordenada (y nas laterais, x em cima/baixo) na vista e na mãe
        at = horiz ? [v.at[0], pp.at[1] + r.scale * (c[1] - pp.c[1])] : [pp.at[0] + r.scale * (c[0] - pp.c[0]), v.at[1]];
      }
    }
    const s = r.scale;
    const box: [number, number, number, number] = [at[0] + s * (r.bbox[0] - c[0]), at[1] + s * (r.bbox[1] - c[1]), at[0] + s * (r.bbox[2] - c[0]), at[1] + s * (r.bbox[3] - c[1])];
    return (out[v.id] = { at, c, s, box });
  };
  for (const v of d.views) place(v);
  return out;
}

export const toSheet = (pl: ViewPlacement, p: P): P => [pl.at[0] + pl.s * (p[0] - pl.c[0]), pl.at[1] + pl.s * (p[1] - pl.c[1])];
export const toView = (pl: ViewPlacement, q: P): P => [pl.c[0] + (q[0] - pl.at[0]) / pl.s, pl.c[1] + (q[1] - pl.at[1]) / pl.s];

export interface Ctx { d: DrawingDoc; res: DrawingResponse | null; pl: Record<string, ViewPlacement>; warnings: string[] }
