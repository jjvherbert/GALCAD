// Cota de ângulo com setor (C2a): o setor onde o rótulo fica decide θ ou 180−θ e o solver mantém-no.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { moveDimLabel, smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, angleSector, measure } from "../src/sketch/geometry.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

/** Duas retas a 60° a partir da origem: la ao longo de +X, lb a 60°. */
function vee(): SketchData {
  const entities: Record<string, SketchEntity> = {
    o: { type: "point", x: 0, y: 0 }, a: { type: "point", x: 20, y: 0 }, b: { type: "point", x: 10, y: 10 * Math.sqrt(3) },
    la: { type: "line", p1: "o", p2: "a" }, lb: { type: "line", p1: "o", p2: "b" },
  };
  return { entities, constraints: [] };
}

test("cada um dos quatro setores mede θ ou 180−θ, sempre em [0, 180)", () => {
  const s = vee(), ents = allEntities(s);
  const cases: [[number, number], number][] = [[[10, 5], 60], [[-10, 5], 120], [[-5, -5], 60], [[5, -10], 120]];
  for (const [at, want] of cases) {
    const d = smartDimension(s, ["la", "lb"], "auto", at)!;
    assert.equal(d.type, "angle");
    near(measure(ents, d), want);
    // o arco desenhado passa pelo rótulo
    const arc = dimGeometry(d, ents, at)!.lines[0];
    assert.ok(arc.length > 2);
  }
  // setor por defeito sem flip; o oposto pelo vértice inverte as duas retas
  assert.equal(smartDimension(s, ["la", "lb"], "auto", [10, 5])!.flip, undefined);
  assert.equal(angleSector(ents, "la", "lb", [-5, -5])!.flip, 3);
  // a ordem de seleção não muda o resultado
  near(measure(ents, smartDimension(s, ["lb", "la"], "auto", [-10, 5])!), 120);
});

test("o solver mantém o setor guardado: sem saltar para o suplementar e sem mudar os graus de liberdade", () => {
  const base = vee();
  const sec = angleSector(allEntities(base), "la", "lb", [-10, 5])!;
  const C = (id: string, type: SketchConstraint["type"], refs: string[], value?: number, extra: Partial<SketchConstraint> = {}): SketchConstraint => ({ id, type, refs, value, ...extra });
  const fixed = [C("k1", "coincident", ["o", "O"]), C("k2", "horizontal", ["la"]), C("k3", "distance", ["la"], 20), C("k4", "distance", ["lb"], 20)];
  for (const target of [120, 100, 30, 170]) {
    const ang = C("k5", "angle", sec.refs, target, sec.flip ? { flip: sec.flip } : {});
    const r = solveSketch({ entities: base.entities, constraints: [...fixed, ang] });
    assert.ok(r.ok, r.message ?? "");
    assert.equal(r.dof, 0);
    const ents = allEntities({ entities: r.entities });
    near(measure(ents, ang), target, 1e-5);
    // a não marcada (la a +X) continua no mesmo sítio
    near(ents.a.type === "point" ? ents.a.x : NaN, 20, 1e-5);
  }
  // a mesma cota sem flip (documentos antigos) continua a resolver como antes
  const old = solveSketch({ entities: base.entities, constraints: [...fixed, C("k5", "angle", ["la", "lb"], 45)] });
  assert.ok(old.ok);
  assert.equal(old.dof, 0);
  near(measure(allEntities({ entities: old.entities }), { type: "angle", refs: ["la", "lb"] }), 45, 1e-5);
});

test("arrastar o rótulo para outro setor mede esse setor; uma expressão não muda de setor", () => {
  const ents = allEntities(vee());
  const c: SketchConstraint = { id: "d1", type: "angle", refs: ["la", "lb"], value: 60, pos: [10, 5] };
  const same = moveDimLabel(c, ents, [12, 4]);
  assert.deepEqual(same, { ...c, pos: [12, 4] });
  const other = moveDimLabel(c, ents, [-10, 5]);
  near(Number(other.value), 120);
  near(measure(ents, other), 120);
  assert.deepEqual(other.pos, [-10, 5]);
  // de volta ao setor inicial: sem flip
  const back = moveDimLabel(other, ents, [10, 5]);
  assert.equal(back.flip, undefined);
  near(Number(back.value), 60);
  // cota com expressão: só o rótulo
  const expr = moveDimLabel({ ...c, value: "A" }, ents, [-10, 5]);
  assert.deepEqual(expr, { ...c, value: "A", pos: [-10, 5] });
  // cota conduzida: muda de setor sem valor
  const driven = moveDimLabel({ ...c, value: undefined, driven: true }, ents, [-10, 5]);
  assert.equal(driven.value, undefined);
  near(measure(ents, driven), 120);
});

test("o schema aceita flip 0–3 e rejeita o resto", () => {
  const sk = (flip: unknown) => ({
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: vee().entities,
    constraints: [{ id: "d1", type: "angle", refs: ["la", "lb"], value: 120, flip }],
  });
  assert.equal(featureError(sk(2)), null);
  assert.notEqual(featureError(sk(4)), null);
  assert.notEqual(featureError(sk(1.5)), null);
});
