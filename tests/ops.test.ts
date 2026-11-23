import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { addArc, addCircle, addConstraint, addLine, addPoint, addRectangle, applicableConstraints, applyConstraint, deleteItems, mergePoints, smartDimension, toggleConstruction, type SketchData } from "../src/sketch/ops.ts";
import { findProfiles } from "../src/sketch/profiles.ts";
import { measure, allEntities } from "../src/sketch/geometry.ts";

before(() => initSolver());
const empty = (): SketchData => ({ entities: {}, constraints: [] });

test("retângulo pela UI: perfil fechado, cotas e totalmente definido", () => {
  let { s, lines, points } = addRectangle(empty(), [0, 0], [40, 25]);
  s = applyConstraint(s, "coincident", [points[0], "O"]);
  for (const l of [lines[0], lines[1]]) {
    const d = smartDimension(s, [l])!;
    s = addConstraint(s, d.type, d.refs, l === lines[0] ? 50 : 30).s;
  }
  const r = solveSketch(s);
  assert.ok(r.ok);
  assert.equal(r.dof, 0);
  const pr = findProfiles(r.entities);
  assert.equal(pr.regions.length, 1);
  assert.ok(Math.abs(Math.abs(pr.regions[0].outer.area) - 1500) < 1e-6);
  // o canto ligado à origem foi fundido com ela
  assert.ok(Object.values(r.entities).some((e) => e.type === "line" && (e.p1 === "O" || e.p2 === "O")));
});

test("relações automáticas e restrições aplicáveis", () => {
  let s = empty();
  let a = addPoint(s, [0, 0]); s = a.s;
  let b = addPoint(s, [30, 0.5]); s = b.s;
  const l = addLine(s, a.id, b.id); s = l.s;
  assert.ok(s.constraints.some((c) => c.type === "horizontal"));
  const c = addPoint(s, [30, 20]); s = c.s;
  const l2 = addLine(s, b.id, c.id); s = l2.s;
  assert.ok(s.constraints.some((k) => k.type === "vertical" && k.refs[0] === l2.id));
  assert.deepEqual(applicableConstraints(s, [l.id, l2.id]).sort(), ["collinear", "equal", "horizontal", "parallel", "perpendicular", "vertical"].sort());
  const cc = addPoint(s, [60, 60]); s = cc.s;
  const circ = addCircle(s, cc.id, 10); s = circ.s;
  assert.ok(applicableConstraints(s, [l.id, circ.id]).includes("tangent"));
  s = applyConstraint(s, "tangent", [l2.id, circ.id]);
  const r = solveSketch(s);
  assert.ok(r.ok);
});

test("cota inteligente: diâmetro, raio, ângulo positivo e X/Y com sinal", () => {
  let s = empty();
  const c = addPoint(s, [0, 0]); s = c.s;
  const circ = addCircle(s, c.id, 5); s = circ.s;
  assert.deepEqual(smartDimension(s, [circ.id])!.type, "diameter");
  const arc = addArc(s, c.id, [10, 0], [0, 10]); s = arc.s;
  assert.deepEqual(smartDimension(s, [arc.id])!.type, "radius");
  const p1 = addPoint(s, [50, 0]); s = p1.s;
  const p2 = addPoint(s, [20, 30]); s = p2.s;
  const dx = smartDimension(s, [p1.id, p2.id], "horizontal")!;
  assert.ok(measure(allEntities(s), dx) > 0);
  const la = addLine(s, c.id, p1.id); s = la.s;
  const lb = addLine(s, c.id, p2.id); s = lb.s;
  const ang = smartDimension(s, [lb.id, la.id])!;
  assert.equal(ang.type, "angle");
  assert.ok(measure(allEntities(s), ang) > 0);
});

test("apagar, construção e fusão de pontos", () => {
  let { s, lines, points } = addRectangle(empty(), [0, 0], [10, 10]);
  s = addConstraint(s, "distance", [lines[0]], 10).s;
  const d = deleteItems(s, [lines[0]]);
  assert.equal(Object.values(d.entities).filter((e) => e.type === "line").length, 3);
  assert.ok(!d.constraints.some((c) => c.refs.includes(lines[0])));
  assert.equal(Object.values(d.entities).filter((e) => e.type === "point").length, 4); // os cantos continuam usados
  const dp = deleteItems(s, [points[0]]);
  assert.equal(Object.values(dp.entities).filter((e) => e.type === "line").length, 2);
  const tc = toggleConstruction(s, [lines[1]]);
  assert.equal(tc.entities[lines[1]].construction, true);
  assert.equal(findProfiles(tc.entities).regions.length, 0);
  const m = mergePoints(s, points[0], points[2]);
  assert.ok(!m.entities[points[2]]);
});

test("cota inteligente recusa eixos implícitos", () => {
  assert.equal(smartDimension({ entities: {}, constraints: [] }, ["H"]), null);
  assert.equal(smartDimension({ entities: {}, constraints: [] }, ["O", "H"]), null);
});

test("linha da origem ao longo de um eixo: só Horizontal/Vertical, sem 'ponto em' redundante", () => {
  // como o clique o faz: ponto final com "ponto em" no eixo, depois a linha infere H/V
  for (const [axis, end, dir] of [["H", [50, 0], "horizontal"], ["V", [0, -40], "vertical"]] as const) {
    let s = empty();
    const b = addPoint(s, [...end]); s = addConstraint(b.s, "pointOn", [b.id, axis]).s;
    const l = addLine(s, "O", b.id); s = l.s;
    assert.ok(s.constraints.some((c) => c.type === dir && c.refs[0] === l.id));
    assert.ok(!s.constraints.some((c) => c.type === "pointOn"), "o 'ponto em' devia ter caído");
    const r = solveSketch(s);
    assert.ok(r.ok, "não pode ficar sobredefinido");
    assert.equal(r.dof, 1);
  }
  // ao contrário: começa no eixo e acaba na origem
  let s = empty();
  const a = addPoint(s, [30, 0]); s = addConstraint(a.s, "pointOn", [a.id, "H"]).s;
  s = addLine(s, a.id, "O").s;
  assert.ok(!s.constraints.some((c) => c.type === "pointOn"));
  assert.ok(solveSketch(s).ok);
  // linha horizontal que acaba no eixo vertical: esse "ponto em" não é redundante e fica
  s = empty();
  const p = addPoint(s, [10, 5]); s = p.s;
  const q = addPoint(s, [0, 5]); s = addConstraint(q.s, "pointOn", [q.id, "V"]).s;
  s = addLine(s, p.id, q.id).s;
  assert.ok(s.constraints.some((c) => c.type === "pointOn"), "ponto em V numa linha horizontal não é redundante");
});
