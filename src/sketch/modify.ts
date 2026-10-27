// Ferramentas de modificação do esboço: aparar, estender, filete de canto e deslocamento (offset).
// Funções puras sobre SketchData, como as de ops.ts.
import type { SketchConstraint, SketchEntity } from "../doc/types.ts";
import { type P2, add, allEntities, arcSweep, cross, dist, dot, entityPoints, len, mul, pt, sampleEntity, sub } from "./geometry.ts";
import { type SketchData, addConstraint, addEntity, addPoint, deleteItems, mergePoints } from "./ops.ts";

type Line = Extract<SketchEntity, { type: "line" }>;
type Arc = Extract<SketchEntity, { type: "arc" }>;

const TAU = 2 * Math.PI;
const norm = (a: P2): P2 => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const angleOf = (c: P2, p: P2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

// ---------------------------------------------------------------------------
// Interseções
// ---------------------------------------------------------------------------

/** Peças geométricas elementares de uma entidade (para interseções). */
type Piece = { k: "seg"; a: P2; b: P2 } | { k: "circ"; c: P2; r: number; a0?: number; sw?: number };

function pieces(ents: Record<string, SketchEntity>, id: string): Piece[] {
  const e = ents[id];
  if (e.type === "line") return [{ k: "seg", a: pt(ents, e.p1), b: pt(ents, e.p2) }];
  if (e.type === "circle") return [{ k: "circ", c: pt(ents, e.c), r: e.r }];
  if (e.type === "arc") return [{ k: "circ", c: pt(ents, e.c), r: e.r, a0: e.a0, sw: arcSweep(e.a0, e.a1) }];
  if (e.type === "spline") {
    const poly = sampleEntity(ents, id);
    return poly.slice(1).map((b, i) => ({ k: "seg" as const, a: poly[i], b }));
  }
  return [];
}

const onArc = (p: Piece & { k: "circ" }, q: P2, eps = 1e-9) => p.sw === undefined || wrap(angleOf(p.c, q) - p.a0!) <= p.sw + eps;

/** Interseções da reta (infinita) a→b com uma peça: parâmetros t na reta. */
function lineHits(a: P2, b: P2, pc: Piece): number[] {
  const d = sub(b, a);
  if (pc.k === "seg") {
    const e = sub(pc.b, pc.a);
    const den = cross(d, e);
    if (Math.abs(den) < 1e-12) return [];
    const w = sub(pc.a, a);
    const t = cross(w, e) / den, u = cross(w, d) / den;
    return u >= -1e-9 && u <= 1 + 1e-9 ? [t] : [];
  }
  const f = sub(a, pc.c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - pc.r * pc.r;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-18) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => onArc(pc, add(a, mul(d, t))));
}

/** Interseções de uma circunferência com uma peça: ângulos na circunferência. */
function circleHits(c: P2, r: number, pc: Piece): number[] {
  if (pc.k === "seg") {
    const d = sub(pc.b, pc.a), f = sub(pc.a, c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A < 1e-18) return [];
    const s = Math.sqrt(disc);
    return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((u) => u >= -1e-9 && u <= 1 + 1e-9).map((u) => angleOf(c, add(pc.a, mul(d, u))));
  }
  const D = dist(c, pc.c);
  if (D < 1e-12 || D > r + pc.r + 1e-9 || D < Math.abs(r - pc.r) - 1e-9) return [];
  const a = (r * r - pc.r * pc.r + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(0, r * r - a * a));
  const u = norm(sub(pc.c, c));
  const m = add(c, mul(u, a));
  const pts: P2[] = h < 1e-12 ? [m] : [add(m, [-u[1] * h, u[0] * h]), add(m, [u[1] * h, -u[0] * h])];
  return pts.filter((q) => onArc(pc, q)).map((q) => angleOf(c, q));
}

/** Outras entidades que podem cortar/limitar (todas as curvas, incluindo construção). */
const cutters = (ents: Record<string, SketchEntity>, self: string) =>
  Object.keys(ents).filter((id) => id !== self && !(id in { O: 1, H: 1, V: 1, _hx: 1, _vy: 1 }) && ents[id].type !== "point");

