// Chanfro de canto do esboço: corta o canto entre duas linhas por uma linha reta (função pura sobre SketchData).
import type { SketchEntity } from "../doc/types.ts";
import { add, allEntities, dist, mul, pt, sub } from "./geometry.ts";
import { dropOrphans } from "./modify.ts";
import { type SketchData, addConstraint, addLine, addPoint } from "./ops.ts";

type Line = Extract<SketchEntity, { type: "line" }>;

/** Substitui o canto entre duas linhas (no ponto `corner`) por uma linha a distância d do canto, em cada lado. */
export function sketchChamfer(s0: SketchData, corner: string, d: number): SketchData | null {
  const ents = allEntities(s0);
  const lines = Object.entries(s0.entities).filter(([, e]) => e.type === "line" && (e.p1 === corner || e.p2 === corner)) as [string, Line][];
  if (lines.length !== 2 || !(d > 0)) return null;
  const P = pt(ents, corner);
  const far = lines.map(([, l]) => (l.p1 === corner ? l.p2 : l.p1));
  const len = far.map((f) => dist(P, pt(ents, f)));
  if (d >= len[0] || d >= len[1]) return null;
  const T = far.map((f, i) => add(P, mul(sub(pt(ents, f), P), d / len[i])));
  let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.filter((c) => !c.refs.includes(corner)) };
  const np: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = addPoint(s, T[i]); s = p.s; np.push(p.id);
    const [lid] = lines[i], l = s.entities[lid] as Line;
    s.entities[lid] = l.p1 === corner ? { ...l, p1: p.id } : { ...l, p2: p.id };
    // a distância de d ao canto antigo fica definida pelo comprimento restante da linha
    s = addConstraint(s, "distance", [p.id, far[i]], len[i] - d).s;
  }
  s = addLine(s, np[0], np[1], { infer: false }).s;
  return dropOrphans(s, [corner]);
}
