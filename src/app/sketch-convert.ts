// Conversão de arestas do modelo em entidades do esboço.
import { type SketchEntity } from "../doc/types.ts";
import { type P2 } from "../sketch/geometry.ts";
import { type SketchData, addEntity, addPoint } from "../sketch/ops.ts";
import { circleThrough } from "./sketch-geom.ts";
import { type RefGroup } from "./sketch-ref.ts";

/** Contexto da conversão: esboço em edição e ações do editor. */
export type ConvertCtx = {
  draft: Pick<SketchData, "entities" | "constraints">;
  converted: Set<string>;
  commit: (next: SketchData, label: string, opts?: { drivenOnConflict?: string }) => boolean;
  setMsg: (m: string | null) => void;
};

/** Converte arestas do modelo em entidades ligadas (pontos fixos, atualizados pelo núcleo). */
export function convertEdges(c: ConvertCtx, groups: RefGroup[]) {
  const { draft, converted, commit, setMsg } = c;
  let s: SketchData = { entities: { ...draft.entities }, constraints: draft.constraints.slice() };
  let made = 0, skipped = 0;
  const fixedPoint = (p: P2): string => {
    const hit = Object.entries(s.entities).find(([, e]) => e.type === "point" && Math.hypot(e.x - p[0], e.y - p[1]) < 1e-3);
    if (hit) { s.entities[hit[0]] = { ...(hit[1] as Extract<SketchEntity, { type: "point" }>), fixed: true }; return hit[0]; }
    const r = addPoint(s, p);
    s = r.s;
    s.entities[r.id] = { ...(s.entities[r.id] as Extract<SketchEntity, { type: "point" }>), fixed: true };
    return r.id;
  };
  for (const g of groups) {
    if (converted.has(g.name)) continue;
    const ext = { kind: "edge" as const, name: g.name, hint: { c: g.mid, n: g.dir } };
    const a = g.pts[0], b = g.pts[g.pts.length - 1];
    if (g.type === "line") {
      // os pontos primeiro: fixedPoint altera `s`
      const p1 = fixedPoint(a), p2 = fixedPoint(b);
      s = addEntity(s, "l", { type: "line", p1, p2, ext }).s;
    } else if (g.type === "circle" && g.pts.length >= 3) {
      const m = g.pts[Math.floor(g.pts.length / 3)], n = g.pts[Math.floor((2 * g.pts.length) / 3)];
      const c = circleThrough(a, m, n);
      if (!c) { skipped++; continue; }
      const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * Math.max(1, c.r);
      const cid = fixedPoint(c.c);
      if (closed) s = addEntity(s, "c", { type: "circle", c: cid, r: c.r, ext }).s;
      else {
        // sentido anti-horário pelo ponto intermédio
        const mid = g.pts[Math.floor(g.pts.length / 2)];
        const ccw = (a[0] - c.c[0]) * (mid[1] - c.c[1]) - (a[1] - c.c[1]) * (mid[0] - c.c[0]) > 0;
        const [from, to] = ccw ? [a, b] : [b, a];
        const ps = fixedPoint(from), pe = fixedPoint(to);
        s = addEntity(s, "a", { type: "arc", c: cid, s: ps, e: pe, r: c.r, a0: Math.atan2(from[1] - c.c[1], from[0] - c.c[0]), a1: Math.atan2(to[1] - c.c[1], to[0] - c.c[0]), ext }).s;
      }
    } else { skipped++; continue; }
    made++;
  }
  if (made) commit(s, "Converter arestas");
  setMsg(skipped ? `${skipped} aresta(s) não convertida(s): só retas e circulares` : made ? null : "Já convertidas");
}
