// Repetir entidades do esboço em padrão linear (ao longo de uma linha) ou circular (à volta de um ponto).
import type { SketchEntity } from "../doc/types.ts";
import { type P2, add, allEntities, entityPoints, mul, pt, sub } from "./geometry.ts";
import { type SketchData, addConstraint, addEntity, addLine, addPoint } from "./ops.ts";

/**
 * Padrão linear: `n` instâncias (contando o original) ao longo da linha `dir` (de p1 para p2, ou ao contrário
 * com `flip`). Com `mode: "spacing"` o valor é o passo entre cópias; com `"total"` é a distância do original à última.
 */
export type LinearPattern = { kind: "linear"; n: number; mode: "spacing" | "total"; value: number; dir: string; flip?: boolean };
/**
 * Padrão circular: `n` instâncias à volta do ponto `center`. `"full"` reparte 360°; `"total"` reparte o ângulo
 * dado do original à última; `"step"` usa o ângulo entre cópias seguidas. Ângulo em graus, positivo anti-horário.
 */
export type CircularPattern = { kind: "circular"; n: number; mode: "full" | "total" | "step"; angle?: number; center: string };
export type PatternSpec = LinearPattern | CircularPattern;

/** Passo de cada modo: distância (linear) ou ângulo em graus (circular). null se os valores não fazem sentido. */
export function patternStep(spec: PatternSpec): number | null {
  const n = Math.round(spec.n);
  if (!(n >= 2) || n > 1000) return null;
  if (spec.kind === "linear") {
    const v = spec.mode === "total" ? spec.value / (n - 1) : spec.value;
    return Number.isFinite(v) && Math.abs(v) > 1e-12 ? v : null;
  }
  const a = spec.mode === "full" ? 360 / n : spec.mode === "total" ? (spec.angle ?? 0) / (n - 1) : (spec.angle ?? 0);
  return Number.isFinite(a) && Math.abs(a) > 1e-9 ? a : null;
}

/** Transformações de cada cópia (k = 1..n-1) a partir do padrão; null se o padrão é inválido. */
export function patternTransforms(s: SketchData, spec: PatternSpec): ((p: P2) => P2)[] | null {
  const ents = allEntities(s);
  const step = patternStep(spec);
  if (step === null) return null;
  const n = Math.round(spec.n);
  const out: ((p: P2) => P2)[] = [];
  if (spec.kind === "linear") {
    const l = ents[spec.dir];
    if (!l || l.type !== "line") return null;
    const d = sub(pt(ents, l.p2), pt(ents, l.p1));
    const len = Math.hypot(d[0], d[1]);
    if (len < 1e-12) return null;
    const u = mul(d, (spec.flip ? -1 : 1) / len);
    for (let k = 1; k < n; k++) { const t = mul(u, step * k); out.push((p) => add(p, t)); }
  } else {
    const c = ents[spec.center];
    if (!c || c.type !== "point") return null;
    const C = pt(ents, spec.center);
    for (let k = 1; k < n; k++) {
      const a = (step * k * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
      out.push((p) => { const q = sub(p, C); return [C[0] + q[0] * co - q[1] * si, C[1] + q[0] * si + q[1] * co]; });
    }
  }
  return out;
}

/**
 * Cria as cópias das entidades `ids` segundo o padrão. Linhas copiadas ficam iguais (e paralelas, no linear) à
 * original; círculos e arcos ficam com raio igual. No circular, pontos sobre o centro são partilhados.
 */
export function sketchPattern(s0: SketchData, ids: string[], spec: PatternSpec): SketchData | null {
  const ents = allEntities(s0);
  const ref = spec.kind === "linear" ? spec.dir : spec.center;
  const items = [...new Set(ids)].filter((id) => id !== ref && s0.entities[id]);
  if (!items.length) return null;
  const tf = patternTransforms(s0, spec);
  if (!tf) return null;
  const curves = items.filter((id) => s0.entities[id].type !== "point");
  const C = spec.kind === "circular" ? pt(ents, spec.center) : null;
  const scale = Math.max(1, ...curves.flatMap((id) => entityPoints(s0.entities[id]).map((p) => Math.hypot(...pt(ents, p)))));
  let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.slice() };
  const deg = spec.kind === "circular" ? patternStep(spec)! : 0;
  tf.forEach((T, k) => {
    const map = new Map<string, string>();
    const image = (p: string): string => {
      const m = map.get(p);
      if (m) return m;
      const P = pt(ents, p);
      let id: string;
      if (C && Math.hypot(P[0] - C[0], P[1] - C[1]) < 1e-9 * scale) id = p;
      else {
        const e = ents[p] as Extract<SketchEntity, { type: "point" }>;
        const r = addPoint(s, T(P), e.construction); s = r.s; id = r.id;
      }
      map.set(p, id);
      return id;
    };
    for (const id of curves) for (const p of entityPoints(s0.entities[id])) image(p);
    for (const id of items.filter((i) => s0.entities[i].type === "point")) image(id);
    const rot = (deg * (k + 1) * Math.PI) / 180;
    for (const id of curves) {
      const e = s0.entities[id];
      // Círculo centrado no centro de rotação: a cópia coincidiria com o original.
      if (entityPoints(e).every((p) => image(p) === p)) continue;
      const cons = e.construction ? { construction: true } : {};
      if (e.type === "line") {
        const r = addLine(s, image(e.p1), image(e.p2), { infer: false, ...cons }); s = r.s;
        s = addConstraint(s, "equal", [id, r.id]).s;
        if (spec.kind === "linear") s = addConstraint(s, "parallel", [id, r.id]).s;
      } else if (e.type === "circle") {
        const r = addEntity(s, "c", { type: "circle", c: image(e.c), r: e.r, ...cons }); s = r.s;
        s = addConstraint(s, "equal", [id, r.id]).s;
      } else if (e.type === "arc") {
        const r = addEntity(s, "a", { type: "arc", c: image(e.c), s: image(e.s), e: image(e.e), r: e.r, a0: e.a0 + rot, a1: e.a1 + rot, ...cons }); s = r.s;
        s = addConstraint(s, "equal", [id, r.id]).s;
      } else if (e.type === "spline") {
        s = addEntity(s, "s", { type: "spline", pts: e.pts.map(image), ...cons }).s;
      }
    }
  });
  return s;
}
