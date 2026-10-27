// Estudos FEM de montagens: um volume por corpo, material por corpo e contacto colado (*TIE) nas
// faces planas coincidentes, verificados com o CalculiX contra soluções analíticas.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature } from "../src/doc/io.ts";
import { type CadProject, newAssembly, newPart, newProject } from "../src/doc/project.ts";
import { type FemStudy, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);
const T = tools();
const hasFem = !!(T.gmsh && T.calculix);

/** Barra w × d × h com o canto na origem (esboço no XY, extrusão em Z). */
function bar(pr: CadProject, name: string, w: number, d: number, h: number) {
  const s = new SketchBuilder();
  s.rect(0, 0, w, d, w, d);
  let p = newPart(pr, name);
  p = { ...p, ...addFeature(p, s.build()).doc };
  p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: h } }).doc };
  pr.parts.push(p);
  return p;
}

// nomes das faces de uma barra do SketchBuilder.rect: x=0 → f2:side:l8, x=w → f2:side:l6, y=0 → f2:side:l5,
// z=0 → f2:start:l5, z=h → f2:end:l5 (os mesmos do teste das montagens)
const F = { x0: "f2:side:l8", x1: "f2:side:l6", y0: "f2:side:l5", z0: "f2:start:l5", z1: "f2:end:l5" };

function project(place: [number, number, number], dims: [number, number, number][]) {
  const pr: CadProject = { ...newProject("Estudo"), parts: [] };
  const a = bar(pr, "A", ...dims[0]), b = bar(pr, "B", ...dims[1]);
  const asm = newAssembly(pr);
  asm.components = [
    { id: "c1", name: "A<1>", ref: { kind: "part", id: a.id }, placement: { t: [0, 0, 0], r: [0, 0, 0] }, fixed: true },
    { id: "c2", name: "B<1>", ref: { kind: "part", id: b.id }, placement: { t: place, r: [0, 0, 0] }, fixed: true },
  ];
  pr.assemblies.push(asm);
  return pr;
}

