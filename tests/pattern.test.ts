import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { type SketchData, addArc, addCircle, addLine, addPoint } from "../src/sketch/ops.ts";
import { patternStep, sketchPattern } from "../src/sketch/pattern.ts";
import { allEntities, pt } from "../src/sketch/geometry.ts";

before(() => initSolver());

const empty = (): SketchData => ({ entities: {}, constraints: [] });
const near = (a: number[], b: number[]) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6, `${a} ≠ ${b}`);
const line = (s: SketchData, a: [number, number], b: [number, number]) => {
  const p = addPoint(s, a); const q = addPoint(p.s, b);
  const l = addLine(q.s, p.id, q.id, { infer: false });
  return { s: l.s, id: l.id, p1: p.id, p2: q.id };
};
const of = (s: SketchData, t: string) => Object.entries(s.entities).filter(([, e]) => e.type === t);
const centers = (s: SketchData) => { const ents = allEntities(s); return of(s, "circle").map(([, e]) => pt(ents, (e as { c: string }).c)); };
const circle = (x: number, y: number, r = 1) => { const p = addPoint(empty(), [x, y]); return addCircle(p.s, p.id, r); };

test("passo de cada modo", () => {
  assert.equal(patternStep({ kind: "linear", n: 5, mode: "spacing", value: 10, dir: "H" }), 10);
  assert.equal(patternStep({ kind: "linear", n: 5, mode: "total", value: 40, dir: "H" }), 10);
  assert.equal(patternStep({ kind: "circular", n: 6, mode: "full", center: "O" }), 60);
  assert.equal(patternStep({ kind: "circular", n: 4, mode: "total", angle: 90, center: "O" }), 30);
  assert.equal(patternStep({ kind: "circular", n: 4, mode: "step", angle: 45, center: "O" }), 45);
});

test("linear por passo e por comprimento total dão as mesmas posições", () => {
  const c = circle(2, 3);
  const a = sketchPattern(c.s, [c.id], { kind: "linear", n: 4, mode: "spacing", value: 5, dir: "H" })!;
  const b = sketchPattern(c.s, [c.id], { kind: "linear", n: 4, mode: "total", value: 15, dir: "H" })!;
  const ca = centers(a), cb = centers(b);
  assert.equal(ca.length, 4);
  [[2, 3], [7, 3], [12, 3], [17, 3]].forEach((p, i) => { near(ca[i], p); near(cb[i], p); });
  assert.equal(a.constraints.filter((k) => k.type === "equal").length, 3);
  assert.ok(solveSketch(a).ok);
});

test("linear ao longo de uma linha do esboço, com troca de sentido; linhas iguais e paralelas", () => {
  const d = line(empty(), [0, 0], [3, 4]);
  const l = line(d.s, [10, 0], [12, 0]);
  const o = sketchPattern(l.s, [l.id], { kind: "linear", n: 3, mode: "spacing", value: 5, dir: d.id, flip: true })!;
  const ents = allEntities(o);
  const ls = of(o, "line").map(([id]) => id).filter((id) => id !== d.id && id !== l.id);
  assert.equal(ls.length, 2);
  near(pt(ents, (o.entities[ls[0]] as { p1: string }).p1), [7, -4]);
  near(pt(ents, (o.entities[ls[1]] as { p1: string }).p1), [4, -8]);
  assert.equal(o.constraints.filter((k) => k.type === "parallel").length, 2);
  assert.ok(solveSketch(o).ok);
});

test("circular 360°: 4 cópias a 90° à volta da origem", () => {
  const c = circle(10, 0);
  const o = sketchPattern(c.s, [c.id], { kind: "circular", n: 4, mode: "full", center: "O" })!;
  const cs = centers(o);
  assert.equal(cs.length, 4);
  [[10, 0], [0, 10], [-10, 0], [0, -10]].forEach((p, i) => near(cs[i], p));
  assert.ok(solveSketch(o).ok);
});

test("circular por ângulo total parcial e por ângulo entre cópias", () => {
  const c = circle(10, 0);
  const t = centers(sketchPattern(c.s, [c.id], { kind: "circular", n: 3, mode: "total", angle: 90, center: "O" })!);
  const s = centers(sketchPattern(c.s, [c.id], { kind: "circular", n: 3, mode: "step", angle: 45, center: "O" })!);
  const r = 10 / Math.SQRT2;
  [[10, 0], [r, r], [0, 10]].forEach((p, i) => { near(t[i], p); near(s[i], p); });
});

test("circular à volta de um ponto do esboço: linha a sair do centro partilha o ponto; arco roda", () => {
  const ctr = addPoint(empty(), [5, 5]);
  const q = addPoint(ctr.s, [8, 5]);
  const l = addLine(q.s, ctr.id, q.id, { infer: false });
  const a = addArc(l.s, ctr.id, [7, 5], [5, 7]);
  const o = sketchPattern(a.s, [l.id, a.id], { kind: "circular", n: 2, mode: "step", angle: 90, center: ctr.id })!;
  const ents = allEntities(o);
  const nl = of(o, "line").find(([id]) => id !== l.id)![1] as { p1: string; p2: string };
  assert.equal(nl.p1, ctr.id);
  near(pt(ents, nl.p2), [5, 8]);
  const na = of(o, "arc").find(([id]) => id !== a.id)![1] as { c: string; s: string; e: string; a0: number };
  assert.equal(na.c, ctr.id);
  near(pt(ents, na.s), [5, 7]);
  near(pt(ents, na.e), [3, 5]);
  assert.ok(solveSketch(o).ok);
});

test("círculo centrado no centro de rotação não é duplicado", () => {
  const c = circle(0, 0, 3);
  const p = addPoint(c.s, [0, 0]);
  const o = sketchPattern(p.s, [c.id], { kind: "circular", n: 4, mode: "full", center: p.id })!;
  assert.equal(of(o, "circle").length, 1);
});

test("casos inválidos devolvem null", () => {
  const c = circle(2, 3);
  const d = line(c.s, [0, 0], [1, 0]);
  assert.equal(sketchPattern(d.s, [c.id], { kind: "linear", n: 1, mode: "spacing", value: 5, dir: "H" }), null);
  assert.equal(sketchPattern(d.s, [c.id], { kind: "linear", n: 3, mode: "spacing", value: 0, dir: "H" }), null);
  assert.equal(sketchPattern(d.s, [], { kind: "linear", n: 3, mode: "spacing", value: 5, dir: "H" }), null);
  assert.equal(sketchPattern(d.s, [d.id], { kind: "linear", n: 3, mode: "spacing", value: 5, dir: d.id }), null);
  assert.equal(sketchPattern(d.s, [c.id], { kind: "linear", n: 3, mode: "spacing", value: 5, dir: c.id }), null);
  assert.equal(sketchPattern(d.s, [c.id], { kind: "circular", n: 3, mode: "step", angle: 0, center: "O" }), null);
  assert.equal(sketchPattern(d.s, [c.id], { kind: "circular", n: 3, mode: "full", center: d.id }), null);
});
