// Raio ↔ diâmetro (C2a): no SolidWorks, a cota de um arco ou círculo pode mostrar raio ou diâmetro;
// alternar mantém o tamanho físico (o valor é convertido) e o solver conduz os dois tipos.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { convertRadiusValue, smartDimension, toggleRadiusDiameter, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, measure } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

function sk(): SketchData {
  const entities: Record<string, SketchEntity> = {
    k: { type: "point", x: 0, y: 0 }, s: { type: "point", x: 3, y: 0 }, e: { type: "point", x: 0, y: 3 },
    a: { type: "arc", c: "k", s: "s", e: "e", r: 3, a0: 0, a1: Math.PI / 2 },
    o: { type: "point", x: 10, y: 0 }, c: { type: "circle", c: "o", r: 2 },
  };
  return { entities, constraints: [] };
}

test("por defeito: arco → raio, círculo → diâmetro", () => {
  const s = sk();
  assert.equal(smartDimension(s, ["a"], "auto", [4, 4])?.type, "radius");
  assert.equal(smartDimension(s, ["c"], "auto", [13, 0])?.type, "diameter");
});

test("alternar converte o valor e mantém o tamanho físico", () => {
  const ents = allEntities(sk());
  const r: SketchConstraint = { id: "d1", type: "radius", refs: ["a"], value: 3 };
  const d = toggleRadiusDiameter(r);
  assert.equal(d.type, "diameter");
  assert.equal(d.value, 6);
  near(measure(ents, d), 6);
  const back = toggleRadiusDiameter(d);
  assert.deepEqual(back, r);
  // círculo com diâmetro em texto numérico
  const c = toggleRadiusDiameter({ id: "d2", type: "diameter", refs: ["c"], value: "4" });
  assert.equal(c.type, "radius");
  assert.equal(c.value, "2");
  // cota de referência: só muda o tipo
  const ref = toggleRadiusDiameter({ id: "d3", type: "radius", refs: ["a"], value: 3, driven: true });
  assert.equal(ref.type, "diameter");
  assert.equal(ref.value, 3);
  // outro tipo: intacto
  const dist: SketchConstraint = { id: "d4", type: "distance", refs: ["s", "e"], value: 1 };
  assert.equal(toggleRadiusDiameter(dist), dist);
});

test("conversão do texto: números (com vírgula), expressões e vazio", () => {
  assert.equal(convertRadiusValue(2.5, true), 5);
  assert.equal(convertRadiusValue("12,5", true), "25");
  assert.equal(convertRadiusValue(" 7 ", false), "3.5");
  assert.equal(convertRadiusValue(1 / 3, true), 0.667);
  assert.equal(convertRadiusValue("L/4", true), "2*(L/4)");
  assert.equal(convertRadiusValue("10 mm", false), "(10 mm)/2");
  assert.equal(convertRadiusValue("", true), "");
});

test("o solver conduz o diâmetro de um arco e de um círculo", () => {
  const s = sk();
  for (const [ref, type, v, r] of [["a", "diameter", 10, 5], ["a", "radius", 4, 4], ["c", "diameter", 7, 3.5], ["c", "radius", 1, 1]] as const) {
    const res = solveSketch({ entities: s.entities, constraints: [{ id: "d", type, refs: [ref], value: v }] });
    assert.ok(res.ok, res.message ?? "");
    const ents = allEntities({ entities: res.entities });
    near((ents[ref] as { r: number }).r, r, 1e-5);
    near(measure(ents, { type, refs: [ref] }), v, 1e-5);
  }
});

test("desenho do diâmetro num arco: linha de lado a lado com duas setas", () => {
  const ents = allEntities(sk());
  const g = dimGeometry({ type: "diameter", refs: ["a"] }, ents, [4, 4])!;
  assert.equal(g.arrows.length, 2);
  const [p, q] = g.lines[0];
  near(Math.hypot(q[0] - p[0], q[1] - p[1]), 6);
});

test("o schema aceita diâmetro num arco", () => {
  const f = {
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: sk().entities,
    constraints: [{ id: "d1", type: "diameter", refs: ["a"], value: 6 }],
  };
  assert.equal(featureError(f), null);
});
