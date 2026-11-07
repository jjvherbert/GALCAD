// Espelhar entidades do esboço numa linha de simetria (função pura sobre SketchData).
import type { SketchEntity } from "../doc/types.ts";
import { type P2, add, allEntities, dot, entityPoints, mul, pt, sub } from "./geometry.ts";
import { type SketchData, addConstraint, addEntity, addLine, addPoint, deleteItems } from "./ops.ts";

/** Reflexão do ponto p na reta que passa por a e b. */
export function reflect(p: P2, a: P2, b: P2): P2 {
  const u = sub(b, a);
  const k = dot(sub(p, a), u) / dot(u, u);
  const foot = add(a, mul(u, k));
  return sub(mul(foot, 2), p);
}

/**
 * Cria a imagem espelhada das entidades `ids` na linha `axis` (qualquer linha do esboço ou os eixos H/V).
 * Cada ponto novo fica simétrico do original; pontos sobre o eixo são partilhados. Com `keep: false`
 * apaga os originais e fica só a cópia espelhada.
 */
export function sketchMirror(s0: SketchData, ids: string[], axis: string, opts: { keep?: boolean } = {}): SketchData | null {
  const ents = allEntities(s0);
  const ax = ents[axis];
  if (!ax || ax.type !== "line") return null;
  const items = [...new Set(ids)].filter((id) => id !== axis && s0.entities[id]);
  if (!items.length) return null;
  const A = pt(ents, ax.p1), B = pt(ents, ax.p2);
  const scale = Math.hypot(B[0] - A[0], B[1] - A[1]);
  let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.slice() };
  const map = new Map<string, string>();
  const shared = new Set<string>();
  const image = (p: string): string => {
    const m = map.get(p);
    if (m) return m;
    const P = pt(ents, p), Q = reflect(P, A, B);
    let id: string;
    if (Math.hypot(Q[0] - P[0], Q[1] - P[1]) < 1e-9 * Math.max(1, scale)) { id = p; shared.add(p); }
    else {
      const e = ents[p] as Extract<SketchEntity, { type: "point" }>;
      const r = addPoint(s, Q, e.construction); s = r.s; id = r.id;
      s = addConstraint(s, "symmetric", [p, id, axis]).s;
    }
    map.set(p, id);
    return id;
  };
  const curves = items.filter((id) => s0.entities[id].type !== "point");
  // pontos de curvas primeiro, para a cópia reutilizar as imagens já criadas
  for (const id of curves) for (const p of entityPoints(s0.entities[id])) image(p);
  for (const id of items.filter((i) => s0.entities[i].type === "point")) image(id);
  for (const id of curves) {
    const e = s0.entities[id];
    const cons = e.construction ? { construction: true } : {};
    if (e.type === "line") {
      s = addLine(s, image(e.p1), image(e.p2), { infer: false, ...cons }).s;
    } else if (e.type === "circle") {
      const r = addEntity(s, "c", { type: "circle", c: image(e.c), r: e.r, ...cons }); s = r.s;
      s = addConstraint(s, "equal", [id, r.id]).s;
    } else if (e.type === "arc") {
      // a reflexão inverte o sentido: o arco espelhado vai da imagem de e para a imagem de s
      const now = allEntities(s), c = pt(now, image(e.c)), ns = image(e.e), ne = image(e.s);
      const ang = (p: string) => { const q = pt(now, p); return Math.atan2(q[1] - c[1], q[0] - c[0]); };
      const r = addEntity(s, "a", { type: "arc", c: image(e.c), s: ns, e: ne, r: e.r, a0: ang(ns), a1: ang(ne), ...cons }); s = r.s;
      s = addConstraint(s, "equal", [id, r.id]).s;
    } else if (e.type === "spline") {
      s = addEntity(s, "s", { type: "spline", pts: e.pts.map(image), ...cons }).s;
    }
  }
  if (opts.keep === false) s = deleteItems(s, items.filter((id) => !shared.has(id)));
  return s;
}
