// Desenho de uma cota no esboço (em coordenadas do mundo): linhas de chamada, linha de cota e setas,
// a partir do tipo, das referências e do ponto onde o rótulo foi largado. Puro (testes em node).
import type { SketchConstraint, SketchEntity } from "../doc/types.ts";
import { type P2, add, arcSign, arcSweep, curveRef, dot, len, mul, pt, sub } from "./geometry.ts";

export interface DimGeom {
  /** linhas de chamada (da geometria até à linha de cota) */
  ext: [P2, P2][];
  /** linha(s) de cota; um arco vem como polilinha */
  lines: P2[][];
  /** setas: ponta e direção (unitária) para onde aponta */
  arrows: [P2, P2][];
}

const unit = (v: P2): P2 => { const L = len(v); return L < 1e-12 ? [1, 0] : [v[0] / L, v[1] / L]; };
const perp = (v: P2): P2 => [-v[1], v[0]];

/** Arco de cota de centro X e raio r, de t1 a t1+sweep (CCW), com as setas nas pontas. */
function arcDim(X: P2, r: number, t1: number, sweep: number): { pts: P2[]; arrows: [P2, P2][] } {
  const n = Math.max(8, Math.ceil(sweep / 0.08)), pts: P2[] = [];
  for (let i = 0; i <= n; i++) { const t = t1 + (sweep * i) / n; pts.push(add(X, [r * Math.cos(t), r * Math.sin(t)])); }
  const t2 = t1 + sweep;
  return { pts, arrows: [[pts[0], [Math.sin(t1), -Math.cos(t1)]], [pts[n], [-Math.sin(t2), Math.cos(t2)]]] };
}

/** Extremos medidos de uma cota linear (ponto–ponto, linha, ponto–linha pelo pé da perpendicular). */
function linearEnds(c: Pick<SketchConstraint, "type" | "refs" | "arc">, ents: Record<string, SketchEntity>): [P2, P2] | null {
  if (c.arc) {
    // condição de arco: as pontas saem do centro, ±raio ao longo da cota (min do lado de lá, max de cá)
    const A = curveRef(ents, c.refs[0]), B = curveRef(ents, c.refs[1]);
    const swap = ents[A.id]?.type === "line";
    const ends = linearEnds({ type: c.type, refs: swap ? [B.id, A.id] : [A.id, B.id] }, ents);
    if (!ends) return null;
    const [p, q] = swap ? [ends[1], ends[0]] : ends, u = unit(sub(q, p));
    if (len(sub(q, p)) < 1e-12) return ends;
    const sa = A.curve ? arcSign(c.arc[0]) * A.r : 0, sb = B.curve ? arcSign(c.arc[1]) * B.r : 0;
    return [add(p, mul(u, -sa)), add(q, mul(u, sb))];
  }
  const [ra, rb] = c.refs;
  const ea = ents[ra], eb = rb ? ents[rb] : undefined;
  if (!ea) return null;
  if (ea.type === "line" && !eb) return [pt(ents, ea.p1), pt(ents, ea.p2)];
  if (ea.type === "point" && eb?.type === "point") return [[ea.x, ea.y], [eb.x, eb.y]];
  if (ea.type === "point" && eb?.type === "line") {
    const p: P2 = [ea.x, ea.y], a = pt(ents, eb.p1), b = pt(ents, eb.p2), d = sub(b, a), L2 = dot(d, d);
    if (L2 < 1e-24) return null;
    return [p, add(a, mul(d, dot(sub(p, a), d) / L2))];
  }
  return null;
}

