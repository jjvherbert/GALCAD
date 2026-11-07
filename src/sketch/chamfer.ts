// Chanfro de canto do esboço: corta o canto entre duas linhas por uma linha reta (função pura sobre SketchData).
import type { SketchEntity } from "../doc/types.ts";
import { add, allEntities, dist, dot, lineAngle, mul, pt, sub } from "./geometry.ts";
import { dropOrphans } from "./modify.ts";
import { type SketchData, addConstraint, addLine, addPoint } from "./ops.ts";

type Line = Extract<SketchEntity, { type: "line" }>;

/** Três maneiras de definir o chanfro: distância igual, distância + ângulo (medido na 1.ª linha) ou duas distâncias. */
export type ChamferSpec =
  | { mode: "equal"; d: number }
  | { mode: "angle"; d: number; angle: number }
  | { mode: "two"; d1: number; d2: number };

/** Geometria do chanfro: linhas do canto (pela ordem pedida), pontos de corte e distâncias. null se não couber. */
export function chamferGeometry(s0: SketchData, corner: string, spec: ChamferSpec, flip = false) {
  const ents = allEntities(s0);
  const lines = Object.entries(s0.entities).filter(([, e]) => e.type === "line" && (e.p1 === corner || e.p2 === corner)) as [string, Line][];
  if (lines.length !== 2) return null;
  if (flip) lines.reverse();
  const P = pt(ents, corner);
  const far = lines.map(([, l]) => (l.p1 === corner ? l.p2 : l.p1));
  const len = far.map((f) => dist(P, pt(ents, f)));
  const u = far.map((f, i) => mul(sub(pt(ents, f), P), 1 / len[i]));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u[0], u[1]))));
  let d: [number, number];
  if (spec.mode === "equal") d = [spec.d, spec.d];
  else if (spec.mode === "two") d = [spec.d1, spec.d2];
  else {
    const a = (spec.angle * Math.PI) / 180;
    if (!(a > 0 && a < Math.PI - theta)) return null;
    // lei dos senos no triângulo canto–T0–T1: ângulo a em T0, θ no canto
    d = [spec.d, (spec.d * Math.sin(a)) / Math.sin(Math.PI - theta - a)];
  }
  if (!(d[0] > 0 && d[1] > 0) || d[0] >= len[0] || d[1] >= len[1]) return null;
  const T = u.map((v, i) => add(P, mul(v, d[i]))) as [[number, number], [number, number]];
  return { lines, far, len, d, T, theta };
}

/** Substitui o canto entre duas linhas (no ponto `corner`) por uma linha reta, segundo `spec`.
 *  `flip` troca qual das linhas é a 1.ª (onde se mede a distância do modo ângulo). */
export function sketchChamfer(s0: SketchData, corner: string, spec: ChamferSpec | number, flip = false): SketchData | null {
  const sp: ChamferSpec = typeof spec === "number" ? { mode: "equal", d: spec } : spec;
  const g = chamferGeometry(s0, corner, sp, flip);
  if (!g) return null;
  const { lines, far, len, d, T } = g;
  let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.filter((c) => !c.refs.includes(corner)) };
  const np: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = addPoint(s, T[i]); s = p.s; np.push(p.id);
    const [lid] = lines[i], l = s.entities[lid] as Line;
    s.entities[lid] = l.p1 === corner ? { ...l, p1: p.id } : { ...l, p2: p.id };
    // a distância ao canto antigo fica definida pelo comprimento restante da linha; no modo ângulo, a 2.ª linha fica pelo ângulo
    if (i === 0 || sp.mode !== "angle") s = addConstraint(s, "distance", [p.id, far[i]], len[i] - d[i]).s;
  }
  const l0 = s.entities[lines[0][0]] as Line;
  // orientar o chanfro para que o ângulo entre direções seja o pedido (e não o suplementar)
  const ch = l0.p2 === np[0] ? addLine(s, np[0], np[1], { infer: false }) : addLine(s, np[1], np[0], { infer: false });
  s = ch.s;
  if (sp.mode === "angle") {
    const refs = lineAngle(allEntities(s), lines[0][0], ch.id) >= 0 ? [lines[0][0], ch.id] : [ch.id, lines[0][0]];
    s = addConstraint(s, "angle", refs, sp.angle).s;
  }
  return dropOrphans(s, [corner]);
}
