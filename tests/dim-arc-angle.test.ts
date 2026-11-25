// Cota de ângulo de arco (C2a): no SolidWorks, clicar no centro do arco e nos dois extremos (qualquer ordem).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { arcAnglePick, moveDimLabel, smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, arcSweep, measure } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const deg = (r: number) => (r * 180) / Math.PI;

/** Quarto de circunferência de raio 10 centrado na origem, de +X a +Y (CCW); `p` é um ponto solto. */
function quarter(): SketchData {
  const entities: Record<string, SketchEntity> = {
    c: { type: "point", x: 0, y: 0 }, s: { type: "point", x: 10, y: 0 }, e: { type: "point", x: 0, y: 10 },
    p: { type: "point", x: 5, y: -5 },
    k: { type: "arc", c: "c", s: "s", e: "e", r: 10, a0: 0, a1: Math.PI / 2 },
    l: { type: "line", p1: "c", p2: "s" },
  };
  return { entities, constraints: [] };
}

test("centro + os dois extremos, por qualquer ordem, dá o ângulo do arco; outro trio não", () => {
  const s = quarter();
  for (const sel of [["c", "s", "e"], ["s", "c", "e"], ["e", "s", "c"], ["s", "e", "c"]]) {
    assert.equal(arcAnglePick(s.entities, sel), "k");
    const d = smartDimension(s, sel, "auto", [8, 8])!;
    assert.equal(d.type, "angle");
    assert.deepEqual(d.refs, ["k"]);
  }
  assert.equal(arcAnglePick(s.entities, ["c", "s", "p"]), null);
  assert.equal(arcAnglePick(s.entities, ["c", "s"]), null);
  assert.equal(arcAnglePick(s.entities, ["c", "s", "s"]), null);
  assert.equal(arcAnglePick(s.entities, ["k", "s", "e"]), null);
  // o arco com os extremos continua a ser comprimento de arco; centro + extremo continua a ser distância
  assert.equal(smartDimension(s, ["k", "s", "e"], "auto", [8, 8])?.type, "arcLength");
  assert.equal(smartDimension(s, ["c", "s"], "auto", [5, 3])?.type, "distance");
});

test("mede o varrimento em graus, também acima de 180° e quando passa por ±180°", () => {
  const ents = allEntities(quarter());
  near(measure(ents, { type: "angle", refs: ["k"] }), 90);
  const big = { ...ents, k: { type: "arc" as const, c: "c", s: "s", e: "e", r: 10, a0: 0, a1: (3 * Math.PI) / 2 } };
  near(measure(big, { type: "angle", refs: ["k"] }), 270);
  const wrap = { ...ents, k: { type: "arc" as const, c: "c", s: "s", e: "e", r: 10, a0: (3 * Math.PI) / 4, a1: (-3 * Math.PI) / 4 } };
  near(measure(wrap, { type: "angle", refs: ["k"] }), 90);
});

test("o solver conduz o ângulo do arco, incluindo acima de 180° e com ângulos guardados fora de [0, 2π)", () => {
  const C = (id: string, type: SketchConstraint["type"], refs: string[], value?: number): SketchConstraint => ({ id, type, refs, value });
  const fixed = [C("k1", "coincident", ["c", "O"]), C("k2", "horizontal", ["l"]), C("k3", "radius", ["k"], 10)];
  const starts: Record<string, SketchEntity>[] = [quarter().entities, {
    ...quarter().entities,
    // a1 < a0 em bruto: o varrimento CCW é 90°, mas a1 − a0 é −270°
    e: { type: "point", x: 0, y: 10 }, k: { type: "arc", c: "c", s: "s", e: "e", r: 10, a0: 2 * Math.PI, a1: Math.PI / 2 },
  }];
  for (const start of starts) {
    const { p: _loose, ...entities } = start; // o ponto solto daria 2 graus de liberdade
    for (const target of [30, 120, 200, 300]) {
      const r = solveSketch({ entities, constraints: [...fixed, C("k4", "angle", ["k"], target)] });
      assert.ok(r.ok, r.message ?? "");
      assert.equal(r.dof, 0);
      const ents = allEntities({ entities: r.entities });
      const a = ents.k as Extract<SketchEntity, { type: "arc" }>;
      near(measure(ents, { type: "angle", refs: ["k"] }), target, 1e-5);
      near(deg(arcSweep(a.a0, a.a1)), target, 1e-5);
      for (const [p, t] of [["s", a.a0], ["e", a.a1]] as [string, number][]) {
        const q = ents[p] as { x: number; y: number };
        near(q.x, a.r * Math.cos(t), 1e-5);
        near(q.y, a.r * Math.sin(t), 1e-5);
      }
    }
  }
});

test("desenho: arco de cota concêntrico no raio do rótulo; arrastar o rótulo não mexe no setor", () => {
  const ents = allEntities(quarter());
  const c = { type: "angle" as const, refs: ["k"] };
  const g = dimGeometry(c, ents, [10, 10])!;
  assert.ok(g);
  for (const p of g.lines[0]) near(Math.hypot(...p), Math.hypot(10, 10), 1e-9);
  assert.equal(g.ext.length, 2);
  assert.equal(g.arrows.length, 2);
  assert.equal(dimGeometry(c, ents, [0, 0]), null);
  const moved = moveDimLabel({ id: "d1", ...c, value: 90 }, ents, [-8, -8]);
  assert.deepEqual(moved.refs, ["k"]);
  assert.equal(moved.flip, undefined);
  assert.deepEqual(moved.pos, [-8, -8]);
});

test("o schema aceita o ângulo de um arco", () => {
  const sk = {
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: quarter().entities,
    constraints: [{ id: "d1", type: "angle", refs: ["k"], value: 90 }],
  };
  assert.equal(featureError(sk), null);
});
