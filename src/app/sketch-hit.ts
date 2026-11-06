// Acerto, snap e pontos de clique do editor de esboço 2D.
import { type P2, allEntities, isImplicit, pt, sampleEntity } from "../sketch/geometry.ts";
import { type SketchData, addConstraint, addPoint } from "../sketch/ops.ts";
import { projectOn, segDist } from "./sketch-geom.ts";
import { type RefGroup } from "./sketch-ref.ts";
import { type Snap } from "./sketch-types.ts";

type Ents = ReturnType<typeof allEntities>;
type Scr = (p: P2) => [number, number];
/** Contexto de acerto: entidades e conversões ecrã <-> mundo do editor. */
export type Hit = { ents: Ents; S: Scr; W: (sx: number, sy: number) => P2 };
export type HitOpts = { points?: boolean; curves?: boolean; exclude?: Set<string> };

export function hitAtIn(h: Hit, sx: number, sy: number, opts: HitOpts = {}): string | null {
  const { ents, S } = h;
  const { points = true, curves = true, exclude } = opts;
  let best: string | null = null, bestD = 8;
  if (points) {
    for (const [id, e] of Object.entries(ents)) {
      if (e.type !== "point" || exclude?.has(id) || (isImplicit(id) && id !== "O")) continue;
      const [x, y] = S([e.x, e.y]);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best) return best;
  }
  if (!curves) return null;
  // curvas reais primeiro; os eixos do esboço só se não houver nenhuma por perto
  for (const axes of [false, true]) {
    bestD = 6;
    for (const [id, e] of Object.entries(ents)) {
      if (e.type === "point" || exclude?.has(id)) continue;
      const isAxis = id === "H" || id === "V";
      if (isAxis !== axes || (isImplicit(id) && !isAxis)) continue;
      const poly = isAxis ? [[-1e5, 0], [1e5, 0]].map((p) => (id === "V" ? [0, p[0]] : p) as P2) : sampleEntity(ents, id);
      for (let i = 0; i < poly.length - 1; i++) {
        const d = segDist([sx, sy], S(poly[i]), S(poly[i + 1]));
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    if (best) return best;
  }
  return null;
}

export function snapIn(h: Hit, sx: number, sy: number, exclude?: Set<string>): Snap {
  const { ents, W } = h;
  const hitAt = (a: number, b: number, o: HitOpts = {}) => hitAtIn(h, a, b, o);
  const id = hitAt(sx, sy, { curves: false, exclude });
  if (id) return { p: pt(ents, id), id };
  const on = hitAt(sx, sy, { points: false, exclude });
  const p = W(sx, sy);
  if (on && on !== "H" && on !== "V") return { p: projectOn(ents, on, p), on };
  if (on === "H") return { p: [p[0], 0], on };
  if (on === "V") return { p: [0, p[1]], on };
  return { p };
}

/** Ponto num local de clique: reutiliza o existente ou cria um novo (com "ponto em" se sobre uma curva). */
export function placePoint(s: SketchData, sn: Snap): { s: SketchData; id: string; created: boolean } {
  if (sn.id) return { s, id: sn.id, created: false };
  let r = addPoint(s, sn.p);
  if (sn.on) r = { s: addConstraint(r.s, "pointOn", [r.id, sn.on]).s, id: r.id };
  return { ...r, created: true };
}

export function hitRefIn(refGroups: RefGroup[], S: Scr, sx: number, sy: number): number {
  let best = -1, bestD = 7;
  refGroups.forEach((g, i) => {
    for (let k = 0; k < g.pts.length - 1; k++) {
      const d = segDist([sx, sy], S(g.pts[k]), S(g.pts[k + 1]));
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  return best;
}
