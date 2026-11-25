// Cota de comprimento de arco (C2a): no SolidWorks, clicar no arco e depois nos dois extremos.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { arcLengthPick, smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, arcSweep, measure } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

/** Quarto de circunferência de raio 10 centrado na origem, de +X a +Y (CCW). */
function quarter(): SketchData {
  const entities: Record<string, SketchEntity> = {
    c: { type: "point", x: 0, y: 0 }, s: { type: "point", x: 10, y: 0 }, e: { type: "point", x: 0, y: 10 },
    k: { type: "arc", c: "c", s: "s", e: "e", r: 10, a0: 0, a1: Math.PI / 2 },
    l: { type: "line", p1: "c", p2: "s" },
  };
  return { entities, constraints: [] };
}

test("mede r·varrimento, também quando o arco passa por ±180°", () => {
  const ents = allEntities(quarter());
  near(measure(ents, { type: "arcLength", refs: ["k"] }), 5 * Math.PI);
  const wrap = { ...ents, k: { type: "arc" as const, c: "c", s: "s", e: "e", r: 10, a0: (3 * Math.PI) / 4, a1: (-3 * Math.PI) / 4 } };
  near(measure(wrap, { type: "arcLength", refs: ["k"] }), 10 * (Math.PI / 2));
  assert.throws(() => measure(ents, { type: "arcLength", refs: ["l"] }));
});

test("arco + os dois extremos, por qualquer ordem, dá comprimento de arco; outro trio não", () => {
  const s = quarter();
  for (const sel of [["k", "s", "e"], ["k", "e", "s"], ["s", "k", "e"], ["e", "s", "k"]]) {
    assert.equal(arcLengthPick(s.entities, sel), "k");
    const d = smartDimension(s, sel, "auto", [8, 8])!;
    assert.equal(d.type, "arcLength");
    assert.deepEqual(d.refs, ["k"]);
  }
  assert.equal(arcLengthPick(s.entities, ["k", "s", "c"]), null);
  assert.equal(arcLengthPick(s.entities, ["k", "s"]), null);
  assert.equal(arcLengthPick(s.entities, ["l", "s", "e"]), null);
  // arco + um extremo continua a ser a distância ao centro
  assert.notEqual(smartDimension(s, ["k", "s"], "auto", [8, 8])?.type, "arcLength");
});

test("o solver conduz o comprimento e o arco fica coerente com os extremos", () => {
  const base = quarter();
  const C = (id: string, type: SketchConstraint["type"], refs: string[], value?: number): SketchConstraint => ({ id, type, refs, value });
  const fixed = [C("k1", "coincident", ["c", "O"]), C("k2", "horizontal", ["l"]), C("k3", "radius", ["k"], 10)];
  for (const target of [10, 20, 40]) {
    const r = solveSketch({ entities: base.entities, constraints: [...fixed, C("k4", "arcLength", ["k"], target)] });
    assert.ok(r.ok, r.message ?? "");
    assert.equal(r.dof, 0);
    const ents = allEntities({ entities: r.entities });
    const a = ents.k as Extract<SketchEntity, { type: "arc" }>;
    near(measure(ents, { type: "arcLength", refs: ["k"] }), target, 1e-5);
    near(a.r * arcSweep(a.a0, a.a1), target, 1e-5);
    // os pontos s/e estão onde a0/a1 dizem
    for (const [p, t] of [["s", a.a0], ["e", a.a1]] as [string, number][]) {
      const q = ents[p] as { x: number; y: number };
      near(q.x, a.r * Math.cos(t), 1e-5);
      near(q.y, a.r * Math.sin(t), 1e-5);
    }
  }
});

test("desenho: arco de cota concêntrico no raio do rótulo, com linhas de chamada radiais", () => {
  const ents = allEntities(quarter());
  const at: [number, number] = [10, 10];
  const g = dimGeometry({ type: "arcLength", refs: ["k"] }, ents, at)!;
  assert.ok(g);
  const rd = Math.hypot(...at);
  for (const p of g.lines[0]) near(Math.hypot(...p), rd, 1e-9);
  assert.equal(g.ext.length, 2);
  assert.equal(g.arrows.length, 2);
  // rótulo dentro do arco: chamadas para dentro; rótulo no centro: sem desenho
  assert.ok(dimGeometry({ type: "arcLength", refs: ["k"] }, ents, [3, 3]));
  assert.equal(dimGeometry({ type: "arcLength", refs: ["k"] }, ents, [0, 0]), null);
});

test("o schema aceita arcLength", () => {
  const sk = (type: string) => ({
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: quarter().entities,
    constraints: [{ id: "d1", type, refs: ["k"], value: 12 }],
  });
  assert.equal(featureError(sk("arcLength")), null);
  assert.notEqual(featureError(sk("arcLen")), null);
});
