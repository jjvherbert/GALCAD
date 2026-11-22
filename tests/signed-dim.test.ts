// Distância ponto–reta e aresta–aresta com sinal: mudar o valor nunca passa a geometria para o outro lado.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(() => initSolver());
type Pt = Extract<SketchEntity, { type: "point" }>;
const side = (e: Record<string, SketchEntity>, a: string, b: string, p: string) => {
  const A = e[a] as Pt, B = e[b] as Pt, Q = e[p] as Pt;
  return Math.sign((B.x - A.x) * (Q.y - A.y) - (B.y - A.y) * (Q.x - A.x));
};
const dist = (e: Record<string, SketchEntity>, a: string, b: string, p: string) => {
  const A = e[a] as Pt, B = e[b] as Pt, Q = e[p] as Pt;
  return Math.abs((B.x - A.x) * (Q.y - A.y) - (B.y - A.y) * (Q.x - A.x)) / Math.hypot(B.x - A.x, B.y - A.y);
};
const sk = (entities: Record<string, SketchEntity>, constraints: SketchConstraint[]) => ({ entities, constraints });

test("ponto–reta: valor pequeno com a reta livre mantém o lado (antes saltava)", () => {
  for (const px of [10, 30, 60]) for (const val of [0.1, 1, 5, 20]) {
    const s = sk({
      a: { type: "point", x: 0, y: 0, fixed: true }, b: { type: "point", x: 100, y: 0 },
      L: { type: "line", p1: "a", p2: "b" }, p: { type: "point", x: px, y: 40, fixed: true },
    }, [{ id: "len", type: "distance", refs: ["L"], value: "100" }, { id: "d", type: "distance", refs: ["p", "L"], value: String(val) }]);
    const r = solveSketch(s);
    assert.ok(r.ok, `px=${px} val=${val}`);
    assert.equal(side(r.entities, "a", "b", "p"), 1, `lado px=${px} val=${val}`);
    assert.ok(Math.abs(dist(r.entities, "a", "b", "p") - val) < 1e-6, `valor px=${px} val=${val}`);
  }
});

test("ponto–reta: ponto abaixo da reta fica abaixo; refs pela ordem inversa também", () => {
  const s = sk({
    a: { type: "point", x: 0, y: 0, fixed: true }, b: { type: "point", x: 100, y: 0, fixed: true },
    L: { type: "line", p1: "a", p2: "b" }, p: { type: "point", x: 50, y: -3 },
  }, [{ id: "d", type: "distance", refs: ["L", "p"], value: "40" }]);
  const r = solveSketch(s);
  assert.ok(r.ok);
  assert.equal(side(r.entities, "a", "b", "p"), -1);
  assert.ok(Math.abs((r.entities.p as Pt).y + 40) < 1e-6);
});

test("aresta–aresta (paralelas): baixar o valor não troca as arestas de lado", () => {
  const ents: Record<string, SketchEntity> = {
    a: { type: "point", x: 0, y: 0, fixed: true }, b: { type: "point", x: 100, y: 10 },
    c: { type: "point", x: 5, y: 30 }, d: { type: "point", x: 90, y: 42 },
    L1: { type: "line", p1: "a", p2: "b" }, L2: { type: "line", p1: "c", p2: "d" },
  };
  for (const val of [50, 2, 0.1]) {
    const r = solveSketch(sk(ents, [
      { id: "len", type: "distance", refs: ["L1"], value: "100" },
      { id: "par", type: "parallel", refs: ["L1", "L2"] },
      { id: "dd", type: "distance", refs: ["c", "L1"], value: String(val) },
    ]));
    assert.ok(r.ok, `val=${val}`);
    assert.equal(side(r.entities, "a", "b", "c"), 1, `c val=${val}`);
    assert.equal(side(r.entities, "a", "b", "d"), 1, `d val=${val}`);
    assert.ok(Math.abs(dist(r.entities, "a", "b", "d") - val) < 1e-6, `d valor val=${val}`);
  }
});

test("ponto–reta: os graus de liberdade são os mesmos (o ponto auxiliar não conta)", () => {
  const base = {
    a: { type: "point", x: 0, y: 0, fixed: true }, b: { type: "point", x: 100, y: 0, fixed: true },
    L: { type: "line", p1: "a", p2: "b" }, p: { type: "point", x: 30, y: 20 },
  } as Record<string, SketchEntity>;
  assert.equal(solveSketch(sk(base, [])).dof, 2);
  const r = solveSketch(sk(base, [{ id: "d", type: "distance", refs: ["p", "L"], value: "10" }]));
  assert.ok(r.ok);
  assert.equal(r.dof, 1);
  assert.deepEqual(Object.keys(r.entities).sort(), ["L", "a", "b", "p"]);
});

test("ponto–reta: conflito aponta para a cota (sem ids auxiliares); valor 0 põe o ponto na reta", () => {
  const ents = {
    a: { type: "point", x: 0, y: 0, fixed: true }, b: { type: "point", x: 100, y: 0, fixed: true },
    L: { type: "line", p1: "a", p2: "b" }, p: { type: "point", x: 30, y: 20 },
  } as Record<string, SketchEntity>;
  const r = solveSketch(sk(ents, [
    { id: "fy", type: "distanceY", refs: ["a", "p"], value: "20" },
    { id: "d", type: "distance", refs: ["p", "L"], value: "10" },
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.conflicting.length > 0 && r.conflicting.every((id) => !id.includes("#")), String(r.conflicting));
  assert.ok(r.conflicting.includes("d"));
  const z = solveSketch(sk(ents, [{ id: "d", type: "distance", refs: ["p", "L"], value: "0" }]));
  assert.ok(z.ok);
  assert.ok(Math.abs((z.entities.p as Pt).y) < 1e-9);
});
