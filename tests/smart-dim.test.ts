import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver } from "../src/sketch/solver.ts";
import { addCircle, addLine, addPoint, placementMode, smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, measure } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";

before(() => initSolver());
const empty = (): SketchData => ({ entities: {}, constraints: [] });

function diag() {
  let s = empty();
  const a = addPoint(s, [0, 0]); s = a.s;
  const b = addPoint(s, [40, 30]); s = b.s;
  const l = addLine(s, a.id, b.id); s = l.s;
  return { s, a: a.id, b: b.id, l: l.id };
}

test("placementMode: acima do vão → horizontal, ao lado → vertical, fora → alinhada", () => {
  assert.equal(placementMode([0, 0], [40, 30], [20, 50]), "horizontal");
  assert.equal(placementMode([0, 0], [40, 30], [60, 15]), "vertical");
  assert.equal(placementMode([0, 0], [40, 30], [20, 15]), "auto");
  assert.equal(placementMode([0, 0], [40, 30], [-10, -10]), "auto");
  // segmento já horizontal: sempre alinhada
  assert.equal(placementMode([0, 0], [40, 0], [20, 10]), "auto");
});

test("cota numa linha em dois cliques: a posição decide X, Y ou alinhada", () => {
  const { s, l } = diag();
  const ents = allEntities(s);
  const h = smartDimension(s, [l], "auto", [20, 50])!;
  assert.equal(h.type, "distanceX");
  assert.equal(Math.abs(measure(ents, h)), 40);
  const v = smartDimension(s, [l], "auto", [60, 15])!;
  assert.equal(v.type, "distanceY");
  assert.equal(Math.abs(measure(ents, v)), 30);
  const al = smartDimension(s, [l], "auto", [10, 25])!;
  assert.equal(al.type, "distance");
  assert.equal(measure(ents, al), 50);
  // modo forçado ganha à posição
  assert.equal(smartDimension(s, [l], "vertical", [20, 50])!.type, "distanceY");
});

test("dimGeometry linear: linhas de chamada até à linha de cota, que passa no rótulo", () => {
  const { s, a, b } = diag();
  const ents = allEntities(s);
  const g = dimGeometry({ type: "distanceX", refs: [a, b] }, ents, [20, 50])!;
  assert.equal(g.ext.length, 2);
  assert.deepEqual(g.lines[0], [[0, 50], [40, 50]]);
  assert.equal(g.arrows.length, 2);
  assert.equal(g.arrows[0][1][0], -1);
  // rótulo fora do vão: a linha prolonga-se até ele
  const out = dimGeometry({ type: "distanceX", refs: [a, b] }, ents, [70, 50])!;
  assert.equal(out.lines.length, 2);
  assert.deepEqual(out.lines[1].at(-1), [70, 50]);
});

test("dimGeometry raio/diâmetro e ângulo", () => {
  let s = empty();
  const c = addPoint(s, [0, 0]); s = c.s;
  const circ = addCircle(s, c.id, 10); s = circ.s;
  const p1 = addPoint(s, [20, 0]); s = p1.s;
  const p2 = addPoint(s, [0, 20]); s = p2.s;
  const la = addLine(s, c.id, p1.id); s = la.s;
  const lb = addLine(s, c.id, p2.id); s = lb.s;
  const ents = allEntities(s);
  const d = dimGeometry({ type: "diameter", refs: [circ.id] }, ents, [30, 0])!;
  assert.deepEqual(d.lines[0], [[-10, 0], [10, 0]]);
  assert.deepEqual(d.lines[1], [[10, 0], [30, 0]]);
  assert.equal(d.arrows.length, 2);
  const g = dimGeometry({ type: "angle", refs: [la.id, lb.id] }, ents, [10, 10])!;
  const r = Math.hypot(10, 10), arc = g.lines[0];
  for (const q of arc) assert.ok(Math.abs(Math.hypot(q[0], q[1]) - r) < 1e-9);
  assert.ok(Math.abs(arc[0][1]) < 1e-9 && Math.abs(arc.at(-1)![0]) < 1e-9);
  // o arco (r≈14) passa para lá do fim das linhas? não (20): sem linhas de chamada
  assert.equal(g.ext.length, 0);
  assert.equal(dimGeometry({ type: "angle", refs: [la.id, lb.id] }, ents, [20, 20])!.ext.length, 2);
});
