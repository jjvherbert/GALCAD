import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { type SketchData, addArc, addCircle, addLine, addPoint } from "../src/sketch/ops.ts";
import { reflect, sketchMirror } from "../src/sketch/mirror.ts";
import { allEntities, pt } from "../src/sketch/geometry.ts";

before(() => initSolver());

const empty = (): SketchData => ({ entities: {}, constraints: [] });
const near = (a: number[], b: number[]) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6, `${a} ≠ ${b}`);
const line = (s: SketchData, a: [number, number], b: [number, number]) => {
  const p = addPoint(s, a); const q = addPoint(p.s, b);
  const l = addLine(q.s, p.id, q.id, { infer: false });
  return { s: l.s, id: l.id, p1: p.id, p2: q.id };
};
const lines = (s: SketchData) => Object.values(s.entities).filter((e) => e.type === "line");

test("reflect numa linha inclinada", () => {
  near(reflect([2, 0], [0, 0], [1, 1]), [0, 2]);
  near(reflect([3, 1], [0, 2], [5, 2]), [3, 3]);
});

test("espelhar linha no eixo V: pontos simétricos e solver ok", () => {
  const a = line(empty(), [2, 1], [5, 4]);
  const o = sketchMirror(a.s, [a.id], "V")!;
  assert.equal(lines(o).length, 2);
  const ents = allEntities(o);
  const sym = o.constraints.filter((c) => c.type === "symmetric");
  assert.equal(sym.length, 2);
  near(pt(ents, sym[0].refs[1]), [-2, 1]);
  near(pt(ents, sym[1].refs[1]), [-5, 4]);
  assert.ok(solveSketch(o).ok);
});

test("espelhar no eixo H e numa linha do esboço; ponto sobre o eixo é partilhado", () => {
  const a = line(empty(), [0, 0], [4, 3]);
  const h = sketchMirror(a.s, [a.id], "H")!;
  assert.equal(Object.values(h.entities).filter((e) => e.type === "point").length, 3, "a origem fica partilhada");
  const ax = line(a.s, [0, 5], [5, 0]);
  const g = sketchMirror(ax.s, [a.id, ax.id], ax.id)!;
  const ents = allEntities(g);
  const img = g.constraints.find((c) => c.type === "symmetric" && c.refs[0] === a.p2)!;
  near(pt(ents, img.refs[1]), reflect([4, 3], [0, 5], [5, 0]));
  assert.equal(lines(g).length, 3, "o eixo não é espelhado");
  assert.ok(solveSketch(g).ok);
});

test("espelhar círculo e arco mantém raio e orientação", () => {
  let s = empty();
  const c = addPoint(s, [3, 0]); s = c.s;
  const ci = addCircle(s, c.id, 1); s = ci.s;
  const k = addPoint(s, [3, 3]); s = k.s;
  const ar = addArc(s, k.id, [4, 3], [3, 4], true); s = ar.s;
  const o = sketchMirror(s, [ci.id, ar.id], "V")!;
  const arcs = Object.entries(o.entities).filter(([, e]) => e.type === "arc");
  assert.equal(arcs.length, 2);
  const [, m] = arcs.find(([id]) => id !== ar.id)! as [string, Extract<(typeof o.entities)[string], { type: "arc" }>];
  const ents = allEntities(o);
  near(pt(ents, m.c), [-3, 3]);
  near(pt(ents, m.s), [-3, 4]);
  near(pt(ents, m.e), [-4, 3]);
  assert.ok(o.constraints.some((x) => x.type === "equal" && x.refs.includes(ci.id)));
  assert.ok(solveSketch(o).ok);
});

test("sem manter o original fica só a cópia", () => {
  const a = line(empty(), [2, 1], [5, 4]);
  const o = sketchMirror(a.s, [a.id], "V", { keep: false })!;
  assert.equal(lines(o).length, 1);
  assert.ok(!o.entities[a.id] && !o.entities[a.p1]);
  const ents = allEntities(o);
  const l = lines(o)[0] as Extract<(typeof o.entities)[string], { type: "line" }>;
  near(pt(ents, l.p1), [-2, 1]);
  assert.ok(solveSketch(o).ok);
});

test("seleção vazia ou só o eixo devolve null", () => {
  const a = line(empty(), [0, 5], [5, 0]);
  assert.equal(sketchMirror(a.s, [a.id], a.id), null);
  assert.equal(sketchMirror(a.s, [a.id], a.p1), null);
});
