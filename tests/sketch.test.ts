import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch, freeEntities } from "../src/sketch/solver.ts";
import { findProfiles, isolatedPoints } from "../src/sketch/profiles.ts";
import { measure, allEntities } from "../src/sketch/geometry.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const P = (x: number, y: number): SketchEntity => ({ type: "point", x, y });
const L = (p1: string, p2: string): SketchEntity => ({ type: "line", p1, p2 });
let n = 0;
const C = (type: SketchConstraint["type"], refs: string[], value?: number | string): SketchConstraint => ({ id: `c${++n}`, type, refs, value });

/** Retângulo aproximado, com restrições e cotas que o definem totalmente. */
function rect(w: number | string, h: number | string) {
  const entities: Record<string, SketchEntity> = {
    a: P(1, 1), b: P(30, 2), c: P(28, 18), d: P(-2, 15),
    l1: L("a", "b"), l2: L("b", "c"), l3: L("c", "d"), l4: L("d", "a"),
  };
  const constraints = [
    C("horizontal", ["l1"]), C("horizontal", ["l3"]), C("vertical", ["l2"]), C("vertical", ["l4"]),
    C("coincident", ["a", "O"]), C("distance", ["l1"], w), C("distance", ["l2"], h),
  ];
  return { entities, constraints };
}

test("retângulo totalmente definido, com cotas por expressão", () => {
  const s = rect("W", "W/2");
  const r = solveSketch(s, (k) => (k === "W" ? 80 : undefined));
  assert.ok(r.ok, r.message ?? "");
  assert.equal(r.dof, 0);
  const all = allEntities({ entities: r.entities });
  assert.ok(Math.abs(measure(all, { type: "distance", refs: ["l1"] }) - 80) < 1e-6);
  assert.ok(Math.abs(measure(all, { type: "distance", refs: ["l2"] }) - 40) < 1e-6);
  assert.deepEqual([...freeEntities({ ...s, entities: r.entities }, (k) => (k === "W" ? 80 : undefined))], []);
});

test("sub-definido: graus de liberdade e entidades livres", () => {
  const s = rect(50, 20);
  s.constraints = s.constraints.filter((c) => c.type !== "coincident");
  const r = solveSketch(s);
  assert.ok(r.ok);
  assert.equal(r.dof, 2);
  const free = freeEntities({ ...s, entities: r.entities });
  assert.ok(free.has("a") && free.has("l1"));
});

test("conflito e erros de expressão são reportados", () => {
  const s = rect(50, 20);
  s.constraints.push(C("distance", ["a", "b"], 30));
  const r = solveSketch(s);
  assert.equal(r.ok, false);
  assert.ok(r.conflicting.length >= 2);
  const s2 = rect("X + 1", 20);
  const r2 = solveSketch(s2);
  assert.match(Object.values(r2.valueErrors)[0] ?? "", /desconhecida "X"/);
});

test("distância horizontal com sinal, ângulo, tangência e arrasto", () => {
  const entities: Record<string, SketchEntity> = {
    p: P(10, 3), q: P(40, 9), l: L("p", "q"),
    c: P(60, 30), s: P(70, 30), e: P(60, 40),
    arc: { type: "arc", c: "c", s: "s", e: "e", r: 10, a0: 0, a1: Math.PI / 2 },
  };
  const constraints = [
    C("coincident", ["p", "O"]), C("distanceX", ["p", "q"], 25), C("angle", ["H", "l"], 30),
    C("coincident", ["q", "s"]), C("tangent", ["l", "arc"]), C("radius", ["arc"], 8),
  ];
  const r = solveSketch({ entities, constraints });
  assert.ok(r.ok, r.message ?? "");
  const all = allEntities({ entities: r.entities });
  assert.ok(Math.abs(measure(all, { type: "distanceX", refs: ["p", "q"] }) - 25) < 1e-6);
  assert.ok(Math.abs(measure(all, { type: "angle", refs: ["H", "l"] }) - 30) < 1e-6);
  assert.ok(Math.abs((r.entities.arc as { r: number }).r - 8) < 1e-6);
  // arrastar o ponto final do arco: continua tangente e com raio 8
  const d = solveSketch({ entities: r.entities, constraints }, undefined, { kind: "point", id: "e", x: 20, y: 40 });
  assert.ok(d.ok);
  assert.ok(Math.abs((d.entities.arc as { r: number }).r - 8) < 1e-6);
});

test("perfis: região com furo, cadeia aberta, pontos isolados e erros", () => {
  const base = rect(100, 60);
  const r = solveSketch(base);
  const entities: Record<string, SketchEntity> = {
    ...r.entities,
    hc: P(50, 30), hole: { type: "circle", c: "hc", r: 10 },
    // cadeia aberta
    o1: P(200, 0), o2: P(220, 10), o3: P(240, 0), ol1: L("o1", "o2"), ol2: L("o2", "o3"),
    // ponto isolado (centro de furo)
    k: P(10, 10),
    // construção não conta
    x1: P(0, 0), x2: P(5, 5), xl: { type: "line", p1: "x1", p2: "x2", construction: true },
  };
  const pr = findProfiles(entities);
  assert.deepEqual(pr.errors, []);
  assert.equal(pr.regions.length, 1);
  assert.equal(pr.regions[0].holes.length, 1);
  assert.equal(pr.regions[0].outer.segs.length, 4);
  assert.ok(Math.abs(Math.abs(pr.regions[0].outer.area) - 6000) < 1e-6);
  assert.ok(pr.chains.some((c) => !c.closed && c.segs.length === 2));
  assert.deepEqual(isolatedPoints(entities).map((p) => p.id), ["k"]);
  // dois contornos sobrepostos
  const bad = findProfiles({ ...entities, z: P(90, 50), zc: { type: "circle", c: "z", r: 20 } });
  assert.ok(bad.errors.some((e) => /intersetam/.test(e)));
});