async function solve(pr: CadProject, study: FemStudy) {
  pr.assemblies[0].studies = [study];
  const r = await new KernelService().assemblyStudyCase(pr, pr.assemblies[0].id, study.id);
  const dir = mkdtempSync(join(tmpdir(), "cad-asm-"));
  for (const [p, data] of Object.entries(r.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  return { r, run: () => runCase(dir) };
}

const fem = (patch: Partial<FemStudy>): FemStudy => ({ ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 2, curvature: 0 }, ...patch });

test("montagem: corpos, faces com caminho, contacto detetado e deck com *TIE (sem solver)", async () => {
  // duas barras 100 × 10 × 5 empilhadas: contacto na face z = 5
  const pr = project([0, 0, 5], [[100, 10, 5], [100, 10, 5]]);
  const { r } = await solve(pr, fem({ loads: [{ kind: "fixed", faces: [{ kind: "face", name: `c1/${F.x0}` }, { kind: "face", name: `c2/${F.x0}` }] }] }));
  const c = r.case;
  assert.equal(c.physics, "fem");
  if (c.physics !== "fem") return;
  assert.deepEqual(c.bodies!.map((b) => [b.group, b.path]), [["B1", "c1"], ["B2", "c2"]]);
  assert.equal(c.ties!.length, 1);
  const s = c.faces.find((f) => f.tag === c.groups.T1_S[0])!, m = c.faces.find((f) => f.tag === c.groups.T1_M[0])!;
  assert.deepEqual([s.center[2], m.center[2]], [5, 5]);
  assert.ok([s.name, m.name].sort().join() === [`c1/${F.z1}`, `c2/${F.z0}`].sort().join(), `${s.name} ${m.name}`);
  assert.deepEqual(c.groups.L1_FIXED.length, 2);
  assert.match(r.files["mesh.geo"], /Physical Volume\("B1"\) = \{1\};\nPhysical Volume\("B2"\) = \{2\};/);
  assert.ok(c.hypotheses.some((h) => /contacto colado \(TIE\) em 1 par/.test(h)));
  // sem contacto: os corpos não se ligam
  const free = await solve(pr, fem({ contact: { mode: "none" }, loads: [{ kind: "fixed", faces: [{ kind: "face", name: `c1/${F.x0}` }] }] }));
  assert.equal((free.r.case as { ties?: unknown[] }).ties!.length, 0);
  assert.ok(free.r.warnings.some((w) => /B<1>: sem apoio nem contacto/.test(w)), free.r.warnings.join());
  await assert.rejects(solve(pr, fem({ loads: [{ kind: "fixed", faces: [{ kind: "face", name: `c9/${F.x0}` }] }] })), /não é de um corpo da montagem/);
});

test("CalculiX: duas barras coladas em altura comportam-se como uma só (consola de Timoshenko)", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 300000 }, async () => {
  const pr = project([0, 0, 5], [[100, 10, 5], [100, 10, 5]]);
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, P = 100, G = E / (2 * (1 + nu));
  const delta = (P * L ** 3) / (3 * E * I) + (P * L) / ((5 / 6) * G * A);
  const { run } = await solve(pr, fem({ loads: [
    { kind: "fixed", faces: [{ kind: "face", name: `c1/${F.x0}` }, { kind: "face", name: `c2/${F.x0}` }] },
    { kind: "force", faces: [{ kind: "face", name: `c1/${F.x1}` }, { kind: "face", name: `c2/${F.x1}` }], f: [0, 0, -P] },
  ] }));
  const res = await run();
  assert.deepEqual(res.warnings.filter((w) => !/function objects/.test(w)), []);
  const f = res.fem!;
  const tip = f.positions.reduce<number[]>((a, _, i) => (i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6 ? [...a, f.displacements[0].values[i + 2]] : a), []);
  near(-tip.reduce((a, b) => a + b, 0) / tip.length, delta, 0.03);
  near(f.reactions[0][2], P, 1e-4);
});

test("CalculiX: barras de aço e alumínio em série, coladas topo a topo (Δ = F·L₁/(E₁A) + F·L₂/(E₂A))", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 300000 }, async () => {
  const pr = project([50, 0, 0], [[50, 10, 10], [50, 10, 10]]);
  const steel = SIM_MATERIALS[0], alu = SIM_MATERIALS[2];
  const Fx = 10000, A = 100;
  const face = (c: string, n: string) => ({ kind: "face" as const, name: `${c}/${n}` });
  // simetria: x = 0 do aço, y = 0 e z = 0 das duas barras (tensão uniaxial uniforme)
  const { r, run } = await solve(pr, fem({ material: { ...steel }, bodyMaterials: { c2: { ...alu } }, loads: [
    { kind: "displacement", faces: [face("c1", F.x0)], ux: 0 },
    { kind: "displacement", faces: [face("c1", F.y0), face("c2", F.y0)], uy: 0 },
    { kind: "displacement", faces: [face("c1", F.z0), face("c2", F.z0)], uz: 0 },
    { kind: "force", faces: [face("c2", F.x1)], f: [Fx, 0, 0] },
  ] }));
  assert.equal((r.case as { ties?: unknown[] }).ties!.length, 1);
  const res = await run();
  const f = res.fem!;
  const end = f.positions.reduce<number[]>((a, _, i) => (i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6 ? [...a, f.displacements[0].values[i]] : a), []);
  const want = (Fx * 50) / (steel.E * A) + (Fx * 50) / (alu.E * A);
  near(end.reduce((a, b) => a + b, 0) / end.length, want, 0.01);
  near(-f.reactions[0][0], Fx, 1e-4);
  assert.ok(res.hypotheses.some((h) => /Alumínio/.test(h) && /Aço/.test(h)));
});
