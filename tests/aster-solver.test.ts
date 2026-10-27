// code_aster real (se instalado: run_aster no PATH ou CAD_ASTER): os mesmos casos analíticos do
// CalculiX — consola (Timoshenko), reações, frequência própria, plasticidade uniaxial e elástica.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import type { CadDocument, TopoRef } from "../src/doc/types.ts";
import { type FemStudy, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);
const T = tools();
const has = !!(T.gmsh && T.code_aster);
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);

async function bar(): Promise<{ doc: CadDocument; face: (axis: 0 | 1 | 2, v: number) => TopoRef }> {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 10, 100, 10);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[axis]) - 1) < 1e-9 && Math.abs(p.center[axis] - v) < 1e-6; })!;
    return { kind: "face", name: f.name };
  };
  return { doc, face };
}

async function run(doc: CadDocument, s: FemStudy) {
  const r = await new Engine().rebuild(doc);
  const sim = studyCase(r.ctx, s);
  const dir = mkdtempSync(join(tmpdir(), "cad-aster-"));
  for (const [p, d] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }
  return runCase(dir);
}
const fem = (patch: Partial<FemStudy>): FemStudy => ({ ...newFemStudy("s1", 1), solver: "code_aster", material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 2, curvature: 0 }, ...patch });
const tipMean = (f: NonNullable<Awaited<ReturnType<typeof runCase>>["fem"]>, comp: number) => {
  const idx = f.positions.map((_, i) => i).filter((i) => i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6);
  return idx.reduce((a, i) => a + f.displacements[0].values[i + comp], 0) / idx.length;
};

test("code_aster: consola — flecha de Timoshenko, von Mises e reação", { skip: !has && "code_aster não instalado", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, F = 100, G = E / (2 * (1 + nu));
  const delta = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * A);
  const r = await run(doc, fem({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }] }));
  assert.equal(r.solver, "code_aster");
  near(-tipMean(r.fem!, 2), delta, 0.03);
  near(r.fem!.reactions[0][2], F, 1e-3);
});

test("code_aster: pressão (reação = p·A) e frequências próprias da consola", { skip: !has && "code_aster não instalado", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const p = await run(doc, fem({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "pressure", faces: [face(2, 10)], p: 1 }] }));
  near(p.fem!.reactions[0][2], 1000, 1e-3);
  const E = 210000, I = (10 * 10 ** 3) / 12, rhoA = 7.85e-9 * 100, L = 100;
  const f1 = ((1.875104 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (rhoA * L ** 4));
  const m = await run(doc, fem({ analysis: "modal", modes: 4, loads: [{ kind: "fixed", faces: [face(0, 0)] }] }));
  near(m.fem!.frequencies[0], f1, 0.03);
  near(m.fem!.frequencies[1], f1, 0.03);
  assert.equal(m.fem!.displacements.length, 4);
});

test("code_aster: plasticidade bilinear em tração uniaxial (VMIS_ISOT_LINE)", { skip: !has && "code_aster não instalado", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const sym: FemStudy["loads"] = [{ kind: "displacement", faces: [face(0, 0)], ux: 0 }, { kind: "displacement", faces: [face(1, 0)], uy: 0 }, { kind: "displacement", faces: [face(2, 0)], uz: 0 }];
  const E = 210000, sy = 235, Et = 2100, Hp = (E * Et) / (E - Et), sigma = 300;
  const r = await run(doc, fem({ mesh: { size: 5, order: 2, curvature: 0 }, nonlinear: { plasticity: true, increments: 6 }, loads: [...sym, { kind: "force", faces: [face(0, 100)], f: [sigma * 100, 0, 0] }] }));
  near(tipMean(r.fem!, 0), (sigma / E + (sigma - sy) / Hp) * 100, 0.005);
  const peeq = r.fem!.fields.find((x) => /plástica/.test(x.name))!.values;
  near(peeq.reduce((a, b) => a + b, 0) / peeq.length, (sigma - sy) / Hp, 0.01);
  assert.equal(r.fem!.history.length, 6);
  near(-r.fem!.history.at(-1)!.reaction![0], sigma * 100, 1e-3);
});