// ---------------------------------------------------------------------------
// Aparar
// ---------------------------------------------------------------------------

/** Restrições que deixam de fazer sentido quando a entidade é cortada (cotas de comprimento, etc.). */
function keepConstraintsFor(s: SketchData, id: string, drop: (c: SketchConstraint) => boolean): SketchConstraint[] {
  return s.constraints.filter((c) => !(c.refs.includes(id) && drop(c)));
}

/**
 * Apaga a parte da entidade entre as interseções mais próximas do ponto clicado (como no SolidWorks).
 * Sem interseções, apaga a entidade inteira. Os novos extremos ficam "ponto em" a entidade que os cortou.
 */
export function trim(s0: SketchData, id: string, click: P2): SketchData {
  const ents = allEntities(s0);
  const e = ents[id];
  if (!e || e.type === "point" || e.type === "spline") return e?.type === "spline" ? deleteItems(s0, [id]) : s0;
  const others = cutters(ents, id);

  if (e.type === "line") {
    const a = pt(ents, e.p1), b = pt(ents, e.p2), d = sub(b, a);
    const hits: { t: number; by: string }[] = [];
    for (const o of others) for (const pc of pieces(ents, o)) for (const t of lineHits(a, b, pc)) if (t > 1e-6 && t < 1 - 1e-6) hits.push({ t, by: o });
    if (!hits.length) return deleteItems(s0, [id]);
    const tc = Math.max(0, Math.min(1, dot(sub(click, a), d) / dot(d, d)));
    const lo = hits.filter((h) => h.t < tc).sort((x, y) => y.t - x.t)[0];
    const hi = hits.filter((h) => h.t > tc).sort((x, y) => x.t - y.t)[0];
    const at = (t: number) => add(a, mul(d, t));
    let s = s0;
    // restrições de comprimento deixam de valer
    s = { ...s, constraints: keepConstraintsFor(s, id, (c) => c.type === "distance" && c.refs.length === 1) };
    if (lo && hi) {
      // corte a meio: a linha fica de p1 até lo, e nasce uma nova de hi até p2
      const pa = addPoint(s, at(lo.t)); s = pa.s;
      const pb = addPoint(s, at(hi.t)); s = pb.s;
      s.entities[id] = { ...e, p2: pa.id };
      const nl = addEntity(s, "l", { type: "line", p1: pb.id, p2: e.p2, ...(e.construction ? { construction: true } : {}) }); s = nl.s;
      s = addConstraint(s, "pointOn", [pa.id, lo.by]).s;
      s = addConstraint(s, "pointOn", [pb.id, hi.by]).s;
      s = addConstraint(s, "collinear", [id, nl.id]).s;
      // o extremo p2 passa a pertencer à nova linha: as restrições do tipo H/V copiam-se
      for (const c of s.constraints.filter((c) => c.refs.length === 1 && c.refs[0] === id && (c.type === "horizontal" || c.type === "vertical"))) s = addConstraint(s, c.type, [nl.id]).s;
      return s;
    }
    const keepFrom = lo ? "p1" : "p2"; // o lado que fica
    const cut = lo ?? hi!;
    const np = addPoint(s, at(cut.t)); s = np.s;
    s.entities[id] = keepFrom === "p1" ? { ...e, p2: np.id } : { ...e, p1: np.id };
    s = addConstraint(s, "pointOn", [np.id, cut.by]).s;
    return dropOrphans(s, [keepFrom === "p1" ? e.p2 : e.p1]);
  }

  // círculo ou arco: parâmetro angular
  const c = pt(ents, e.c);
  const a0 = e.type === "arc" ? e.a0 : 0;
  const sw = e.type === "arc" ? arcSweep(e.a0, e.a1) : TAU;
  const rel = (ang: number) => wrap(ang - a0);
  const hits: { u: number; by: string }[] = [];
  for (const o of others) for (const pc of pieces(ents, o)) for (const ang of circleHits(c, e.r, pc)) {
    const u = rel(ang);
    if (e.type === "circle" || (u > 1e-6 && u < sw - 1e-6)) hits.push({ u, by: o });
  }
  const uc = rel(angleOf(c, click));
  const at = (u: number): P2 => [c[0] + e.r * Math.cos(a0 + u), c[1] + e.r * Math.sin(a0 + u)];
  let s: SketchData = { ...s0, constraints: s0.constraints };

  if (e.type === "circle") {
    const us = [...new Set(hits.map((h) => Math.round(h.u * 1e9) / 1e9))].sort((x, y) => x - y);
    if (us.length < 2) return deleteItems(s0, [id]);
    // intervalo [lo, hi] (circular) que contém o clique é removido; fica o arco de hi a lo
    let lo = us.filter((u) => u <= uc).at(-1), hi = us.find((u) => u > uc);
    if (lo === undefined) lo = us.at(-1)!;
    if (hi === undefined) hi = us[0];
    const byOf = (u: number) => hits.find((h) => Math.abs(h.u - u) < 1e-6)!.by;
    const ps = addPoint(s, at(hi)); s = ps.s;
    const pe = addPoint(s, at(lo)); s = pe.s;
    s.entities[id] = { type: "arc", c: e.c, s: ps.id, e: pe.id, r: e.r, a0: wrap(a0 + hi), a1: wrap(a0 + lo), ...(e.construction ? { construction: true } : {}) };
    s = addConstraint(s, "pointOn", [ps.id, byOf(hi)]).s;
    s = addConstraint(s, "pointOn", [pe.id, byOf(lo)]).s;
    return s;
  }

  // arco
  if (!hits.length) return deleteItems(s0, [id]);
  const lo = hits.filter((h) => h.u < uc).sort((x, y) => y.u - x.u)[0];
  const hi = hits.filter((h) => h.u > uc).sort((x, y) => x.u - y.u)[0];
  if (lo && hi) {
    const pa = addPoint(s, at(lo.u)); s = pa.s;
    const pb = addPoint(s, at(hi.u)); s = pb.s;
    s.entities[id] = { ...e, e: pa.id, a1: wrap(a0 + lo.u) };
    const na = addEntity(s, "a", { type: "arc", c: e.c, s: pb.id, e: e.e, r: e.r, a0: wrap(a0 + hi.u), a1: e.a1, ...(e.construction ? { construction: true } : {}) }); s = na.s;
    s = addConstraint(s, "pointOn", [pa.id, lo.by]).s;
    s = addConstraint(s, "pointOn", [pb.id, hi.by]).s;
    s = addConstraint(s, "equal", [id, na.id]).s;
    return s;
  }
  const cut = lo ?? hi!;
  const np = addPoint(s, at(cut.u)); s = np.s;
  if (lo) s.entities[id] = { ...e, e: np.id, a1: wrap(a0 + cut.u) };
  else s.entities[id] = { ...e, s: np.id, a0: wrap(a0 + cut.u) };
  s = addConstraint(s, "pointOn", [np.id, cut.by]).s;
  return dropOrphans(s, [lo ? e.e : e.s]);
}