/** Geometria da cota com o rótulo em `pos`; `null` quando não há desenho próprio (fica o rótulo). */
export function dimGeometry(c: Pick<SketchConstraint, "type" | "refs" | "flip" | "arc">, ents: Record<string, SketchEntity>, pos: P2): DimGeom | null {
  if (c.type === "distance" || c.type === "distanceX" || c.type === "distanceY") {
    const ends = linearEnds(c, ents);
    if (!ends) return null;
    const [a, b] = ends;
    const u: P2 = c.type === "distanceX" ? [1, 0] : c.type === "distanceY" ? [0, 1] : unit(sub(b, a));
    if (c.type === "distance" && len(sub(b, a)) < 1e-9) return null;
    const n = perp(u);
    const a2 = add(a, mul(n, dot(sub(pos, a), n))), b2 = add(b, mul(n, dot(sub(pos, b), n)));
    const lo = Math.min(dot(a2, u), dot(b2, u)), hi = Math.max(dot(a2, u), dot(b2, u)), t = dot(pos, u);
    const line: P2[] = [a2, b2];
    // rótulo fora do vão: a linha de cota prolonga-se até ele
    if (t < lo || t > hi) {
      const near = Math.abs(t - dot(a2, u)) < Math.abs(t - dot(b2, u)) ? a2 : b2;
      line.push(near, add(near, mul(u, t - dot(near, u))));
    }
    const dir = unit(sub(b2, a2));
    return {
      ext: [[a, a2], [b, b2]].filter(([p, q]) => len(sub(p, q)) > 1e-9) as [P2, P2][],
      lines: line.length === 2 ? [line] : [line.slice(0, 2), line.slice(2)],
      arrows: [[a2, mul(dir, -1)], [b2, dir]],
    };
  }
  if (c.type === "radius" || c.type === "diameter") {
    const e = ents[c.refs[0]];
    if (e?.type !== "circle" && e?.type !== "arc") return null;
    const cc = pt(ents, e.c), d = unit(sub(pos, cc)), tip = add(cc, mul(d, e.r));
    const from = c.type === "diameter" ? add(cc, mul(d, -e.r)) : cc;
    const lines: P2[][] = [[from, tip]];
    if (len(sub(pos, cc)) > e.r) lines.push([tip, pos]);
    const arrows: [P2, P2][] = [[tip, d]];
    if (c.type === "diameter") arrows.push([from, mul(d, -1)]);
    return { ext: [], lines, arrows };
  }
  if (c.type === "angle" && ents[c.refs[0]]?.type === "arc") return arcDimGeom(ents[c.refs[0]] as Extract<SketchEntity, { type: "arc" }>, ents, pos);
  if (c.type === "angle") {
    const l1 = ents[c.refs[0]], l2 = ents[c.refs[1]];
    if (l1?.type !== "line" || l2?.type !== "line") return null;
    const a1 = pt(ents, l1.p1), b1 = pt(ents, l1.p2), a2 = pt(ents, l2.p1), b2 = pt(ents, l2.p2);
    let d1 = sub(b1, a1), d2 = sub(b2, a2);
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12) return null;
    const w = sub(a2, a1), s = (w[0] * d2[1] - w[1] * d2[0]) / den, X = add(a1, mul(d1, s));
    // setor medido: sentidos invertidos por `flip`
    if (c.flip && c.flip & 1) d1 = mul(d1, -1);
    if (c.flip && c.flip & 2) d2 = mul(d2, -1);
    const r = len(sub(pos, X));
    if (r < 1e-9) return null;
    const t1 = Math.atan2(d1[1], d1[0]);
    let sweep = Math.atan2(d2[1], d2[0]) - t1;
    while (sweep < 0) sweep += 2 * Math.PI;
    while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;
    const { pts: arc, arrows } = arcDim(X, r, t1, sweep);
    const t2 = t1 + sweep;
    // linhas de chamada: das linhas até ao arco, quando o arco passa para lá da linha
    const ext: [P2, P2][] = [];
    for (const [p, q, t] of [[a1, b1, t1], [a2, b2, t2]] as [P2, P2, number][]) {
      const end = arc[t === t1 ? 0 : arc.length - 1], dir: P2 = [Math.cos(t), Math.sin(t)];
      const far = Math.max(dot(sub(p, X), dir), dot(sub(q, X), dir));
      if (far < r) ext.push([add(X, mul(dir, Math.max(0, far))), end]);
    }
    return { ext, lines: [arc], arrows };
  }
  if (c.type === "arcLength") {
    const e = ents[c.refs[0]];
    return e?.type === "arc" ? arcDimGeom(e, ents, pos) : null;
  }
  return null;
}

/**
 * Comprimento ou ângulo de um arco: arco de cota concêntrico, no raio do rótulo, com linhas de chamada
 * radiais desde os extremos do arco (ou desde o centro, quando a cota fica por dentro).
 */
function arcDimGeom(e: Extract<SketchEntity, { type: "arc" }>, ents: Record<string, SketchEntity>, pos: P2): DimGeom | null {
  const X = pt(ents, e.c), rd = len(sub(pos, X)), sweep = arcSweep(e.a0, e.a1);
  if (rd < 1e-9 || sweep < 1e-12) return null;
  const { pts, arrows } = arcDim(X, rd, e.a0, sweep);
  const ext: [P2, P2][] = [];
  for (const [t, end] of [[e.a0, pts[0]], [e.a0 + sweep, pts[pts.length - 1]]] as [number, P2][]) {
    const from = add(X, [e.r * Math.cos(t), e.r * Math.sin(t)]);
    if (len(sub(end, from)) > 1e-9) ext.push([from, end]);
  }
  return { ext, lines: [pts], arrows };
}
