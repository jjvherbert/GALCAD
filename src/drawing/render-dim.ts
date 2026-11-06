// Cotas do desenho (ISO 129-1) e ligação ao PMI: âncoras, cotas lineares/circulares/angulares.
import type { Anchor, Annotation, GdtChar } from "../doc/project.ts";
import type { Curve2D, PmiInView } from "../kernel/protocol.ts";
import { curveAnchor, dist, normAngle } from "./geom2d.ts";
import { type P, type Prim, add, arrow, mul, textWidth } from "./prims.ts";
import { type Ctx, fmtNum, toSheet } from "./render-base.ts";

/** Curva (coordenadas da vista) de uma aresta numa vista; procura também pelo nome base (~k). */
function edgeCurve(ctx: Ctx, view: string, edge: string): Curve2D | null {
  const r = ctx.res?.views[view];
  if (!r) return null;
  if (r.edges[edge]) return r.edges[edge];
  const base = (n: string) => n.replace(/~\d+/g, "");
  const k = Object.keys(r.edges).find((n) => base(n) === base(edge));
  return k ? r.edges[k] : null;
}

/** Ponto da folha de uma âncora (ou null se a aresta deixou de existir). */
export function anchorPoint(ctx: Ctx, a: Anchor): P | null {
  const pl = ctx.pl[a.view];
  if (!pl) return null;
  if ("point" in a) return toSheet(pl, a.point);
  const c = edgeCurve(ctx, a.view, a.edge);
  return c ? toSheet(pl, curveAnchor(c, a.at)) : null;
}

function dimText(value: number, ann: Extract<Annotation, { kind: "dim" }>, prefix = ""): string {
  return `${ann.prefix ?? prefix}${fmtNum(value, ann.precision ?? 2)}${ann.tol?.fit ? ` ${ann.tol.fit}` : ""}`;
}

/** Texto de cota (com tolerância empilhada) centrado em `at`, rodado `ang`. */
function dimLabel(text: string, at: P, ang: number, ann: Extract<Annotation, { kind: "dim" }>, ref: string): Prim[] {
  const h = 3.5;
  // texto legível: entre −90° e 90°
  let a = ang;
  if (a > Math.PI / 2 + 1e-6) a -= Math.PI; else if (a < -Math.PI / 2 + 1e-6) a += Math.PI;
  const out: Prim[] = [{ t: "text", at, text, h, angle: a, align: "middle", layer: "dim", ref }];
  if (ann.tol && (ann.tol.plus || ann.tol.minus)) {
    const w = textWidth(text, h) / 2 + 0.8;
    const dx: P = [Math.cos(a), Math.sin(a)], dy: P = [-Math.sin(a), Math.cos(a)];
    const base = add(at, mul(dx, w));
    if (ann.tol.plus) out.push({ t: "text", at: add(base, mul(dy, h * 0.55)), text: ann.tol.plus, h: h * 0.7, angle: a, layer: "dim", ref });
    if (ann.tol.minus) out.push({ t: "text", at: base, text: ann.tol.minus, h: h * 0.7, angle: a, layer: "dim", ref });
  }
  return out;
}

