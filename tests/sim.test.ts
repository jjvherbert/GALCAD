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
  // pressão de 1 MPa na face de topo (100 × 10 mm²) → reação vertical de 1000 N (a parcela que cai
  // nos nós do apoio também é reação: só se somam os graus de liberdade restringidos)
  const p = await (await solve(doc, fem({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "pressure", faces: [face(2, 10)], p: 1 }] }))).run();
  near(p.fem!.reactions[0][2], 1000, 1e-4);
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

test("CalculiX: convergência da malha da consola (GCI) com tetraedros lineares", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, F = 100, G = E / (2 * (1 + nu));
  const delta = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * A);
  const { dir } = await solve(doc, fem({ mesh: { size: 2, order: 1, curvature: 0 }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }] }));
  const r = await runCase(dir, () => {}, false, { convergence: { ratio: 1.5 } });
  const c = r.convergence!;
  assert.equal(c.meshes.length, 3);
  assert.ok(c.meshes[0].cells > c.meshes[1].cells && c.meshes[1].cells > c.meshes[2].cells);
  const u = c.rows.find((x) => x.key === "umax")!;
  // os tetraedros lineares são rígidos em flexão: convergem por baixo, e a extrapolação aproxima-se
  // da solução analítica mais do que a malha fina
  assert.equal(u.gci.behaviour, "monotonic");
  assert.ok(u.values[0] > u.values[1] && u.values[1] > u.values[2], u.values.join(" "));
  assert.ok(Math.abs(u.gci.extrapolated - delta) < Math.abs(u.values[0] - delta), `${u.gci.extrapolated} vs ${delta} (fina ${u.values[0]})`);
  assert.ok(u.gci.gciFine > 0 && u.gci.gciFine < 0.5);
  assert.equal(r.cells, c.meshes[0].cells);
});

test("CalculiX: plasticidade bilinear em tração uniaxial (ε = σ/E + (σ − σy)/Hp)", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 300000 }, async () => {
  const { doc, face } = await bar();
  // apoios de simetria (sem restrição lateral): estado de tensão uniforme σ = F/A
  const sym: FemStudy["loads"] = [{ kind: "displacement", faces: [face(0, 0)], ux: 0 }, { kind: "displacement", faces: [face(1, 0)], uy: 0 }, { kind: "displacement", faces: [face(2, 0)], uz: 0 }];
  const E = 210000, sy = 235, Et = 2100, Hp = (E * Et) / (E - Et), sigma = 300;
  const r = await (await solve(doc, fem({ mesh: { size: 5, order: 2, curvature: 0 }, nonlinear: { plasticity: true, increments: 6 }, loads: [...sym, { kind: "force", faces: [face(0, 100)], f: [sigma * 100, 0, 0] }] }))).run();
  const f = r.fem!;
  const eps = sigma / E + (sigma - sy) / Hp;
  const tip = f.positions.reduce<number[]>((a, _, i) => (i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6 ? [...a, f.displacements[0].values[i]] : a), []);
  near(tip.reduce((a, b) => a + b, 0) / tip.length, eps * 100, 0.005);
  const peeq = f.fields.find((x) => /plástica/.test(x.name))!.values;
  near(peeq.reduce((a, b) => a + b, 0) / peeq.length, (sigma - sy) / Hp, 0.01);
  near(Math.max(...f.fields.find((x) => /von Mises/.test(x.name))!.values), sigma, 0.005);
  // curva carga–deslocamento: elástica até σy (u = σ·L/E), depois com a inclinação de Et
  assert.equal(f.history.length, 6);
  assert.ok(Math.abs(f.history.at(-1)!.time - 1) < 1e-9);
  const h1 = f.history[0]; // 50 MPa: ainda elástico
  near(h1.umax, (sigma / 6) * 100 / E, 0.02);
  near(-h1.reaction![0], sigma * 100 / 6, 1e-5);
  assert.ok(r.metrics.some((m) => m.key === "peeq"));
});

test("CalculiX: grandes deslocamentos (NLGEOM) — consola elástica de Bisshopp–Drucker, PL²/EI = 1", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 300000 }, async () => {
  const { doc, face } = await bar();
  const E = 210000, I = (10 * 10 ** 3) / 12, L = 100, P = (E * I) / L ** 2;
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -P] }];
  const tipOf = (f: NonNullable<Awaited<ReturnType<typeof runCase>>["fem"]>) => {
    const idx = f.positions.map((_, i) => i).filter((i) => i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6);
    const avg = (k: number) => idx.reduce((a, i) => a + f.displacements[0].values[i + k], 0) / idx.length;
    return { u: avg(0), w: avg(2) };
  };
  const nl = await (await solve(doc, fem({ nonlinear: { geometry: true, increments: 10 }, loads }))).run();
  const lin = await (await solve(doc, fem({ loads }))).run();
  const a = tipOf(nl.fem!), b = tipOf(lin.fem!);
  // elástica (carga de direção fixa): v/L = 0,3017, u/L = 0,0566; linear: L/3 (+ corte)
  near(-a.w, 0.3017 * L, 0.03);
  near(-a.u, 0.0566 * L, 0.08);
  assert.ok(-b.w > 33.3 && Math.abs(b.u) < 1, `linear ${b.w}`);
  assert.equal(nl.fem!.history.length >= 10, true);
});

