// Ferramentas de partição da malha (C8): plano de referência e esboço extrudido (Abaqus: Partition Cell
// › Define Cutting Plane / Extrude-Sweep Edges), com diagnóstico por ferramenta — a que falha é ignorada
// com um aviso e as outras aplicam-se.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import type { CadDocument, TopoRef } from "../src/doc/types.ts";
import { type FemStudy, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import { seedPreview } from "../src/kernel/sim-fem.ts";
import type { FemCase } from "../src/sim/case.ts";

before(initKernel);

/** Barra 100 × 10 × 10 ao longo de X (f1 esboço, f2 extrusão), plano de referência X = 30 (f3) e um
 * esboço em XY com um retângulo 40 ≤ x ≤ 60 que atravessa a barra (f4). */
async function model() {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 10, 100, 10);
  const k = new SketchBuilder();
  k.rect(40, -5, 20, 20, 20, 20);
  let doc: CadDocument = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  doc = addFeature(doc, { type: "plane", base: { kind: "std", name: "YZ" }, offset: 30 }).doc;
  doc = addFeature(doc, k.build()).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[axis]) - 1) < 1e-9 && Math.abs(p.center[axis] - v) < 1e-6; })!;
    return { kind: "face", name: f.name };
  };
  const loads: FemStudy["loads"] = [
    { kind: "fixed", faces: [face(0, 0)] },
    { kind: "pressure", faces: [face(2, 10)], p: 1 },
  ];
  const study = (partitions: NonNullable<FemStudy["mesh"]>["partitions"]): FemStudy =>
    ({ ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 1, curvature: 0, partitions }, loads });
  const preview = (partitions: NonNullable<FemStudy["mesh"]>["partitions"]) => seedPreview(r.ctx, study(partitions));
  const run = (partitions: NonNullable<FemStudy["mesh"]>["partitions"]) => {
    const c = studyCase(r.ctx, study(partitions));
    return { warnings: c.warnings, case: c.case as FemCase };
  };
  return { run, preview, face, ids: Object.keys(doc.features ?? {}) };
}

const blocks = (c: FemCase) => Number(/dividem? o sólido em (\d+) blocos?/.exec(c.hypotheses.join("\n"))?.[1] ?? 1);
const top = (c: FemCase) => Object.values(c.groups).find((g) => g.length > 1) ?? [];

test("plano de referência: um plano de referência e uma face plana cortam a barra", async () => {
  const m = await model();
  const datum = m.run([{ axis: "plane", at: 0, plane: { kind: "datum", feature: "f3" } }]);
  assert.equal(blocks(datum.case), 2, JSON.stringify(datum.case.hypotheses));
  assert.deepEqual(datum.warnings, []);
  const std = m.run([{ axis: "plane", at: 0, plane: { kind: "std", name: "XZ" } }]); // y = 0 é a face da barra
  assert.equal(blocks(std.case), 1);
  assert.ok(std.warnings.some((w) => /Partição 1.*ignorada/.test(w)), JSON.stringify(std.warnings));
});

test("esboço extrudido: o retângulo corta a barra em 3 e a carga no topo fica nas 3 sub-faces", async () => {
  const m = await model();
  const r = m.run([{ axis: "sketch", at: 0, sketch: "f4" }]);
  assert.equal(blocks(r.case), 3, JSON.stringify(r.case.hypotheses));
  assert.deepEqual(r.warnings, []);
  assert.equal(top(r.case).length, 3, JSON.stringify(r.case.groups));
});

test("curva projetada: o esboço projetado no topo corta a barra em 3 pela espessura", async () => {
  const m = await model();
  const r = m.run([{ axis: "sketch", at: 0, sketch: "f4", onFace: m.face(2, 10) }]);
  assert.equal(blocks(r.case), 3, JSON.stringify(r.case.hypotheses));
  assert.deepEqual(r.warnings, []);
  assert.equal(top(r.case).length, 3, JSON.stringify(r.case.groups));
  const miss = m.run([{ axis: "sketch", at: 0, sketch: "f4", onFace: m.face(0, 0) }]);
  assert.equal(blocks(miss.case), 1);
  assert.ok(miss.warnings.some((w) => /Partição 1.*não se projeta.*ignorada/.test(w)), JSON.stringify(miss.warnings));
});

test("diagnóstico por ferramenta: 1 má + 2 boas → as 2 cortam e 1 aviso", async () => {
  const m = await model();
  for (const bad of [{ axis: "sketch" as const, at: 0, sketch: "" }, { axis: "x" as const, at: 200 }, { axis: "plane" as const, at: 0 }]) {
    const r = m.run([{ axis: "plane", at: 0, plane: { kind: "datum", feature: "f3" } }, bad, { axis: "sketch", at: 0, sketch: "f4" }]);
    assert.equal(blocks(r.case), 4, JSON.stringify(r.case.hypotheses));
    assert.equal(r.warnings.filter((w) => /ignorada/.test(w)).length, 1, JSON.stringify(r.warnings));
    assert.ok(r.warnings.some((w) => /Partição 2/.test(w)), JSON.stringify(r.warnings));
    assert.match(r.case.hypotheses.join("\n"), /2 ferramentas dividem/);
  }
});