function linearDim(A: P, B: P, type: "horizontal" | "vertical" | "aligned", value: number, ann: Extract<Annotation, { kind: "dim" }>, ref: string): Prim[] {
  const d: P = type === "horizontal" ? [1, 0] : type === "vertical" ? [0, 1] : (() => { const l = dist(A, B) || 1; return [(B[0] - A[0]) / l, (B[1] - A[1]) / l] as P; })();
  const n: P = [-d[1], d[0]];
  const dot = (p: P, q: P) => p[0] * q[0] + p[1] * q[1];
  const M: P = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const lineN = (type === "aligned" ? dot(M, n) : Math.max(dot(A, n), dot(B, n)) * (ann.offset >= 0 ? 1 : 0) + Math.min(dot(A, n), dot(B, n)) * (ann.offset >= 0 ? 0 : 1)) + ann.offset;
  const foot = (p: P): P => add(p, mul(n, lineN - dot(p, n)));
  const A2 = foot(A), B2 = foot(B);
  const out: Prim[] = [];
  const ext = (p: P, q: P) => {
    const s = Math.sign(dot(q, n) - dot(p, n)) || 1;
    out.push({ t: "line", a: add(p, mul(n, s * 1)), b: add(q, mul(n, s * 2)), layer: "dim", ref });
  };
  ext(A, A2); ext(B, B2);
  out.push({ t: "line", a: A2, b: B2, layer: "dim", ref });
  const L = dist(A2, B2);
  const u: P = L > 1e-9 ? [(B2[0] - A2[0]) / L, (B2[1] - A2[1]) / L] : d;
  if (L > 8) { out.push(arrow(A2, mul(u, -1), "dim"), arrow(B2, u, "dim")); }
  else { out.push(arrow(A2, u, "dim"), arrow(B2, mul(u, -1), "dim"), { t: "line", a: A2, b: add(A2, mul(u, -6)), layer: "dim", ref }, { t: "line", a: B2, b: add(B2, mul(u, 6)), layer: "dim", ref }); }
  const ang = Math.atan2(u[1], u[0]);
  const up: P = [-Math.sin(ang > Math.PI / 2 || ang < -Math.PI / 2 ? ang - Math.PI : ang), Math.cos(ang > Math.PI / 2 || ang < -Math.PI / 2 ? ang - Math.PI : ang)];
  out.push(...dimLabel(dimText(value, ann), add([(A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2], mul(up, 1.2)), ang, ann, ref));
  return out;
}

function circleDim(C: P, r: number, diameter: boolean, value: number, ann: Extract<Annotation, { kind: "dim" }>, ref: string): Prim[] {
  const ang = ((ann.angle ?? 45) * Math.PI) / 180;
  const u: P = [Math.cos(ang), Math.sin(ang)];
  const edge = add(C, mul(u, r));
  const out: Prim[] = [];
  const ext = Math.max(4, ann.offset);
  const tail = add(edge, mul(u, ext));
  if (diameter) {
    const opp = add(C, mul(u, -r));
    out.push({ t: "line", a: opp, b: tail, layer: "dim", ref }, arrow(edge, u, "dim"), arrow(opp, mul(u, -1), "dim"));
  } else {
    out.push({ t: "line", a: C, b: tail, layer: "dim", ref }, arrow(edge, u, "dim"));
  }
  const text = dimText(value, ann, diameter ? "⌀" : "R");
  const right = u[0] >= 0;
  const w = textWidth(text, 3.5) + 2;
  const shoulder = add(tail, [right ? w : -w, 0]);
  out.push({ t: "line", a: tail, b: shoulder, layer: "dim", ref });
  out.push(...dimLabel(text, [(tail[0] + shoulder[0]) / 2, tail[1] + 1.2], 0, ann, ref));
  return out;
}

function angleDim(ctx: Ctx, ann: Extract<Annotation, { kind: "dim" }>, ref: string): Prim[] {
  if (!("edge" in ann.a) || !ann.b || !("edge" in ann.b)) return [];
  const ca = edgeCurve(ctx, ann.a.view, ann.a.edge), cb = edgeCurve(ctx, ann.b.view, ann.b.edge);
  const pl = ctx.pl[ann.a.view];
  if (!ca || !cb || ca.k !== "l" || cb.k !== "l" || !pl) return [];
  const a1 = toSheet(pl, ca.a), a2 = toSheet(pl, ca.b), b1 = toSheet(pl, cb.a), b2 = toSheet(pl, cb.b);
  const da: P = [a2[0] - a1[0], a2[1] - a1[1]], db: P = [b2[0] - b1[0], b2[1] - b1[1]];
  const den = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(den) < 1e-9) return [];
  const t = ((b1[0] - a1[0]) * db[1] - (b1[1] - a1[1]) * db[0]) / den;
  const X = add(a1, mul(da, t));
  // as direções a partir do vértice para o lado onde estão as arestas
  const dir = (p: P, q: P): P => { const f = dist(X, p) > dist(X, q) ? p : q; const l = dist(X, f) || 1; return [(f[0] - X[0]) / l, (f[1] - X[1]) / l]; };
  const ua = dir(a1, a2), ub = dir(b1, b2);
  let t0 = Math.atan2(ua[1], ua[0]), t1 = Math.atan2(ub[1], ub[0]);
  if (normAngle(t1 - t0) > Math.PI) [t0, t1] = [t1, t0];
  const r = Math.max(8, ann.offset);
  const value = (normAngle(t1 - t0) * 180) / Math.PI;
  const out: Prim[] = [{ t: "arc", c: X, r, a0: t0, a1: t1, layer: "dim", ref }];
  out.push(arrow(add(X, mul([Math.cos(t0), Math.sin(t0)], r)), [Math.sin(t0), -Math.cos(t0)], "dim"));
  out.push(arrow(add(X, mul([Math.cos(t1), Math.sin(t1)], r)), [-Math.sin(t1), Math.cos(t1)], "dim"));
  const tm = t0 + normAngle(t1 - t0) / 2;
  out.push(...dimLabel(`${fmtNum(value, ann.precision ?? 1)}°`, add(X, mul([Math.cos(tm), Math.sin(tm)], r + 3)), tm - Math.PI / 2, ann, ref));
  return out;
}

/** Tolerância de um item PMI no formato das cotas do desenho (afastamentos empilhados ou classe ISO 286). */
export function pmiTol(t: Extract<PmiInView, { kind: "dim" }>["tol"]): Extract<Annotation, { kind: "dim" }>["tol"] {
  if (!t) return undefined;
  if (t.kind === "fit") return { fit: t.code };
  const s = (x: number) => (x > 0 ? `+${fmtNum(x, 3)}` : x < 0 ? `−${fmtNum(-x, 3)}` : "0");
  return { plus: s(t.upper), minus: s(t.lower) };
}