/** Apaga pontos que deixaram de ser usados por curvas (e as suas restrições). */
function dropOrphans(s: SketchData, candidates: string[]): SketchData {
  const used = new Set(Object.values(s.entities).flatMap(entityPoints));
  const gone = candidates.filter((p) => s.entities[p] && !used.has(p));
  return gone.length ? deleteItems(s, gone) : s;
}

// ---------------------------------------------------------------------------
// Estender
// ---------------------------------------------------------------------------

/** Prolonga o extremo da linha (ou arco) mais próximo do clique até à primeira entidade que encontrar. */
export function extend(s0: SketchData, id: string, click: P2): SketchData | null {
  const ents = allEntities(s0);
  const e = ents[id];
  const others = cutters(ents, id);
  if (e?.type === "line") {
    const a = pt(ents, e.p1), b = pt(ents, e.p2);
    const fromEnd = dist(click, b) <= dist(click, a);
    const [p, q] = fromEnd ? [a, b] : [b, a]; // prolongar para lá de q
    let best: { t: number; by: string } | null = null;
    for (const o of others) for (const pc of pieces(ents, o)) for (const t of lineHits(p, q, pc)) if (t > 1 + 1e-6 && (!best || t < best.t)) best = { t, by: o };
    if (!best) return null;
    const target = add(p, mul(sub(q, p), best.t));
    const moving = fromEnd ? e.p2 : e.p1;
    const shared = Object.entries(s0.entities).some(([k, x]) => k !== id && entityPoints(x).includes(moving));
    let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.filter((c) => !(c.type === "distance" && c.refs.length === 1 && c.refs[0] === id)) };
    let pid = moving;
    if (shared) { const np = addPoint(s, target); s = np.s; pid = np.id; s.entities[id] = fromEnd ? { ...e, p2: pid } : { ...e, p1: pid }; }
    else s.entities[moving] = { ...(s.entities[moving] as Extract<SketchEntity, { type: "point" }>), x: target[0], y: target[1] };
    return addConstraint(s, "pointOn", [pid, best.by]).s;
  }
  if (e?.type === "arc") {
    const c = pt(ents, e.c);
    const sw = arcSweep(e.a0, e.a1);
    const atEnd = dist(click, pt(ents, e.e)) <= dist(click, pt(ents, e.s));
    let best: { d: number; ang: number; by: string } | null = null;
    for (const o of others) for (const pc of pieces(ents, o)) for (const ang of circleHits(c, e.r, pc)) {
      const d = atEnd ? wrap(ang - e.a1) : wrap(e.a0 - ang);
      if (d > 1e-6 && d < TAU - sw - 1e-6 && (!best || d < best.d)) best = { d, ang, by: o };
    }
    if (!best) return null;
    const target: P2 = [c[0] + e.r * Math.cos(best.ang), c[1] + e.r * Math.sin(best.ang)];
    const moving = atEnd ? e.e : e.s;
    let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints };
    s.entities[moving] = { ...(s.entities[moving] as Extract<SketchEntity, { type: "point" }>), x: target[0], y: target[1] };
    s.entities[id] = atEnd ? { ...e, a1: best.ang } : { ...e, a0: best.ang };
    s = addConstraint(s, "pointOn", [moving, best.by]).s;
    return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filete de canto
