// Pré-processador FEM/CFD (etapa F1): leitor MSH, deck do CalculiX e, quando o Gmsh, o CalculiX e o
// OpenFOAM estão instalados, casos completos verificados contra soluções analíticas (consola de
// Euler–Bernoulli/Timoshenko, frequência própria, condução 1D, pressão, conduta).
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
import type { FemStudy, CfdStudy, Study } from "../src/doc/study.ts";
import { SIM_MATERIALS, newCfdStudy, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import { parseMsh, physicalBlocks } from "../src/sim/msh.ts";
import { parseDat, parseFrd } from "../src/sim/calculix.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);
const T = tools();

const MSH = `$MeshFormat
4.1 0 8
$EndMeshFormat
$PhysicalNames
2
2 1 "TOP"
3 2 "SOLID"
$EndPhysicalNames
$Entities
0 0 1 1
5 0 0 1 1 1 1 1 1 0
1 0 0 0 1 1 1 1 2 0
$EndEntities
$Nodes
1 4 1 4
3 1 0 4
1
2
3
4
0 0 0
1 0 0
0 1 0
0 0 1
$EndNodes
$Elements
2 2 1 4
2 5 2 1
1 2 3 4
3 1 4 1
2 1 2 3 4
$EndElements
`;

test("MSH 4.1: nós, elementos e grupos físicos", () => {
  const m = parseMsh(MSH);
  assert.equal(m.nodes.size, 4);
  assert.deepEqual(m.nodes.get(4), [0, 0, 1]);
  assert.equal(physicalBlocks(m, "SOLID")[0].type, 4);
  assert.deepEqual(physicalBlocks(m, "TOP")[0].conn, [2, 3, 4]);
  assert.throws(() => parseMsh("$MeshFormat\n2.2 0 8\n$EndMeshFormat\n"), /não suportado/);
});

test("FRD/DAT: blocos de resultados e valores próprios", () => {
  const frd = [
    "    2C                             2                                     1",
    " -1         1 0.00000E+00 0.00000E+00 0.00000E+00",
    " -1         2 1.00000E+02 0.00000E+00 0.00000E+00",
    " -3",
    "  100CL  101 8.35424E+02           2                     2    1           1",
    " -4  DISP        4    1",
    " -5  D1          1    2    1    0",
    " -5  D2          1    2    2    0",
    " -5  D3          1    2    3    0",
    " -5  ALL         1    2    0    0    1ALL",
    " -1         1 0.00000E+00 0.00000E+00 0.00000E+00",
    " -1         2 1.00000E-01-2.50000E-02 3.00000E+00",
    " -3",
  ].join("\n");
  const r = parseFrd(frd);
  assert.equal(r.nodes.size, 2);
  assert.equal(r.blocks[0].name, "DISP");
  assert.equal(r.blocks[0].value, 835.424);
  assert.deepEqual(r.blocks[0].data.get(2), [0.1, -0.025, 3]);
  const d = parseDat("    E I G E N V A L U E   O U T P U T\n\n MODE NO    EIGENVALUE\n\n      1   0.2755280E+08   0.5249076E+04   0.8354240E+03   0.0000000E+00\n      2   0.2755290E+08   0.5249086E+04   0.8354255E+03   0.0000000E+00\n\n");
  assert.deepEqual(d.frequencies, [835.424, 835.4255]);
});

/** Barra 100 × 10 × 10 mm ao longo de X (esboço no XY, extrusão em Z). */
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

async function solve(doc: CadDocument, study: Study) {
  const r = await new Engine().rebuild(doc);
  const sim = studyCase(r.ctx, study);
  const dir = mkdtempSync(join(tmpdir(), "cad-sim-"));
  for (const [p, data] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  return { sim, dir, run: () => runCase(dir) };
}

const fem = (patch: Partial<FemStudy>): FemStudy => ({ ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 2, curvature: 0 }, ...patch });
const hasFem = !!(T.gmsh && T.calculix);

test("caso FEM: ficheiros, grupos e hipóteses (sem solver)", async () => {
  const { doc, face } = await bar();
  const { sim } = await solve(doc, fem({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -100] }] }));
  assert.ok(String(sim.files["model.brep"]).startsWith("DBRep_DrawableShape") || String(sim.files["model.brep"]).includes("CASCADE Topology"));
  assert.match(String(sim.files["mesh.geo"]), /Physical Surface\("L1_FIXED"\) = \{\d+\};/);
  assert.match(String(sim.files["mesh.geo"]), /Mesh.ElementOrder = 2;/);
  const c = JSON.parse(String(sim.files["case.json"]));
  assert.equal(c.groups.L1_FIXED.length, 1);
  assert.deepEqual(c.loads[1], { kind: "force", group: "L2_FORCE", f: [0, 0, -100] });
  assert.ok(c.hypotheses.some((h: string) => /não é certificação/.test(h)));
  assert.match(String(sim.files["LEIA-ME.txt"]), /gmsh mesh.geo -3 -o mesh.msh/);
});