test("cilindro: um cilindro em Y por (50; 0; 5) de raio 3 separa um núcleo da barra", async () => {
  const m = await model();
  const cyl = m.run([{ axis: "cyl", at: 3, origin: [50, 0, 5], normal: [0, 1, 0] }]);
  assert.equal(blocks(cyl.case), 2, JSON.stringify(cyl.case.hypotheses));
  assert.deepEqual(cyl.warnings, []);
  const zero = m.run([{ axis: "cyl", at: 0 }]);
  assert.ok(zero.warnings.some((w) => /Partição 1.*raio.*ignorada/.test(w)), JSON.stringify(zero.warnings));
  const flat = m.run([{ axis: "cyl", at: 3, face: m.face(2, 10) }]);
  assert.ok(flat.warnings.some((w) => /Partição 1.*não é cilíndrica.*ignorada/.test(w)), JSON.stringify(flat.warnings));
  assert.equal(blocks(flat.case), 1);
});

test("cilindro coaxial com um furo: R = 10 à volta de um furo de raio 5 separa o anel da chapa", async () => {
  const s = new SketchBuilder();
  s.rect(0, 0, 40, 40, 40, 40);
  let doc: CadDocument = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 5 } }).doc;
  const plate = await new Engine().rebuild(doc);
  const lid = plate.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(p.normal[2] - 1) < 1e-9; })!;
  const h = new SketchBuilder({ kind: "face", ref: { kind: "face", name: lid.name } });
  h.circle(20, 20, 5);
  doc = addFeature(doc, h.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" } }).doc;
  const r = await new Engine().rebuild(doc);
  const hole = r.ctx.body!.faces.find((x) => faceProps(x.face).axis)!;
  const side = r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(p.normal[0] + 1) < 1e-9; })!;
  const st: FemStudy = {
    ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] },
    mesh: { size: 2.5, order: 1, curvature: 0, partitions: [{ axis: "cyl", at: 10, face: { kind: "face", name: hole.name } }] },
    loads: [{ kind: "fixed", faces: [{ kind: "face", name: side.name }] }, { kind: "pressure", faces: [{ kind: "face", name: hole.name }], p: 1 }],
  };
  const c = studyCase(r.ctx, st);
  assert.ok(hole, "o corte devia ter aberto um furo cilíndrico");
  assert.deepEqual(c.warnings, []);
  assert.equal(blocks(c.case as FemCase), 2, JSON.stringify((c.case as FemCase).hypotheses));
});

/** Coordenadas x de todos os pontos das linhas de corte. */
const xs = (cuts: number[][]) => cuts.flatMap((l) => l.filter((_, i) => i % 3 === 0));

test("pré-visualização dos cortes: as linhas de corte ficam nos planos das partições e os avisos chegam", async () => {
  const m = await model();
  assert.deepEqual(m.preview(undefined).cuts, []);
  const datum = m.preview([{ axis: "plane", at: 0, plane: { kind: "datum", feature: "f3" } }]);
  assert.equal(datum.cuts.length, 4, "o quadrado 10 × 10 em X = 30");
  assert.ok(xs(datum.cuts).every((x) => Math.abs(x - 30) < 1e-6), JSON.stringify(xs(datum.cuts)));
  const sk = m.preview([{ axis: "sketch", at: 0, sketch: "f4" }]);
  assert.equal(sk.cuts.length, 8, "dois quadrados, em X = 40 e X = 60");
  assert.ok(xs(sk.cuts).every((x) => Math.abs(x - 40) < 1e-6 || Math.abs(x - 60) < 1e-6), JSON.stringify(xs(sk.cuts)));
  const bad = m.preview([{ axis: "x", at: 200 }]);
  assert.deepEqual(bad.cuts, []);
  assert.ok(bad.warnings.some((w) => /^Partição 1.*ignorada/.test(w)), JSON.stringify(bad.warnings));
});

test("suprimir: a partição suprimida não corta, não avisa e as outras mantêm o número", async () => {
  const m = await model();
  const r = m.run([{ axis: "x", at: 200, suppressed: true }, { axis: "x", at: 300 }, { axis: "sketch", at: 0, sketch: "f4" }]);
  assert.equal(blocks(r.case), 3, JSON.stringify(r.case.hypotheses));
  assert.equal(r.warnings.filter((w) => /ignorada/.test(w)).length, 1, JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /Partição 2/.test(w)), "a 2.ª continua a ser a «Partição 2»");
  const all = m.run([{ axis: "sketch", at: 0, sketch: "f4", suppressed: true }]);
  assert.equal(blocks(all.case), 1);
  assert.deepEqual(all.warnings, []);
  assert.deepEqual(m.preview([{ axis: "plane", at: 0, plane: { kind: "datum", feature: "f3" }, suppressed: true }]).cuts, []);
});
