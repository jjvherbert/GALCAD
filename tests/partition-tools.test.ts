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
  const run = (partitions: NonNullable<FemStudy["mesh"]>["partitions"]) => {
    const st: FemStudy = { ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 1, curvature: 0, partitions }, loads };
    const c = studyCase(r.ctx, st);
    return { warnings: c.warnings, case: c.case as FemCase };
  };
  return { run, face, ids: Object.keys(doc.features ?? {}) };
}

const blocks = (c: FemCase) => Number(/dividem o sólido em (\d+) blocos/.exec(c.hypotheses.join("\n"))?.[1] ?? 1);
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

test("diagnóstico por ferramenta: 1 má + 2 boas → as 2 cortam e 1 aviso", async () => {
  const m = await model();
  for (const bad of [{ axis: "sketch" as const, at: 0, sketch: "" }, { axis: "x" as const, at: 200 }, { axis: "plane" as const, at: 0 }]) {
    const r = m.run([{ axis: "plane", at: 0, plane: { kind: "datum", feature: "f3" } }, bad, { axis: "sketch", at: 0, sketch: "f4" }]);
    assert.equal(blocks(r.case), 4, JSON.stringify(r.case.hypotheses));
    assert.equal(r.warnings.filter((w) => /ignorada/.test(w)).length, 1, JSON.stringify(r.warnings));
    assert.ok(r.warnings.some((w) => /Partição 2/.test(w)), JSON.stringify(r.warnings));
    assert.match(r.case.hypotheses.join("\n"), /2 ferramenta\(s\)/);
  }
});