// ---------------------------------------------------------------------------

/** Substitui o canto entre duas linhas (no ponto `corner`) por um arco tangente de raio r. */
export function sketchFillet(s0: SketchData, corner: string, r: number): SketchData | null {
  const ents = allEntities(s0);
  const lines = Object.entries(s0.entities).filter(([, e]) => e.type === "line" && (e.p1 === corner || e.p2 === corner)) as [string, Line][];
  if (lines.length !== 2 || r <= 0) return null;
  const P = pt(ents, corner);
  const other = (l: Line) => pt(ents, l.p1 === corner ? l.p2 : l.p1);
  const u1 = norm(sub(other(lines[0][1]), P)), u2 = norm(sub(other(lines[1][1]), P));
  const cosT = Math.max(-1, Math.min(1, dot(u1, u2)));
  const theta = Math.acos(cosT) / 2;
  if (theta < 1e-6 || Math.abs(theta - Math.PI / 2) < 1e-6) return null;
  const dT = r / Math.tan(theta);
  if (dT >= dist(P, other(lines[0][1])) || dT >= dist(P, other(lines[1][1]))) return null;
  const T1 = add(P, mul(u1, dT)), T2 = add(P, mul(u2, dT));
  const C = add(P, mul(norm(add(u1, u2)), r / Math.sin(theta)));
  let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.filter((c) => !c.refs.includes(corner)) };
  const p1 = addPoint(s, T1); s = p1.s;
  const p2 = addPoint(s, T2); s = p2.s;
  const pc = addPoint(s, C, true); s = pc.s;
  for (const [lid, l] of lines.map(([i]) => [i, s.entities[i] as Line] as const)) {
    const np = lid === lines[0][0] ? p1.id : p2.id;
    s.entities[lid] = l.p1 === corner ? { ...l, p1: np } : { ...l, p2: np };
  }
  // sentido anti-horário de T1 para T2 em torno de C, pelo lado do canto
  const a1 = angleOf(C, T1), a2 = angleOf(C, T2);
  const ccw = cross(sub(T1, C), sub(T2, C)) > 0;
  const arc = addEntity(s, "a", ccw
    ? { type: "arc", c: pc.id, s: p1.id, e: p2.id, r, a0: a1, a1: a2 }
    : { type: "arc", c: pc.id, s: p2.id, e: p1.id, r, a0: a2, a1: a1 });
  s = arc.s;
  s = addConstraint(s, "tangent", [lines[0][0], arc.id]).s;
  s = addConstraint(s, "tangent", [lines[1][0], arc.id]).s;
  s = addConstraint(s, "radius", [arc.id], r).s;
  return dropOrphans(s, [corner]);
}