test("CalculiX: consola — flecha (Timoshenko), reações e pressão", { skip: !hasFem && "Gmsh/CalculiX não instalados" }, async () => {
  const { doc, face } = await bar();
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, F = 100, G = E / (2 * (1 + nu));
  const delta = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * A);
  const r = await (await solve(doc, fem({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }] }))).run();
  assert.ok(r.ok, JSON.stringify(r));
  const f = r.fem!;
  const tip = f.positions.reduce<number[]>((acc, _, i) => (i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6 ? [...acc, f.displacements[0].values[i + 2]] : acc), []);
  const mean = tip.reduce((a, b) => a + b, 0) / tip.length;
  near(-mean, delta, 0.03);
  const R = f.reactions[0];
  near(R[2], F, 1e-3);
  // pressão de 1 MPa na face de topo (100 × 10 mm²) → reação vertical de 1000 N; a parcela que cai
  // nos nós do próprio apoio (aresta x = 0) não entra na reação (≈ meio elemento em 100 mm)
  const p = await (await solve(doc, fem({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "pressure", faces: [face(2, 10)], p: 1 }] }))).run();
  near(p.fem!.reactions[0][2], 1000, 0.006);
  assert.deepEqual(p.warnings, []);
  assert.ok(p.summary.some(([k]) => /von Mises/.test(k)));
});

