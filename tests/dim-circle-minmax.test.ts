// Cota mín./máx. a círculos e arcos (C2a, condição de arco do SolidWorks): centro ∓/± raio.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { dimGeometry } from "../src/sketch/dimgeom.ts";
import { allEntities, measure } from "../src/sketch/geometry.ts";
import { featureError } from "../src/doc/schema.ts";
import type { SketchConstraint, SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

function scene(): SketchData {
  const entities: Record<string, SketchEntity> = {
    c1: { type: "point", x: 10, y: 5 }, ci: { type: "circle", c: "c1", r: 3 },
    c2: { type: "point", x: 40, y: 25 }, cj: { type: "circle", c: "c2", r: 4 },
    p: { type: "point", x: 10, y: 30 },
    a: { type: "point", x: 0, y: -10 }, b: { type: "point", x: 50, y: -10 }, l: { type: "line", p1: "a", p2: "b" },
    ac: { type: "point", x: 60, y: 5 }, as: { type: "point", x: 65, y: 5 }, ae: { type: "point", x: 60, y: 10 },
    arc: { type: "arc", c: "ac", s: "as", e: "ae", r: 5, a0: 0, a1: Math.PI / 2 },
  };
  return { entities, constraints: [] };
}

const D = (refs: string[], arc: SketchConstraint["arc"], value?: number): SketchConstraint => ({ id: "k1", type: "distance", refs, arc, value });

test("measure: centro ∓ raio em cada lado", () => {
  const ents = allEntities(scene());
  near(measure(ents, D(["ci", "p"], ["min", "center"])), 22);
  near(measure(ents, D(["ci", "p"], ["max", "center"])), 28);
  near(measure(ents, D(["p", "ci"], ["center", "min"])), 22);
  near(measure(ents, D(["ci", "l"], ["min", "center"])), 12);
  near(measure(ents, D(["ci", "l"], ["max", "center"])), 18);
  const cc = Math.hypot(30, 20);
  near(measure(ents, D(["ci", "cj"], ["min", "min"])), cc - 7);
  near(measure(ents, D(["ci", "cj"], ["max", "min"])), cc - 1);
  near(measure(ents, D(["ci", "cj"], ["max", "max"])), cc + 7);
  near(measure(ents, D(["arc", "ci"], ["min", "min"])), 42);
});

test("o solver atinge o valor mín./máx. com os mesmos graus de liberdade de uma cota normal", () => {
  const s = scene();
  const cases: [string[], SketchConstraint["arc"], number][] = [
    [["ci", "p"], ["min", "center"], 15], [["ci", "p"], ["max", "center"], 30],
    [["ci", "l"], ["min", "center"], 8], [["l", "ci"], ["center", "max"], 25],
    [["ci", "cj"], ["min", "min"], 20], [["ci", "cj"], ["max", "min"], 40], [["arc", "ci"], ["max", "max"], 60],
  ];
  const plain = solveSketch({ entities: s.entities, constraints: [{ id: "k1", type: "distance", refs: ["c1", "p"], value: 20 }] });
  for (const [refs, arc, val] of cases) {
    const r = solveSketch({ entities: s.entities, constraints: [D(refs, arc, val)] });
    assert.ok(r.ok, `${refs} ${arc}: ${r.message ?? ""}`);
    assert.equal(r.dof, plain.dof, `${refs} ${arc}`);
    near(measure(allEntities({ entities: r.entities }), D(refs, arc)), val, 1e-5);
  }
  // os raios não mudam
  const r = solveSketch({ entities: s.entities, constraints: [D(["ci", "cj"], ["min", "min"], 20)] });
  const ci = r.entities.ci, cj = r.entities.cj;
  near(ci.type === "circle" ? ci.r : NaN, 3, 1e-6);
  near(cj.type === "circle" ? cj.r : NaN, 4, 1e-6);
});

test("com o raio cotado, a cota mín. move o centro quando o raio muda", () => {
  const s = scene();
  const r = solveSketch({ entities: s.entities, constraints: [
    D(["ci", "l"], ["min", "center"], 10),
    { id: "k2", type: "radius", refs: ["ci"], value: 5 },
  ] });
  assert.ok(r.ok, r.message ?? "");
  const ents = allEntities({ entities: r.entities });
  near(measure(ents, { type: "distance", refs: ["c1", "l"] }), 15, 1e-5);
});

test("o schema aceita arc com duas condições e rejeita o resto", () => {
  const sk = (arc: unknown) => ({
    id: "f1", name: "Esboço1", type: "sketch" as const, plane: { kind: "std", name: "XY" }, entities: scene().entities,
    constraints: [{ id: "d1", type: "distance", refs: ["ci", "p"], value: 20, arc }],
  });
  assert.equal(featureError(sk(["min", "center"])), null);
  assert.notEqual(featureError(sk(["min"])), null);
  assert.notEqual(featureError(sk(["near", "center"])), null);
});

test("Shift no círculo: min do lado da outra entidade, max do lado oposto; sem Shift, ao centro", () => {
  const s = scene(), ents = allEntities(s);
  // ci (centro 10,5 r3) e p (10,30): clicar no topo do círculo → min, em baixo → max
  const top = smartDimension(s, ["ci", "p"], "auto", [20, 20], [[10, 8], null])!;
  assert.deepEqual(top, { type: "distance", refs: ["ci", "p"], arc: ["min", "center"] });
  near(measure(ents, top), 22);
  const bot = smartDimension(s, ["ci", "p"], "auto", [20, 20], [[10, 2], null])!;
  assert.deepEqual(bot.arc, ["max", "center"]);
  near(measure(ents, bot), 28);
  // reta primeiro: fica em segundo, com as condições trocadas
  const lc = smartDimension(s, ["l", "ci"], "auto", undefined, [null, [10, 2]])!;
  assert.deepEqual(lc, { type: "distance", refs: ["ci", "l"], arc: ["min", "center"] });
  near(measure(ents, lc), 12);
  // dois círculos com Shift só num: o outro mede ao centro
  const cc = smartDimension(s, ["ci", "cj"], "auto", undefined, [null, [37, 22]])!;
  assert.deepEqual(cc.arc, ["center", "min"]);
  near(measure(ents, cc), Math.hypot(30, 20) - 4);
  // Shift num ponto não faz nada: continua ao centro (e pode ser ΔX)
  assert.deepEqual(smartDimension(s, ["ci", "p"], "auto", undefined, [null, [10, 30]]), { type: "distance", refs: ["c1", "p"] });
  assert.equal(smartDimension(s, ["ci", "cj"], "auto", [25, 40])!.type, "distanceX");
});

test("o desenho da cota mín./máx. toca a curva", () => {
  const s = scene(), ents = allEntities(s);
  const end = (c: Pick<SketchConstraint, "type" | "refs" | "arc">) => {
    const g = dimGeometry(c, ents, [30, 20])!;
    return g.ext.map(([from]) => from);
  };
  const tipsMin = end({ type: "distance", refs: ["ci", "p"], arc: ["min", "center"] });
  assert.ok(tipsMin.some((t) => Math.abs(Math.hypot(t[0] - 10, t[1] - 5) - 3) < 1e-6 && t[1] > 5), JSON.stringify(tipsMin));
  const tipsMax = end({ type: "distance", refs: ["ci", "l"], arc: ["max", "center"] });
  assert.ok(tipsMax.some((t) => Math.abs(Math.hypot(t[0] - 10, t[1] - 5) - 3) < 1e-6 && t[1] > 5), JSON.stringify(tipsMax));
  assert.ok(tipsMax.some((t) => Math.abs(t[1] + 10) < 1e-6));
});
