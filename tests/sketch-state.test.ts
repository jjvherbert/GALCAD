import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch, sketchState, problemConstraints, solveWithDrivenFallback } from "../src/sketch/solver.ts";
import { addRectangle, addConstraint, deleteItems, type SketchData } from "../src/sketch/ops.ts";

before(() => initSolver());

/** Retângulo 40×20 com o canto na origem: 2 relações (H/V do retângulo) + coincidente + 2 cotas. */
function rect() {
  const r = addRectangle({ entities: {}, constraints: [] }, [0, 0], [40, 20]);
  let s: SketchData = addConstraint(r.s, "coincident", [r.points[0], "O"]).s;
  s = addConstraint(s, "distance", [r.lines[0]], 40).s;
  s = addConstraint(s, "distance", [r.lines[1]], 20).s;
  return { s, lines: r.lines };
}

test("esboço vazio de cotas é sub-definido (azul)", () => {
  const r = addRectangle({ entities: {}, constraints: [] }, [0, 0], [40, 20]);
  assert.equal(sketchState(solveSketch(r.s)), "under");
});

test("retângulo com 2 cotas fica totalmente definido (preto)", () => {
  const r = solveSketch(rect().s);
  assert.equal(sketchState(r), "defined");
  assert.deepEqual(problemConstraints(r), []);
});

test("relação redundante deixa o esboço sobredefinido (vermelho) e aparece no painel", () => {
  const { s, lines } = rect();
  const a = addConstraint(s, "parallel", [lines[0], lines[2]]);
  const r = solveSketch(a.s);
  assert.equal(r.ok, true);
  assert.equal(sketchState(r), "over");
  assert.deepEqual(problemConstraints(r), [a.id]);
  // apagar a relação a mais devolve o preto
  assert.equal(sketchState(solveSketch(deleteItems(a.s, [a.id]))), "defined");
});

test("cota a mais coerente passa a cota de referência (conduzida)", () => {
  const { s, lines } = rect();
  const a = addConstraint(s, "distance", [lines[2]], 40);
  assert.equal(sketchState(solveSketch(a.s)), "over"); // sem a regra, comandaria em silêncio
  const f = solveWithDrivenFallback(a.s, a.id);
  assert.equal(f.driven, true);
  assert.equal(f.next.constraints.find((c) => c.id === a.id)?.driven, true);
  assert.equal(sketchState(f.r), "defined");
});

test("cota a mais contraditória também passa a referência", () => {
  const { s, lines } = rect();
  const a = addConstraint(s, "distance", [lines[2]], 50);
  assert.equal(sketchState(solveSketch(a.s)), "unsolved");
  const f = solveWithDrivenFallback(a.s, a.id);
  assert.equal(f.driven, true);
  assert.equal(sketchState(f.r), "defined");
});

test("cota que não sobredefine continua a comandar", () => {
  const r = addRectangle({ entities: {}, constraints: [] }, [0, 0], [40, 20]);
  const a = addConstraint(r.s, "distance", [r.lines[0]], 30);
  const f = solveWithDrivenFallback(a.s, a.id);
  assert.equal(f.driven, false);
  assert.equal(sketchState(f.r), "under");
});

test("redundância antiga não converte a cota nova", () => {
  const { s, lines } = rect();
  const p = addConstraint(s, "parallel", [lines[0], lines[2]]);
  const prev = solveSketch(p.s).redundant;
  // desfaz a cota de 20 e volta a criá-la: não é ela a culpada da redundância existente
  const without = { ...p.s, constraints: p.s.constraints.filter((c) => !(c.type === "distance" && c.refs[0] === lines[1])) };
  const a = addConstraint(without, "distance", [lines[1]], 20);
  const f = solveWithDrivenFallback(a.s, a.id, undefined, prev);
  assert.equal(f.driven, false);
  assert.equal(sketchState(f.r), "over");
});