const PMI_GDT: Record<string, GdtChar> = { circularRunout: "runout" };

/**
 * Anotação ligada ao PMI: conteúdo e ponto de ancoragem lidos do item PMI projetado na vista.
 * Devolve a anotação a desenhar (com âncora {vista, ponto}) ou null se o item já não estiver na vista.
 */
export function fromPmi(ctx: Ctx, a: Annotation): Annotation | null {
  if (!("pmi" in a) || !a.pmi) return a;
  const link = a.pmi;
  const e = ctx.res?.views[link.view]?.pmi?.find((x) => x.item === link.item);
  if (!e) { ctx.warnings.push(`PMI ${link.item} já não existe nesta vista (o item foi apagado ou mudou de orientação)`); return null; }
  const tip: Anchor = { view: link.view, point: e.kind === "dim" ? e.a : e.at };
  if (e.kind === "dim") return null; // as cotas ligadas ao PMI desenham-se em dimension()
  return applyPmi(a, e, tip);
}

/** Conteúdo de um rótulo PMI (GD&T, referência, rugosidade, nota) aplicado à anotação do desenho. */
export function applyPmi(a: Annotation, e: Extract<PmiInView, { kind: "label" }>, tip: Anchor): Annotation | null {
  const d = e.data;
  switch (a.kind) {
    case "gdt": return d.kind === "gdt" ? { ...a, leader: tip, char: PMI_GDT[d.characteristic] ?? (d.characteristic as GdtChar), tol: fmtNum(d.value, 3), dia: d.diameter, modifier: d.modifier, datums: d.datums } : null;
    case "datum": return d.kind === "datum" ? { ...a, anchor: tip, letter: d.label } : null;
    case "surface": return d.kind === "roughness" ? { ...a, anchor: tip, process: d.process === "remove" ? "removal" : d.process === "noremove" ? "noRemoval" : "any", value: `Ra ${fmtNum(d.ra, 3)}` } : null;
    case "note": return { ...a, leader: tip, text: e.text };
    default: return a;
  }
}

export function dimension(ctx: Ctx, ann: Extract<Annotation, { kind: "dim" }>): Prim[] {
  const ref = `ann:${ann.id}`;
  if (ann.pmi) {
    const pl = ctx.pl[ann.pmi.view];
    const e = ctx.res?.views[ann.pmi.view]?.pmi?.find((x) => x.item === ann.pmi!.item);
    if (!pl || !e || e.kind !== "dim") { ctx.warnings.push(`Cota PMI ${ann.pmi.item} já não existe nesta vista`); return []; }
    const A = toSheet(pl, e.a), B = toSheet(pl, e.b);
    const eff = { ...ann, prefix: e.prefix ?? ann.prefix, tol: pmiTol(e.tol) };
    if (e.type === "radius" || e.type === "diameter") return circleDim(A, dist(A, B), e.type === "diameter", e.value, eff, ref);
    return linearDim(A, B, e.type, e.value, eff, ref);
  }
  if (ann.model) {
    const md = ctx.res?.views[ann.model.view]?.modelDims.find((m) => m.feature === ann.model!.feature && m.constraint === ann.model!.constraint);
    const pl = ctx.pl[ann.model.view];
    if (!md || !pl) { ctx.warnings.push(`Cota do modelo ${ann.model.constraint} já não existe`); return []; }
    const A = toSheet(pl, md.a), B = toSheet(pl, md.b);
    if (md.type === "radius" || md.type === "diameter") return circleDim(A, dist(A, B), md.type === "diameter", md.value, ann, ref);
    return linearDim(A, B, md.type, md.value, ann, ref);
  }
  if (ann.type === "angle") return angleDim(ctx, ann, ref);
  if (ann.type === "radius" || ann.type === "diameter") {
    if (!("edge" in ann.a)) return [];
    const c = edgeCurve(ctx, ann.a.view, ann.a.edge);
    const pl = ctx.pl[ann.a.view];
    if (!c || !pl || (c.k !== "c" && c.k !== "a")) { ctx.warnings.push("Cota de raio/diâmetro sem círculo (a aresta mudou?)"); return []; }
    return circleDim(toSheet(pl, c.c), c.r * pl.s, ann.type === "diameter", ann.type === "diameter" ? 2 * c.r : c.r, ann, ref);
  }
  const A = anchorPoint(ctx, ann.a), B = ann.b ? anchorPoint(ctx, ann.b) : null;
  if (!A || !B) { ctx.warnings.push("Cota com referência que já não existe"); return [{ t: "text", at: A ?? B ?? [20, 20], text: "?", h: 3.5, layer: "error", ref }]; }
  const view = "view" in ann.a ? ann.a.view : "";
  const s = ctx.pl[view]?.s ?? 1;
  const value = ann.type === "horizontal" ? Math.abs(B[0] - A[0]) / s : ann.type === "vertical" ? Math.abs(B[1] - A[1]) / s : dist(A, B) / s;
  return linearDim(A, B, ann.type, value, ann, ref);
}
