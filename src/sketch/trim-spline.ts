// Aparar splines: corta a spline nas interseções com as outras entidades, à volta do ponto clicado.
// A spline é interpolada (Catmull-Rom) pelos seus pontos; os troços que ficam passam pelos pontos
// originais desse lado, por um ponto intermédio do troço cortado e pelo novo extremo no corte.
import type { SketchEntity } from "../doc/types.ts";
import { type Bezier, type P2, allEntities, bezierAt, cross, dist, dot, entityPoints, pt, splineBeziers, sub } from "./geometry.ts";
import type { Piece } from "./modify.ts";
import { type SketchData, addConstraint, addEntity, addPoint, deleteItems } from "./ops.ts";

type Spline = Extract<SketchEntity, { type: "spline" }>;
export type Cut = { by: string; pc: Piece };

const TAU = 2 * Math.PI;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

/** "Ponto em" a entidade que cortou; as splines não têm esta restrição no solver, por isso ficam de fora. */
export const pointOnCut = (s: SketchData, p: string, by: string): SketchData =>
  s.entities[by]?.type === "spline" ? s : addConstraint(s, "pointOn", [p, by]).s;

/** Distância com sinal a uma peça (zero em cima dela) e se o ponto cai dentro do troço/arco. */
function signed(pc: Piece, q: P2): number {
  if (pc.k === "seg") return cross(sub(pc.b, pc.a), sub(q, pc.a)) / (dist(pc.a, pc.b) || 1);
  return dist(q, pc.c) - pc.r;
}
function inside(pc: Piece, q: P2): boolean {
  if (pc.k === "seg") {
    const d = sub(pc.b, pc.a), u = dot(sub(q, pc.a), d) / (dot(d, d) || 1);
    return u >= -1e-6 && u <= 1 + 1e-6;
  }
  return pc.sw === undefined || wrap(Math.atan2(q[1] - pc.c[1], q[0] - pc.c[0]) - pc.a0!) <= pc.sw + 1e-6;
}

/** Parâmetros globais (índice da Bézier + t) onde a spline cruza a peça. */
function hitsOn(bz: Bezier[], pc: Piece): number[] {
  const out: number[] = [];
  const N = 32;
  bz.forEach((b, k) => {
    let t0 = 0, g0 = signed(pc, b[0]);
    for (let i = 1; i <= N; i++) {
      const t1 = i / N, g1 = signed(pc, bezierAt(b, t1));
      if (g0 === 0 || g0 * g1 < 0) {
        let lo = t0, hi = t1, glo = g0;
        if (g0 !== 0) for (let it = 0; it < 50; it++) {
          const m = (lo + hi) / 2, gm = signed(pc, bezierAt(b, m));
          if (glo * gm <= 0) hi = m; else { lo = m; glo = gm; }
        }
        const t = g0 === 0 ? t0 : (lo + hi) / 2;
        if (inside(pc, bezierAt(b, t))) out.push(k + t);
      }
      t0 = t1; g0 = g1;
    }
  });
  return out;
}

/** Parâmetro global do ponto da spline mais próximo do clique. */
function nearestU(bz: Bezier[], q: P2): number {
  let best = 0, bd = Infinity;
  bz.forEach((b, k) => { for (let i = 0; i <= 64; i++) { const d = dist(bezierAt(b, i / 64), q); if (d < bd) { bd = d; best = k + i / 64; } } });
  return best;
}

/**
 * Apaga o troço da spline entre as interseções mais próximas do clique.
 * Sem interseções, apaga a spline; com corte só de um lado, fica o outro; com corte dos dois, fica partida em duas.
 */
export function trimSpline(s0: SketchData, id: string, click: P2, cuts: Cut[]): SketchData {
  const ents = allEntities(s0);
  const e = ents[id] as Spline;
  const P = e.pts.map((p) => pt(ents, p));
  const bz = splineBeziers(P);
  const last = P.length - 1;
  const hits: { u: number; by: string }[] = [];
  for (const { by, pc } of cuts) for (const u of hitsOn(bz, pc)) {
    if (u > 1e-6 && u < last - 1e-6 && !hits.some((h) => Math.abs(h.u - u) < 1e-7)) hits.push({ u, by });
  }
  if (!hits.length) return deleteItems(s0, [id]);
  const uc = nearestU(bz, click);
  const lo = hits.filter((h) => h.u < uc).sort((x, y) => y.u - x.u)[0];
  const hi = hits.filter((h) => h.u > uc).sort((x, y) => x.u - y.u)[0];
  const at = (u: number): P2 => { const k = Math.min(Math.floor(u), bz.length - 1); return bezierAt(bz[k], u - k); };
  const cons = e.construction ? { construction: true } : {};
  let s = s0;
  const add = (q: P2) => { const r = addPoint(s, q); s = r.s; return r.id; };
  /** Pontos do troço [0, u]: originais, ponto intermédio do troço cortado e o novo extremo. */
  const left = (cut: { u: number; by: string }) => {
    const k = Math.floor(cut.u), ids = e.pts.filter((_, i) => i < cut.u - 1e-6);
    if (cut.u - k > 0.1) ids.push(add(at((k + cut.u) / 2)));
    const end = add(at(cut.u)); s = pointOnCut(s, end, cut.by);
    return [...ids, end];
  };
  const right = (cut: { u: number; by: string }) => {
    const k = Math.ceil(cut.u), start = add(at(cut.u)); s = pointOnCut(s, start, cut.by);
    const ids = [start];
    if (k - cut.u > 0.1) ids.push(add(at((k + cut.u) / 2)));
    return [...ids, ...e.pts.filter((_, i) => i > cut.u + 1e-6)];
  };
  let kept: string[];
  if (lo && hi) {
    const a = left(lo), b = right(hi);
    s.entities[id] = { ...e, pts: a };
    s = addEntity(s, "s", { type: "spline", pts: b, ...cons }).s;
    kept = [...a, ...b];
  } else {
    kept = lo ? left(lo) : right(hi!);
    s.entities[id] = { ...e, pts: kept };
  }
  // pontos da parte apagada que já não pertencem a nenhuma entidade
  const used = new Set(Object.values(s.entities).flatMap(entityPoints));
  const gone = e.pts.filter((p) => !kept.includes(p) && !used.has(p));
  return gone.length ? deleteItems(s, gone) : s;
}