test("code_aster: grandes deslocamentos (GREEN_LAGRANGE) — elástica de Bisshopp–Drucker, PL²/EI = 1", { skip: !has && "code_aster não instalado", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const E = 210000, I = (10 * 10 ** 3) / 12, L = 100, P = (E * I) / L ** 2;
  const r = await run(doc, fem({ nonlinear: { geometry: true, increments: 10 }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -P] }] }));
  near(-tipMean(r.fem!, 2), 0.3017 * L, 0.03);
  near(-tipMean(r.fem!, 0), 0.0566 * L, 0.08);
});

test("code_aster: montagem — lâminas coladas (LIAISON_MAIL) e barras aço + alumínio em série", { skip: !has && "code_aster não instalado", timeout: 900000 }, async () => {
  const { KernelService } = await import("../src/kernel/service.ts");
  const { newAssembly, newPart, newProject } = await import("../src/doc/project.ts");
  const build = (place: [number, number, number], dims: [number, number, number]) => {
    const pr = { ...newProject("A"), parts: [] as ReturnType<typeof newPart>[] };
    for (const name of ["A", "B"]) {
      const s = new SketchBuilder();
      s.rect(0, 0, dims[0], dims[1], dims[0], dims[1]);
      let p = newPart(pr, name);
      p = { ...p, ...addFeature(p, s.build()).doc };
      p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: dims[2] } }).doc };
      pr.parts.push(p);
    }
    const asm = newAssembly(pr);
    asm.components = [
      { id: "c1", name: "A<1>", ref: { kind: "part", id: pr.parts[0].id }, placement: { t: [0, 0, 0], r: [0, 0, 0] }, fixed: true },
      { id: "c2", name: "B<1>", ref: { kind: "part", id: pr.parts[1].id }, placement: { t: place, r: [0, 0, 0] }, fixed: true },
    ];
    pr.assemblies.push(asm);
    return pr;
  };
  const F = { x0: "f2:side:l8", x1: "f2:side:l6", y0: "f2:side:l5", z0: "f2:start:l5" };
  const face = (c: string, n: string) => ({ kind: "face" as const, name: `${c}/${n}` });
  const solveAsm = async (pr: ReturnType<typeof build>, s: FemStudy) => {
    pr.assemblies[0].studies = [s];
    const r = await new KernelService().assemblyStudyCase(pr as never, pr.assemblies[0].id, s.id);
    const dir = mkdtempSync(join(tmpdir(), "cad-aster-asm-"));
    for (const [p, d] of Object.entries(r.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }
    return runCase(dir);
  };
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, P = 100, G = E / (2 * (1 + nu));
  const delta = (P * L ** 3) / (3 * E * I) + (P * L) / ((5 / 6) * G * A);
  const st = await solveAsm(build([0, 0, 5], [100, 10, 5]), fem({ loads: [
    { kind: "fixed", faces: [face("c1", F.x0), face("c2", F.x0)] },
    { kind: "force", faces: [face("c1", F.x1), face("c2", F.x1)], f: [0, 0, -P] },
  ] }));
  near(-tipMean(st.fem!, 2), delta, 0.03);
  const steel = SIM_MATERIALS[0], alu = SIM_MATERIALS[2];
  const se = await solveAsm(build([50, 0, 0], [50, 10, 10]), fem({ material: { ...steel }, bodyMaterials: { c2: { ...alu } }, loads: [
    { kind: "displacement", faces: [face("c1", F.x0)], ux: 0 },
    { kind: "displacement", faces: [face("c1", F.y0), face("c2", F.y0)], uy: 0 },
    { kind: "displacement", faces: [face("c1", F.z0), face("c2", F.z0)], uz: 0 },
    { kind: "force", faces: [face("c2", F.x1)], f: [10000, 0, 0] },
  ] }));
  near(tipMean(se.fem!, 0), (10000 * 50) / (steel.E * A) + (10000 * 50) / (alu.E * A), 0.01);
});
