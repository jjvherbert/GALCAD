// Cota entre um círculo/arco e outra entidade (C2a): mede ao centro, como o SolidWorks por defeito.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { smartDimension, type SketchData } from "../src/sketch/ops.ts";
import { allEntities, measure } from "../src/sketch/geometry.ts";
import type { SketchEntity } from "../src/doc/types.ts";

before(async () => { await initSolver(); });

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

function scene(): SketchData {
  const entities: Record<string, SketchEntity> = {
    c1: { type: "point", x: 10, y: 5 }, ci: { type: "circle", c: "c1", r: 3 },
    c2: { type: "point", x: 40, y: 25 }, cj: { type: "circle", c: "c2", r: 4 },
    ci2: { type: "circle", c: "c1", r: 6 },
    p: { type: "point", x: 10, y: 30 },
    a: { type: "point", x: 0, y: -10 }, b: { type: "point", x: 50, y: -10 }, l: { type: "line", p1: "a", p2: "b" },
    ac: { type: "point", x: 60, y: 5 }, as: { type: "point", x: 65, y: 5 }, ae: { type: "point", x: 60, y: 10 },
    arc: { type: "arc", c: "ac", s: "as", e: "ae", r: 5, a0: 0, a1: Math.PI / 2 },
  };
  return { entities, constraints: [] };
}

test("círculo + ponto, reta, círculo ou arco: a cota vai ao centro", () => {
  const s = scene(), ents = allEntities(s);
  const pp = smartDimension(s, ["ci", "p"])!;
  assert.deepEqual(pp, { type: "distance", refs: ["c1", "p"] });
  near(measure(ents, pp), 25);
  // a ordem não importa
  assert.deepEqual(smartDimension(s, ["p", "ci"]), { type: "distance", refs: ["p", "c1"] });
  const pl = smartDimension(s, ["ci", "l"])!;
  assert.deepEqual(pl, { type: "distance", refs: ["c1", "l"] });
  near(measure(ents, pl), 15);
  const cc = smartDimension(s, ["ci", "cj"])!;
  near(measure(ents, cc), Math.hypot(30, 20));
  near(measure(ents, smartDimension(s, ["arc", "ci"])!), 50);
  // centro a centro segue o rato: na horizontal mede só ΔX (como entre dois pontos)
  const hx = smartDimension(s, ["ci", "cj"], "auto", [25, 40])!;
  assert.equal(hx.type, "distanceX");
  near(measure(ents, hx), 30);
  // concêntricos: não há distância a cotar
  assert.equal(smartDimension(s, ["ci", "ci2"]), null);
});

test("a cota ao centro resolve no solver e move o círculo inteiro", () => {
  const s = scene();
  const r = solveSketch({ entities: s.entities, constraints: [{ id: "k1", type: "distance", refs: ["c1", "l"], value: 20 }] });
  assert.ok(r.ok, r.message ?? "");
  near(measure(allEntities({ entities: r.entities }), { type: "distance", refs: ["c1", "l"] }), 20, 1e-5);
  const ci = r.entities.ci;
  assert.equal(ci.type === "circle" ? ci.r : NaN, 3);
});
