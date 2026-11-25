// Cota de ângulo por três pontos (C2a): no SolidWorks, com a Smart Dimension, clicar no vértice e depois
// em dois pontos e colocar a cota; aqui, o setor onde se larga o rótulo escolhe qual dos quatro ângulos se mede.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { moveDimLabel, smartDimension, threePointAnglePick, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, measure, pointAngleSector } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const R = Math.PI / 180;
/** ponto a distância r de (2, 1) com o ângulo t (graus) */
const at = (t: number, r = 5): [number, number] => [2 + r * Math.cos(t * R), 1 + r * Math.sin(t * R)];

/** Vértice v = (2, 1), a a 0° (6), b a 60° (8), c alinhado com v e a, e um arco (centro k, extremos s, e). */
function sk(): SketchData {
  const a = at(0, 6), b = at(60, 8), c = at(180, 3);
  const entities: Record<string, SketchEntity> = {
    v: { type: "point", x: 2, y: 1 }, a: { type: "point", x: a[0], y: a[1] }, b: { type: "point", x: b[0], y: b[1] },
    c: { type: "point", x: c[0], y: c[1] }, w: { type: "point", x: 2, y: 1 },
    k: { type: "point", x: 20, y: 0 }, s: { type: "point", x: 23, y: 0 }, e: { type: "point", x: 20, y: 3 },
    r: { type: "arc", c: "k", s: "s", e: "e", r: 3, a0: 0, a1: Math.PI / 2 },
  };
  return { entities, constraints: [] };
}

test("vértice + dois pontos dá o ângulo interior, com as referências por ordem anti-horária", () => {
  const s = sk(), ents = allEntities(s);
  for (const sel of [["v", "a", "b"], ["v", "b", "a"]]) {
    assert.ok(threePointAnglePick(ents, sel));
    const d = smartDimension(s, sel, "auto", at(30))!;
    assert.equal(d.type, "angle");
    assert.deepEqual(d.refs, ["v", "a", "b"]);
    assert.equal(d.flip, undefined);
    near(measure(ents, d), 60);
  }
  // sem rato: o interior
  assert.deepEqual(pointAngleSector(ents, "v", "b", "a"), { refs: ["v", "a", "b"], flip: 0 });
});

test("o setor do rótulo escolhe qual dos quatro ângulos se mede", () => {
  const s = sk(), ents = allEntities(s);
  for (const [t, v] of [[30, 60], [120, 120], [210, 60], [-60, 120]] as const) {
    const d = smartDimension(s, ["v", "a", "b"], "auto", at(t))!;
    near(measure(ents, d), v);
    assert.ok(measure(ents, d) > 0);
    // o arco da cota passa pelo rótulo
    const g = dimGeometry(d, ents, at(t))!;
    const ang = (p: [number, number]) => ((Math.atan2(p[1] - 1, p[0] - 2) / R) % 360 + 360) % 360;
    const a0 = ang(g.lines[0][0]), sweep = ((ang(g.lines[0][g.lines[0].length - 1]) - a0) % 360 + 360) % 360;
    near(sweep, v, 1e-6);
    assert.ok((((t - a0) % 360) + 360) % 360 <= sweep + 1e-9, `rótulo a ${t}° fora do arco`);
  }
});

test("alinhados, coincidentes, o trio de um arco ou só eixos não são ângulo por três pontos", () => {
  const s = sk(), ents = allEntities(s);
  assert.equal(threePointAnglePick(ents, ["v", "a", "c"]), false); // alinhados
  assert.equal(pointAngleSector(ents, "v", "a", "c"), null);
  assert.equal(threePointAnglePick(ents, ["v", "w", "b"]), false); // w coincide com o vértice
  assert.equal(pointAngleSector(ents, "v", "w", "b"), null);
  assert.equal(threePointAnglePick(ents, ["k", "s", "e"]), false); // é o ângulo do arco
  assert.deepEqual(smartDimension(s, ["k", "s", "e"], "auto", [21, 1])?.refs, ["r"]);
  assert.equal(threePointAnglePick(ents, ["v", "a"]), false);
  assert.equal(threePointAnglePick(ents, ["v", "v", "a"]), false);
});

test("o solver conduz o ângulo com 0 graus de liberdade, em qualquer setor, também acima de 90°", () => {
  const C = (id: string, type: SketchConstraint["type"], refs: string[], value?: number, flip?: number): SketchConstraint =>
    ({ id, type, refs, value, ...(flip ? { flip } : {}) });
  const { v, a, b } = sk().entities;
  const entities: Record<string, SketchEntity> = { v, a, b, l: { type: "line", p1: "v", p2: "a" } };
  const fixed = [C("k1", "coincident", ["v", "O"]), C("k2", "horizontal", ["l"]), C("k3", "distance", ["l"], 6), C("k4", "distance", ["v", "b"], 8)];
  for (const [flip, target] of [[0, 45], [0, 100], [0, 170], [1, 30], [2, 120], [3, 60]] as const) {
    const r = solveSketch({ entities, constraints: [...fixed, C("k5", "angle", ["v", "a", "b"], target, flip)] });
    assert.ok(r.ok, r.message ?? "");
    assert.equal(r.dof, 0);
    const ents = allEntities({ entities: r.entities });
    near(measure(ents, { type: "angle", refs: ["v", "a", "b"], ...(flip ? { flip } : {}) }), target, 1e-5);
    const P = ents.v as { x: number; y: number }, B = ents.b as { x: number; y: number };
    near(Math.hypot(B.x - P.x, B.y - P.y), 8, 1e-5);
  }
});

test("desenho: arco centrado no vértice, no raio do rótulo, com chamadas quando o arco passa os pontos", () => {
  const ents = allEntities(sk());
  const c = { type: "angle" as const, refs: ["v", "a", "b"] };
  const g = dimGeometry(c, ents, at(30))!;
  for (const p of g.lines[0]) near(Math.hypot(p[0] - 2, p[1] - 1), 5, 1e-9);
  assert.equal(g.ext.length, 0); // os dois pontos (6 e 8) estão para lá do arco (5)
  assert.equal(g.arrows.length, 2);
  assert.equal(dimGeometry(c, ents, at(30, 10))!.ext.length, 2);
  assert.equal(dimGeometry(c, ents, [2, 1]), null);
});

test("arrastar o rótulo para outro setor muda o setor e volta a medir; a de referência mantém o valor", () => {
  const ents = allEntities(sk());
  const c: SketchConstraint = { id: "d1", type: "angle", refs: ["v", "a", "b"], value: 60 };
  const m = moveDimLabel(c, ents, at(120));
  assert.equal(m.refs[0], "v");
  near(m.value as number, 120);
  near(measure(ents, m), 120);
  assert.deepEqual(m.pos, at(120));
  const back = moveDimLabel(m, ents, at(20));
  assert.deepEqual(back.refs, ["v", "a", "b"]);
  assert.equal(back.flip, undefined);
  near(back.value as number, 60);
  const same = moveDimLabel(c, ents, at(40, 8));
  assert.equal(same.value, 60);
  assert.deepEqual(same.refs, c.refs);
  const ref = moveDimLabel({ ...c, driven: true }, ents, at(210));
  assert.equal(ref.value, 60);
  near(measure(ents, ref), 60);
  assert.equal(ref.flip, 3);
});

test("o schema aceita o ângulo por três pontos com flip", () => {
  const f = {
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: sk().entities,
    constraints: [{ id: "d1", type: "angle", refs: ["v", "a", "b"], value: 120, flip: 1 }],
  };
  assert.equal(featureError(f), null);
});