test("CalculiX: frequência própria da consola e condução térmica 1D", { skip: !hasFem && "Gmsh/CalculiX não instalados" }, async () => {
  const { doc, face } = await bar();
  const E = 210000, I = (10 * 10 ** 3) / 12, rhoA = 7.85e-9 * 100, L = 100;
  const f1 = ((1.875104 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (rhoA * L ** 4));
  const m = await (await solve(doc, fem({ analysis: "modal", modes: 4, loads: [{ kind: "fixed", faces: [face(0, 0)] }] }))).run();
  near(m.fem!.frequencies[0], f1, 0.03);
  near(m.fem!.frequencies[1], f1, 0.03); // secção quadrada: dois modos de flexão iguais
  assert.equal(m.fem!.displacements.length, 4);
  const t = await (await solve(doc, fem({ analysis: "thermal", loads: [{ kind: "temperature", faces: [face(0, 0)], t: 100 }, { kind: "temperature", faces: [face(0, 100)], t: 20 }] }))).run();
  const T = t.fem!.fields[0].values;
  const pos = t.fem!.positions;
  for (let i = 0; i < T.length; i++) near(T[i], 100 - 0.8 * pos[i * 3], 1e-3);
});

const hasFoam = !!T.openfoam;

test("caso OpenFOAM: dicionários e STL por patch (sem solver)", async () => {
  const { doc, face } = await bar();
  const s: CfdStudy = { ...newCfdStudy("c1", 1), turbulence: "laminar", inlet: { faces: [face(0, 0)], velocity: [0.01, 0, 0] }, outlet: { faces: [face(0, 100)] }, iterations: 200, mesh: { size: 1.25, surfaceLevel: [0, 0], layers: 0 } };
  const { sim } = await solve(doc, s);
  const f = sim.files;
  for (const k of ["system/blockMeshDict", "system/snappyHexMeshDict", "system/controlDict", "system/fvSchemes", "system/fvSolution", "constant/transportProperties", "constant/turbulenceProperties", "0/U", "0/p", "constant/triSurface/inlet.stl", "constant/triSurface/outlet.stl", "constant/triSurface/walls.stl", "Allrun"]) assert.ok(f[k], k);
  assert.match(String(f["constant/triSurface/inlet.stl"]), /^solid inlet\n  facet normal -1 0 0/);
  assert.match(String(f["system/snappyHexMeshDict"]), /locationInMesh \(0\.05 0\.005 0\.005\);/);
  assert.match(String(f["0/U"]), /inlet\n    \{\n        type fixedValue;\n        value uniform \(0\.01 0 0\);/);
  const c = JSON.parse(String(f["case.json"]));
  near(c.reynolds, (0.01 * 0.01) / 1.004e-6, 1e-6);
});

test("OpenFOAM: conduta quadrada laminar — balanço de massa e queda de pressão", { skip: !hasFoam && "OpenFOAM não instalado", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  // Re = 0,01 · 0,01 / 1e-6 ≈ 100 (laminar); conduta de 10 × 10 mm, 100 mm
  const U = 0.01, nu = 1.004e-6;
  const s: CfdStudy = { ...newCfdStudy("c1", 1), turbulence: "laminar", inlet: { faces: [face(0, 0)], velocity: [U, 0, 0] }, outlet: { faces: [face(0, 100)] }, iterations: 400, mesh: { size: 1, surfaceLevel: [0, 0], layers: 0 } };
  const r = await (await solve(doc, s)).run();
  const kv = Object.fromEntries(r.summary);
  near(Number(kv["Caudal de entrada"].split(" ")[0]), U * 1e-4 * 1000, 1e-3);
  assert.ok(Math.abs(Number(kv["Balanço de massa"].split(" ")[0])) < 0.5, kv["Balanço de massa"]);
  // escoamento de Poiseuille numa conduta quadrada: Δp = f·(L/Dh)·ρU²/2 com f·Re = 56,9 (desenvolvido)
  const dp = 56.9 / ((U * 0.01) / nu) * (0.1 / 0.01) * 998.2 * U ** 2 / 2;
  const got = Number(kv["Queda de pressão"].split(" ")[0]);
  assert.ok(got > 0.8 * dp && got < 1.6 * dp, `Δp ${got} vs ${dp.toFixed(4)} Pa (com o comprimento de entrada)`);
});

test("SU2: malha de fluido do Gmsh com os marcadores (interno e externo)", { skip: !T.gmsh && "Gmsh não instalado", timeout: 300000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const { doc, face } = await bar();
  const base = { ...newCfdStudy("c1", 1), solver: "su2" as const, turbulence: "kOmegaSST" as const, iterations: 100 };
  const internal = await solve(doc, { ...base, inlet: { faces: [face(0, 0)], velocity: [1, 0, 0] }, outlet: { faces: [face(0, 100)] }, mesh: { size: 4 } });
  execFileSync(T.gmsh!.path, ["mesh.geo", "-3", "-format", "su2", "-o", "mesh.su2", "-nt", "1"], { cwd: internal.dir, stdio: "ignore" });
  const m1 = readFileSync(join(internal.dir, "mesh.su2"), "utf8");
  assert.match(m1, /NDIME= 3/);
  for (const k of ["inlet", "outlet", "walls"]) assert.match(m1, new RegExp(`MARKER_TAG= ${k}`));
  const cfg = String(internal.sim.files["case.cfg"]);
  assert.match(cfg, /SOLVER= INC_RANS/);
  assert.match(cfg, /MARKER_INLET= \( inlet, 293.15, 1, 1, 0, 0 \)/);
  // coordenadas em metros (a barra tem 0,1 m)
  const xs = m1.split(/\n/).filter((l) => /^\s*-?\d+\.\d+(e[-+]\d+)?\s+-?\d/.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]));
  assert.ok(Math.max(...xs) <= 0.1 + 1e-9 && Math.max(...xs) > 0.09, String(Math.max(...xs)));
  const external = await solve(doc, { ...base, regime: "external", freestream: { velocity: [5, 0, 0], domain: [1, 2, 1] }, mesh: { size: 20 } });
  execFileSync(T.gmsh!.path, ["mesh.geo", "-3", "-format", "su2", "-o", "mesh.su2", "-nt", "1"], { cwd: external.dir, stdio: "ignore" });
  const m2 = readFileSync(join(external.dir, "mesh.su2"), "utf8");
  const markers = [...m2.matchAll(/MARKER_TAG= (\w+)\s+MARKER_ELEMS= (\d+)/g)].map((x) => [x[1], Number(x[2])]);
  assert.deepEqual(markers.map((x) => x[0]).sort(), ["body", "farfield"]);
  assert.ok(markers.every((x) => (x[1] as number) > 0));
  assert.match(String(external.sim.files["case.cfg"]), /MARKER_FAR= \( farfield \)/);
});
