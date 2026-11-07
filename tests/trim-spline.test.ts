import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSolver, solveSketch } from "../src/sketch/solver.ts";
import { addEntity, addLine, addPoint, type SketchData } from "../src/sketch/ops.ts";
import { trim } from "../src/sketch/modify.ts";
import { allEntities, pt } from "../src/sketch/geometry.ts";

before(() => initSolver());
const empty = (): SketchData => ({ entities: {}, constraints: [] });
const splines = (s: SketchData) => Object.values(s.entities).filter((e) => e.type === "spline") as { pts: string[] }[];

/** Spline em onda de (0,0) a (100,0) e, opcionalmente, linhas verticais em x dados. */
function wave(xs: number[]): { s: SketchData; sp: string; ls: string[] } {
  let s = empty();
  const ids: string[] = [];
  for (const q of [[0, 0], [25, 20], [50, 0], [75, -20], [100, 0]] as [number, number][]) { const r = addPoint(s, q); s = r.s; ids.push(r.id); }
  const sp = addEntity(s, "s", { type: "spline", pts: ids }); s = sp.s;
  const ls: string[] = [];
  for (const x of xs) {
    const a = addPoint(s, [x, -50]); s = a.s; const b = addPoint(s, [x, 50]); s = b.s;
    const l = addLine(s, a.id, b.id); s = l.s; ls.push(l.id);
  }
  return { s, sp: sp.id, ls };
}

test("aparar spline entre duas linhas: fica partida em duas, com extremos nas linhas", () => {
  const { s, sp, ls } = wave([30, 70]);
  const t = trim(s, sp, [50, 0]);
  const S = splines(t);
  assert.equal(S.length, 2);
  const e = allEntities(t);
  const ends = S.flatMap((x) => [pt(e, x.pts[0])[0], pt(e, x.pts.at(-1)!)[0]]).sort((a, b) => a - b);
  assert.deepEqual(ends.map(Math.round), [0, 30, 70, 100]);
  assert.equal(t.constraints.filter((c) => c.type === "pointOn" && ls.includes(c.refs[1])).length, 2);
  assert.ok(solveSketch(t).ok);
});

test("aparar spline com corte só de um lado: fica o outro lado", () => {
  const { s, sp } = wave([30]);
  const t = trim(s, sp, [80, -15]);
  const S = splines(t);
  assert.equal(S.length, 1);
  const e = allEntities(t);
  assert.equal(Math.round(pt(e, S[0].pts[0])[0]), 0);
  assert.equal(Math.round(pt(e, S[0].pts.at(-1)!)[0]), 30);
  // o ponto original em x=50..100 que deixou de ser usado foi apagado
  assert.ok(!Object.values(t.entities).some((x) => x.type === "point" && x.x === 100));
});

test("aparar spline cortada por um círculo e por outra spline", () => {
  let { s, sp } = wave([]);
  const c = addPoint(s, [50, 0]); s = c.s;
  const circ = addEntity(s, "c", { type: "circle", c: c.id, r: 10 }); s = circ.s;
  const t = trim(s, sp, [50, 0]);
  assert.equal(splines(t).length, 2);
  assert.ok(t.constraints.some((k) => k.type === "pointOn" && k.refs[1] === circ.id));
  assert.ok(solveSketch(t).ok);
  // segunda spline, vertical, a cortar a primeira perto de x=75
  let u = wave([]).s, sp2 = "";
  const ids: string[] = [];
  for (const q of [[75, -60], [80, 0], [75, 60]] as [number, number][]) { const r = addPoint(u, q); u = r.s; ids.push(r.id); }
  const r = addEntity(u, "s", { type: "spline", pts: ids }); u = r.s; sp2 = r.id;
  const w = trim(u, sp, [90, -10]);
  const keep = splines(w).find((x) => x !== w.entities[sp2]) as { pts: string[] };
  const e = allEntities(w);
  assert.ok(Math.abs(pt(e, keep.pts.at(-1)!)[0] - 78) < 4);
  assert.ok(!w.constraints.some((k) => k.refs.includes(sp2)));
});

test("aparar spline sem cortes apaga-a", () => {
  const { s, sp } = wave([]);
  assert.equal(splines(trim(s, sp, [50, 0])).length, 0);
});

test("aparar uma linha cortada por uma spline: sem 'ponto em' na spline e resolve", () => {
  const { s, sp, ls } = wave([30]);
  const t = trim(s, ls[0], [30, 40]);
  assert.ok(!t.constraints.some((c) => c.refs.includes(sp)));
  assert.ok(solveSketch(t).ok);
  const l = allEntities(t)[ls[0]] as { p1: string; p2: string };
  const ys = [pt(allEntities(t), l.p1)[1], pt(allEntities(t), l.p2)[1]].sort((a, b) => a - b);
  assert.equal(ys[0], -50);
  assert.ok(ys[1] > 0 && ys[1] < 20);
});