// ---------------------------------------------------------------------------
// Deslocamento (offset)
// ---------------------------------------------------------------------------

/**
 * Copia entidades à distância d (positiva para um lado, negativa para o outro).
 * Linhas ligadas entre si mantêm os cantos (interseção das linhas deslocadas); arcos e círculos ficam concêntricos.
 * O lado é relativo à cadeia: para cadeias fechadas anti-horárias, d > 0 é para fora.
 */
export function offset(s0: SketchData, ids: string[], d: number): SketchData {
  const ents = allEntities(s0);
  let s: SketchData = { entities: { ...s0.entities }, constraints: s0.constraints.slice() };
  const sel = ids.filter((id) => ents[id] && ["line", "arc", "circle"].includes(ents[id].type));
  // ordenar as linhas e arcos em cadeias pelos pontos partilhados
  const newPointFor = new Map<string, string>(); // ponto original → ponto deslocado (cantos)
  const offsetPoint = new Map<string, P2[]>(); // ponto original → posições propostas por cada entidade
  const segs: { id: string; kind: "line" | "arc"; a?: P2; b?: P2; e: SketchEntity }[] = [];
  const area = signedAreaOf(ents, sel);
  const side = area >= 0 ? 1 : -1; // contorno anti-horário: normal exterior à direita do sentido
  const lineOff = new Map<string, P2[]>(); // posições propostas pelas linhas deslocadas
  for (const id of sel) {
    const e = ents[id];
    if (e.type === "circle") {
      const r = e.r + d;
      if (r <= 0) continue;
      const c = addEntity(s, "c", { type: "circle", c: e.c, r }); s = c.s;
      s = addConstraint(s, "concentric", [id, c.id]).s;
    } else if (e.type === "line") {
      const a = pt(ents, e.p1), b = pt(ents, e.p2);
      const n = norm([b[1] - a[1], -(b[0] - a[0])]); // à direita do sentido a→b
      const off = mul(n, d * side);
      segs.push({ id, kind: "line", a: add(a, off), b: add(b, off), e });
      for (const [k, q] of [[e.p1, add(a, off)], [e.p2, add(b, off)]] as [string, P2][]) {
        offsetPoint.set(k, [...(offsetPoint.get(k) ?? []), q]);
        lineOff.set(k, [...(lineOff.get(k) ?? []), q]);
      }
    }
  }
  for (const id of sel) {
    const e = ents[id];
    if (e.type !== "arc") continue;
    const c = pt(ents, e.c);
    const ends = (r: number): [P2, P2] => [[c[0] + r * Math.cos(e.a0), c[1] + r * Math.sin(e.a0)], [c[0] + r * Math.cos(e.a1), c[1] + r * Math.sin(e.a1)]];
    // raio: o que liga às linhas vizinhas deslocadas (concordância convexa ou côncava)
    const cands = [e.r + Math.abs(d), e.r - Math.abs(d)].filter((r) => r > 0);
    const score = (r: number) => { const [a, b] = ends(r); return [[e.s, a], [e.e, b]].reduce((acc, [k, q]) => acc + Math.min(Infinity, ...(lineOff.get(k as string) ?? []).map((x) => dist(x, q as P2))), 0); };
    const linked = (lineOff.get(e.s)?.length ?? 0) + (lineOff.get(e.e)?.length ?? 0) > 0;
    const r = linked ? cands.sort((x, y) => score(x) - score(y))[0] : e.r + d;
    if (!r || r <= 0) continue;
    const [a, b] = ends(r);
    segs.push({ id, kind: "arc", a, b, e: { ...e, r } });
    offsetPoint.set(e.s, [...(offsetPoint.get(e.s) ?? []), a]);
    offsetPoint.set(e.e, [...(offsetPoint.get(e.e) ?? []), b]);
  }
  // cantos: onde duas linhas deslocadas se encontram, usar a interseção das retas
  for (const [p, cands] of offsetPoint) {
    let pos = cands[0];
    if (cands.length === 2) {
      const ls = segs.filter((g) => g.kind === "line" && entityPoints(g.e).includes(p));
      if (ls.length === 2) {
        const [g1, g2] = ls;
        const d1 = sub(g1.b!, g1.a!), d2 = sub(g2.b!, g2.a!);
        const den = cross(d1, d2);
        if (Math.abs(den) > 1e-12) pos = add(g1.a!, mul(d1, cross(sub(g2.a!, g1.a!), d2) / den));
      } else pos = mul(add(cands[0], cands[1]), 0.5);
    }
    const np = addPoint(s, pos); s = np.s;
    newPointFor.set(p, np.id);
  }
  for (const g of segs) {
    if (g.kind === "line") {
      const e = g.e as Line;
      const nl = addEntity(s, "l", { type: "line", p1: newPointFor.get(e.p1)!, p2: newPointFor.get(e.p2)! }); s = nl.s;
      // paralela e à distância |d| da original: a cópia acompanha a original (como o offset do SolidWorks)
      s = addConstraint(s, "parallel", [g.id, nl.id]).s;
      s = addConstraint(s, "distance", [e.p1, nl.id], Math.abs(d)).s;
    } else {
      const e = g.e as Arc;
      const na = addEntity(s, "a", { type: "arc", c: e.c, s: newPointFor.get(e.s)!, e: newPointFor.get(e.e)!, r: e.r, a0: e.a0, a1: e.a1 }); s = na.s;
      s = addConstraint(s, "concentric", [g.id, na.id]).s;
    }
  }
  return s;
}

function signedAreaOf(ents: Record<string, SketchEntity>, ids: string[]): number {
  // área com sinal da polilinha das linhas selecionadas, encadeadas pela ordem dada
  let a = 0;
  for (const id of ids) {
    const e = ents[id];
    if (e.type !== "line") continue;
    const p = pt(ents, e.p1), q = pt(ents, e.p2);
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export { mergePoints };

/** Curvas ligadas (por pontos partilhados) à curva dada, incluindo ela: a cadeia para o deslocamento. */
export function connectedCurves(s: SketchData, id: string): string[] {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    const pts = new Set([...out].flatMap((k) => entityPoints(s.entities[k])));
    for (const [k, e] of Object.entries(s.entities)) {
      if (out.has(k) || e.type === "point" || e.type === "circle") continue;
      if (entityPoints(e).some((p) => pts.has(p) && !(e.type === "arc" && p === e.c))) { out.add(k); grew = true; }
    }
  }
  return [...out];
}

/** Ponto de canto entre exatamente duas linhas (candidato a filete de esboço). */
export function isLineCorner(s: SketchData, pid: string): boolean {
  return Object.values(s.entities).filter((e) => e.type === "line" && (e.p1 === pid || e.p2 === pid)).length === 2;
}