test("CalculiX: sondas (média na face, ponto) e refinamento automático até ao GCI alvo", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, F = 100, G = E / (2 * (1 + nu));
  const delta = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * A);
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }];
  const probes: FemStudy["probes"] = [
    { name: "Flecha na ponta", quantity: "uz", at: { kind: "faces", faces: [face(0, 100)] } },
    { name: "Tensão a meio vão (fibra superior)", quantity: "vm", at: { kind: "point", point: [50, 5, 10] } },
  ];
  // uma corrida: sondas contra a teoria (σ = M·c/I = 100·50·5/833,3 = 30 MPa)
  const one = await (await solve(doc, fem({ mesh: { size: 2.5, order: 2, curvature: 0 }, loads, probes }))).run();
  const m = Object.fromEntries(one.metrics.map((x) => [x.key, x.value]));
  near(-m.probe1, delta, 0.03);
  near(m.probe2, 30, 0.05);
  assert.ok(one.summary.some(([k, v]) => /Sonda: Flecha/.test(k) && /média na face/.test(v)));
  // automático com tetraedros lineares: refina até GCI < 3 % na flecha da ponta
  const { dir } = await solve(doc, fem({ mesh: { size: 5, order: 1, curvature: 0 }, loads, probes }));
  const r = await runCase(dir, () => {}, false, { convergence: { ratio: 1.5, target: 0.03, maxLevels: 6 } });
  const a = r.convergence!.auto!;
  assert.equal(a.metric, "probe1");
  assert.ok(a.steps.length >= 3, `${a.steps.length} níveis`);
  assert.ok(a.steps.every((s2, i) => i === 0 || s2.cells > a.steps[i - 1].cells), "malhas cada vez mais finas");
  assert.ok(a.achieved, `${a.stop} ${JSON.stringify(a.steps)}`);
  const row = r.convergence!.rows.find((x) => x.key === "probe1")!;
  assert.ok(row.gci.gciFine <= 0.03);
  assert.ok(Math.abs(-row.gci.extrapolated - delta) < Math.abs(-row.values[0] - delta), `extrapolado ${row.gci.extrapolated} vs ${delta} (fina ${row.values[0]})`);
  assert.equal(r.cells, a.steps.at(-1)!.cells);
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
  assert.equal(r.metrics.find((m) => m.key === "dp")!.value.toPrecision(5), got.toPrecision(5));
  // campos no 3D: corte longitudinal com o perfil desenvolvido (u_máx/u_médio = 2,096 numa conduta
  // quadrada, Shah & London) e paredes com a pressão a descer ao longo da conduta
  const v = r.view!;
  assert.deepEqual(v.fields.map((f) => f.name), ["Pressão", "Velocidade"]);
  const slice = v.layers.find((l) => l.visible && l.name.startsWith("Corte Z"))!;
  assert.ok(slice && slice.triangles.length > 300, "corte Z visível");
  const speed = slice.values[1]!;
  const umax = speed.reduce((a, b) => Math.max(a, b), 0), umin = speed.reduce((a, b) => Math.min(a, b), Infinity);
  assert.ok(umax > 1.8 * U && umax < 2.25 * U, `u_máx/U = ${(umax / U).toFixed(3)}`);
  assert.ok(umin < 0.05 * U, `|U| nas paredes ${umin}`);
  for (let i = 0; i < slice.positions.length; i += 3) assert.ok(Math.abs(slice.positions[i + 2] - 5) < 1e-6, "corte em z = 5 mm");
  const walls = v.layers.find((l) => l.name === "Paredes")!;
  assert.equal(walls.visible, false);
  assert.equal(walls.values[1], null);
  const xs = walls.positions.filter((_, i) => i % 3 === 0), ps = walls.values[0]!;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, mp = ps.reduce((a, b) => a + b, 0) / ps.length;
  const cov = xs.reduce((a, x, i) => a + (x - mx) * (ps[i] - mp), 0);
  assert.ok(cov < 0, "pressão a descer ao longo de x");
  const inlet = v.layers.find((l) => l.name === "Entrada")!;
  assert.ok(inlet.values[1]!.every((x) => Math.abs(x - U) < 1e-9 || x < U), "velocidade imposta na entrada");
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
