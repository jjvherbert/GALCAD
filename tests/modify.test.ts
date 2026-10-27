import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { addCircle, addLine, addPoint, addRectangle, type SketchData } from "../src/sketch/ops.ts";
import { extend, offset, sketchFillet, trim } from "../src/sketch/modify.ts";
import { findProfiles } from "../src/sketch/profiles.ts";
import { allEntities, measure, pt } from "../src/sketch/geometry.ts";

before(() => initSolver());
const empty = (): SketchData => ({ entities: {}, constraints: [] });
const lines = (s: SketchData) => Object.values(s.entities).filter((e) => e.type === "line").length;


function cross(): { s: SketchData; h: string; v: string } {
  let s = empty();
  const a = addPoint(s, [0, 0]); s = a.s; const b = addPoint(s, [100, 0]); s = b.s;
  const h = addLine(s, a.id, b.id); s = h.s;
  const c = addPoint(s, [50, -40]); s = c.s; const d = addPoint(s, [50, 40]); s = d.s;
  const v = addLine(s, c.id, d.id); s = v.s;
  return { s, h: h.id, v: v.id };
}

test("aparar uma linha numa cruz: fica o lado oposto ao clique", () => {
  const { s, h, v } = cross();
  const t = trim(s, h, [80, 0]);
  const e = allEntities(t);
  const l = e[h] as { p1: string; p2: string };
  assert.ok(Math.abs(measure(e, { type: "distance", refs: [h] }) - 50) < 1e-9);
  assert.equal(pt(e, l.p2)[0], 50);
  assert.ok(t.constraints.some((c) => c.type === "pointOn" && c.refs[1] === v));
  assert.ok(solveSketch(t).ok);
  // sem interseções, apaga a entidade
  assert.equal(lines(trim(trim(s, h, [80, 0]), h, [20, 0])), 1);
});

test("aparar a meio divide a linha e aparar um círculo dá um arco", () => {
  let { s, h } = cross();
  const c = addPoint(s, [20, -30]); s = c.s; const d = addPoint(s, [20, 30]); s = d.s;
  s = addLine(s, c.id, d.id).s;
  const t = trim(s, h, [35, 0]);
  assert.equal(lines(t), 4);
  assert.ok(t.constraints.some((k) => k.type === "collinear"));
  assert.ok(solveSketch(t).ok);
  // círculo atravessado por uma linha
  let s2 = empty();
  const cc = addPoint(s2, [0, 0]); s2 = cc.s;
  const circ = addCircle(s2, cc.id, 10); s2 = circ.s;
  const a = addPoint(s2, [-20, 0]); s2 = a.s; const b = addPoint(s2, [20, 0]); s2 = b.s;
  s2 = addLine(s2, a.id, b.id).s;
  const t2 = trim(s2, circ.id, [0, 10]);
  const arc = t2.entities[circ.id];
  assert.equal(arc.type, "arc");
  const ep = allEntities(t2);
  if (arc.type === "arc") {
    assert.ok(pt(ep, arc.s)[1] < 1e-9 && pt(ep, arc.e)[1] < 1e-9);
    // o arco que fica é o de baixo (o ponto médio está em y < 0)
    const am = arc.a0 + (((arc.a1 - arc.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / 2;
    assert.ok(Math.sin(am) < 0);
  }
  assert.ok(solveSketch(t2).ok);
});

test("estender uma linha até outra", () => {
  let s = empty();
  const a = addPoint(s, [0, 0]); s = a.s; const b = addPoint(s, [30, 0]); s = b.s;
  const l = addLine(s, a.id, b.id); s = l.s;
  const c = addPoint(s, [50, -10]); s = c.s; const d = addPoint(s, [50, 10]); s = d.s;
  const v = addLine(s, c.id, d.id); s = v.s;
  const e = extend(s, l.id, [29, 0])!;
  assert.ok(Math.abs(measure(allEntities(e), { type: "distance", refs: [l.id] }) - 50) < 1e-9);
  assert.equal(extend(s, v.id, [50, 9]), null); // nada na direção
});

test("filete de canto num retângulo: perfil fechado e área correta", () => {
  const r = addRectangle(empty(), [0, 0], [40, 20]);
  const f = sketchFillet(r.s, r.points[2], 5)!;
  assert.ok(f);
  const sol = solveSketch(f);
  assert.ok(sol.ok, sol.message ?? "");
  const pr = findProfiles(sol.entities);
  assert.deepEqual(pr.errors, []);
  assert.ok(Math.abs(Math.abs(pr.regions[0].outer.area) - (800 - (25 - Math.PI * 25 / 4))) < 0.05);
  assert.equal(sketchFillet(r.s, r.points[2], 50), null); // raio demasiado grande
});

test("deslocar um retângulo para fora e um círculo", () => {
  const r = addRectangle(empty(), [0, 0], [40, 20]);
  const o = offset(r.s, r.lines, 5);
  const sol = solveSketch(o);
  assert.ok(sol.ok, sol.message ?? "");
  const pr = findProfiles(sol.entities);
  assert.equal(pr.regions.length, 1);
  assert.equal(pr.regions[0].holes.length, 1);
  assert.ok(Math.abs(Math.abs(pr.regions[0].outer.area) - 50 * 30) < 1e-6);
  const inner = offset(r.s, r.lines, -5);
  assert.ok(Math.abs(Math.abs(findProfiles(solveSketch(inner).entities).regions[0].holes[0].area) - 30 * 10) < 1e-6);
  // retângulo com canto arredondado: o arco acompanha
  const f = sketchFillet(r.s, r.points[2], 5)!;
  const ids = Object.keys(f.entities).filter((k) => f.entities[k].type !== "point");
  const fo = offset(f, ids, 3);
  const pf = findProfiles(solveSketch(fo).entities);
  assert.deepEqual(pf.errors, []);
  assert.equal(pf.regions[0].holes.length, 1);
  let s = empty();
  const c = addPoint(s, [0, 0]); s = c.s;
  s = addCircle(s, c.id, 10).s;
  const oc = offset(s, Object.keys(s.entities).filter((k) => s.entities[k].type === "circle"), 4);
  assert.ok(Object.values(oc.entities).some((e) => e.type === "circle" && Math.abs(e.r - 14) < 1e-9));

});

test("deslocar uma cadeia fixa fica totalmente definido e acompanha a original", () => {
  const r = addRectangle(empty(), [0, 0], [40, 20]);
  let s = r.s;
  for (const p of r.points) s.entities[p] = { ...(s.entities[p] as { type: "point"; x: number; y: number }), fixed: true };
  const o = offset(s, r.lines, -5);
  const sol = solveSketch(o);
  assert.ok(sol.ok);
  assert.equal(sol.dof, 0);
  // mover a original (como faria uma aresta convertida): a cópia segue
  const moved = { ...o, entities: { ...o.entities } };
  for (const p of [r.points[1], r.points[2]]) { const e = moved.entities[p] as { x: number }; moved.entities[p] = { ...(e as object), x: e.x + 20 } as typeof moved.entities[string]; }
  const sol2 = solveSketch(moved);
  assert.ok(sol2.ok);
  const inner = findProfiles(sol2.entities).regions[0].holes[0];
  assert.ok(Math.abs(Math.abs(inner.area) - 50 * 10) < 1e-6);
});
