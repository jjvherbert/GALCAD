// Cota de ângulo de uma linha com a horizontal/vertical imaginária (C2a): no SolidWorks, selecionar a linha,
// clicar num dos seus extremos e colocar a cota; aqui, o quadrante onde se larga o rótulo escolhe o braço da cruz.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { lineEndPick, moveDimLabel, smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, axisArm, measure } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const R = Math.PI / 180;
/** ponto a distância r de (2, 1) com o ângulo t (graus) */
const at = (t: number, r = 5): [number, number] => [2 + r * Math.cos(t * R), 1 + r * Math.sin(t * R)];

/** Linha de comprimento 10 a 30° a partir de a = (2, 1); `p` é um ponto solto. */
function sk(): SketchData {
  const b = at(30, 10);
  const entities: Record<string, SketchEntity> = {
    a: { type: "point", x: 2, y: 1 }, b: { type: "point", x: b[0], y: b[1] }, p: { type: "point", x: 9, y: -4 },
    l: { type: "line", p1: "a", p2: "b" },
  };
  return { entities, constraints: [] };
}

test("linha + um extremo, por qualquer ordem, dá o ângulo com a horizontal; outro ponto continua distância", () => {
  const s = sk();
  for (const sel of [["l", "a"], ["a", "l"]]) {
    assert.deepEqual(lineEndPick(s.entities, sel), { line: "l", vertex: "a" });
    const d = smartDimension(s, sel, "auto", at(15))!;
    assert.equal(d.type, "angle");
    assert.deepEqual(d.refs, ["l", "a"]);
    assert.equal(d.flip, undefined);
    near(measure(allEntities(s), d), 30);
  }
  assert.deepEqual(lineEndPick(s.entities, ["b", "l"]), { line: "l", vertex: "b" });
  assert.equal(lineEndPick(s.entities, ["l", "p"]), null);
  assert.equal(lineEndPick(s.entities, ["a", "b"]), null);
  assert.equal(smartDimension(s, ["l", "p"], "auto", [0, 0])?.type, "distance");
});

test("o quadrante do rótulo escolhe o braço da cruz e a medida", () => {
  const s = sk(), ents = allEntities(s);
  // [ângulo do rótulo, braço esperado, medida]
  for (const [t, arm, v] of [[15, 0, 30], [60, 1, 60], [120, 2, 150], [-45, 3, 120]] as const) {
    assert.equal(axisArm(ents, "l", "a", at(t)), arm, `rótulo a ${t}°`);
    const d = smartDimension(s, ["l", "a"], "auto", at(t))!;
    assert.equal(d.flip ?? 0, arm);
    near(measure(ents, d), v);
  }
  // no outro extremo a linha aponta a 210°: com o braço −X mede 30°
  const b = at(30, 10), lb: [number, number] = [b[0] + 4 * Math.cos(195 * R), b[1] + 4 * Math.sin(195 * R)];
  const d = smartDimension(s, ["l", "b"], "auto", lb)!;
  assert.equal(d.flip, 2);
  near(measure(ents, d), 30);
  // sem rato, o braço mais próximo da linha
  assert.equal(axisArm(ents, "l", "a"), 0);
});

test("o solver conduz o ângulo com 0 graus de liberdade, também perto de 180° e ao passar por ±180°", () => {
  const C = (id: string, type: SketchConstraint["type"], refs: string[], value?: number, flip?: number): SketchConstraint =>
    ({ id, type, refs, value, ...(flip ? { flip } : {}) });
  const { p: _loose, ...entities } = sk().entities; // o ponto solto daria 2 graus de liberdade
  const fixed = [C("k1", "coincident", ["a", "O"]), C("k2", "distance", ["l"], 10)];
  for (const [flip, target] of [[0, 30], [0, 75], [0, 179], [1, 45], [2, 10], [2, 150], [3, 30], [3, 179]] as const) {
    const r = solveSketch({ entities, constraints: [...fixed, C("k3", "angle", ["l", "a"], target, flip)] });
    assert.ok(r.ok, r.message ?? "");
    assert.equal(r.dof, 0);
    const ents = allEntities({ entities: r.entities });
    near(measure(ents, { type: "angle", refs: ["l", "a"], ...(flip ? { flip } : {}) }), target, 1e-5);
    const a = ents.a as { x: number; y: number }, b = ents.b as { x: number; y: number };
    near(Math.hypot(b.x - a.x, b.y - a.y), 10, 1e-5);
  }
});

test("desenho: arco no raio do rótulo entre o braço e a linha, com chamada ao longo do braço", () => {
  const ents = allEntities(sk());
  const c = { type: "angle" as const, refs: ["l", "a"] };
  const g = dimGeometry(c, ents, at(15))!;
  for (const p of g.lines[0]) near(Math.hypot(p[0] - 2, p[1] - 1), 5, 1e-9);
  const ang = (p: [number, number]) => Math.atan2(p[1] - 1, p[0] - 2) / R;
  near(ang(g.lines[0][0]), 0, 1e-9);
  near(ang(g.lines[0][g.lines[0].length - 1]), 30, 1e-9);
  assert.equal(g.ext.length, 1); // a linha (10) chega ao arco (5)
  near(g.ext[0][1][0], 7, 1e-9);
  assert.equal(g.arrows.length, 2);
  // rótulo para lá do fim da linha: chamada também ao longo da linha
  assert.equal(dimGeometry(c, ents, at(15, 15))!.ext.length, 2);
  // braço −Y: o arco vai de −90° a 30°
  const g3 = dimGeometry({ ...c, flip: 3 }, ents, at(-45))!;
  near(ang(g3.lines[0][0]), -90, 1e-9);
  near(ang(g3.lines[0][g3.lines[0].length - 1]), 30, 1e-9);
  assert.equal(dimGeometry(c, ents, [2, 1]), null);
});

test("arrastar o rótulo para outro quadrante muda o braço e volta a medir; a de referência (conduzida) mantém o valor", () => {
  const ents = allEntities(sk());
  const c: SketchConstraint = { id: "d1", type: "angle", refs: ["l", "a"], value: 30 };
  const m = moveDimLabel(c, ents, at(120));
  assert.equal(m.flip, 2);
  near(m.value as number, 150);
  assert.deepEqual(m.pos, at(120));
  const back = moveDimLabel(m, ents, at(10));
  assert.equal(back.flip, undefined);
  near(back.value as number, 30);
  const same = moveDimLabel(c, ents, at(20, 8));
  assert.equal(same.flip, undefined);
  assert.equal(same.value, 30);
  const ref = moveDimLabel({ ...c, driven: true }, ents, at(60));
  assert.equal(ref.flip, 1);
  assert.equal(ref.value, 30);
});

test("o schema aceita o ângulo linha–extremo com braço", () => {
  const f = {
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: sk().entities,
    constraints: [{ id: "d1", type: "angle", refs: ["l", "a"], value: 150, flip: 2 }],
  };
  assert.equal(featureError(f), null);
});
