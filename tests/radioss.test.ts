// OpenRadioss (OpenCourant): deck Starter/Engine e leitura das animações (VTK do anim_to_vtk), e o
// caso de referência real — consola sob carga em degrau (fator 2 em T₁/2), só com o binário oficial
// instalado (CAD_RADIOSS_DIR; na CI Linux e Windows).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import type { CadDocument, TopoRef } from "../src/doc/types.ts";
import { type FemStudy, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import type { FemCase } from "../src/sim/case.ts";
import { parseMsh } from "../src/sim/msh.ts";
import { parseVtk, radiossBlocks, radiossDeck } from "../src/sim/radioss.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);
const T = tools();
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);

async function bar() {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 10, 100, 10);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => ({ kind: "face", name: r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[axis]) - 1) < 1e-9 && Math.abs(p.center[axis] - v) < 1e-6; })!.name });
  return { doc, face };
}

async function solve(doc: CadDocument, study: FemStudy) {
  const r = await new Engine().rebuild(doc);
  const sim = studyCase(r.ctx, study);
  const dir = mkdtempSync(join(tmpdir(), "cad-rad-"));
  for (const [p, data] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  return { sim, dir, c: sim.case as FemCase, run: () => runCase(dir) };
}

const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, F = 100, G = E / (2 * (1 + nu));
const delta = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * A);
const f1 = ((1.875104 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (7.85e-9 * A * L ** 4));

const study = (face: (a: 0 | 1 | 2, v: number) => TopoRef, patch: Partial<FemStudy> = {}): FemStudy => ({
  ...newFemStudy("s1", 1), solver: "openradioss", material: { ...SIM_MATERIALS[0] }, analysis: "dynamic",
  mesh: { size: 2.5, order: 1, curvature: 0, element: "hex", integration: "reduced" },
  dynamic: { scheme: "explicit", duration: 1.2e-3, load: "step", frames: 48 },
  loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }],
  probes: [{ name: "Ponta", quantity: "uz", at: { kind: "point", point: [100, 5, 5] } }], ...patch,
});

test("OpenRadioss: Starter e Engine (unidades kg–mm–ms, colunas fixas, forças nodais = F, apoio)", { skip: !T.gmsh && "Gmsh não instalado" }, async () => {
  const { doc, face } = await bar();
  const { dir, c } = await solve(doc, study(face, { dynamic: { scheme: "explicit", duration: 1.2e-3, load: "step", frames: 48, alpha: 500 } }));
  assert.equal(c.solver, "openradioss");
  spawnSync(T.gmsh!.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], { cwd: dir });
  const m = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const d = radiossDeck(c, m);
  const S = d.starter.split("\n");
  assert.equal(S[S.indexOf("/BEGIN") + 3], `${"kg".padStart(20)}${"mm".padStart(20)}${"ms".padStart(20)}`);
  // E em GPa e ρ em kg/mm³
  const mat = S.indexOf("/MAT/ELAST/1");
  assert.equal(Number(S[mat + 3].slice(0, 20)), 7.85e-6);
  assert.equal(Number(S[mat + 5].slice(0, 20)), 210);
  assert.equal(Number(S[mat + 5].slice(20, 40)), 0.3);
  // 40 × 4 × 4 hexaedros com Isolid 24
  assert.equal(d.elements, 640);
  const brick = S.indexOf("/BRICK/11");
  assert.equal(S[brick + 1].length, 90);
  assert.match(d.starter, /\/PROP\/SOLID\/1\nhexaedros \(Isolid 24\)\n.*\n {8}24/);
  // apoio: Tra 111, rot 000, grupo com os 25 nós da face x = 0
  const bcs = S[S.indexOf("/BCS/1") + 3];
  assert.equal(bcs.slice(0, 10), "   111 000");
  const g = Number(bcs.slice(20, 30));
  const grp = S.indexOf(`/GRNOD/NODE/${g}`);
  const nodes = S.slice(grp + 2, S.findIndex((l, i) => i > grp + 1 && l.startsWith("/"))).flatMap((l) => l.match(/.{10}/g)!.map(Number));
  assert.equal(nodes.length, 25);
  // soma das forças nodais (kN) = −0,1 kN em Z; amplitude em ms
  let fz = 0;
  S.forEach((l, i) => { if (l.startsWith("/CLOAD/")) { const r = S[i + 3]; assert.equal(r.slice(10, 20).trim(), "Z"); const gid = Number(r.slice(40, 50)); const gi = S.indexOf(`/GRNOD/NODE/${gid}`); const n = S.slice(gi + 2, S.findIndex((x, k) => k > gi + 1 && x.startsWith("/"))).flatMap((x) => x.match(/.{10}/g)!).length; fz += n * Number(r.slice(80, 100)); } });
  near(fz, -0.1, 1e-9);
  const fn = S.indexOf("/FUNCT/1");
  assert.deepEqual([S[fn + 3], S[fn + 4]].map((l) => [Number(l.slice(0, 20)), Number(l.slice(20, 40))]), [[0, 1], [1.2, 1]]);
  // Rayleigh: α em 1/ms
  assert.equal(Number(S[S.indexOf("/DAMP/1") + 3].slice(0, 20)), 0.5);
  assert.match(d.engine, /\/RUN\/galcad\/1\n\s+1\.2\n\/ANIM\/DT\n\s+0\s+0\.025\n\/ANIM\/VECT\/DISP\n\/ANIM\/ELEM\/VONM/);
  assert.ok(d.starter.trimEnd().endsWith("/END"));
  // quadráticos recusados (o explícito quer elementos lineares)
  const q = await solve(doc, study(face, { mesh: { size: 5, order: 2, curvature: 0, element: "hex" } }));
  spawnSync(T.gmsh!.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], { cwd: q.dir });
  assert.throws(() => radiossDeck(q.c, parseMsh(readFileSync(join(q.dir, "mesh.msh"), "utf8"))), /elementos lineares/);
  // só explícito
  await assert.rejects(async () => solve(doc, study(face, { dynamic: { scheme: "implicit", duration: 1e-3, load: "step" } })), /só integração explícita/);
});

test("OpenRadioss: leitura do VTK do anim_to_vtk (NODE_ID, deslocamentos, von Mises por célula)", () => {
  const vtk = [
    "# vtk DataFile Version 3.0", "vtk output", "ASCII", "DATASET UNSTRUCTURED_GRID",
    "FIELD FieldData 2", "TIME 1 1 double", "0.6", "CYCLE 1 1 int", "0",
    "POINTS 4 float", "0 0 0", "1 0 0", "0 1 0", "0 0 1", "",
    "CELLS 1 5", "4 0 1 2 3", "", "CELL_TYPES 1", "10", "",
    "POINT_DATA 4", "SCALARS NODE_ID int 1", "LOOKUP_TABLE default", "7", "8", "9", "10", "",
    "VECTORS Displacement float", "0 0 0", "0 0 -0.1", "0 0 -0.2", "0 0 -0.3", "",
    "CELL_DATA 1", "SCALARS ELEMENT_ID int 1", "LOOKUP_TABLE default", "1", "", "SCALARS PART_ID int 1", "LOOKUP_TABLE default", "12", "",
    "SCALARS Von Mises float 1", "LOOKUP_TABLE default", "0.05", "",
  ].join("\n");
  const f = parseVtk(vtk);
  assert.equal(f.time, 0.6);
  assert.deepEqual(f.nodeIds, [7, 8, 9, 10]);
  assert.deepEqual(f.cellTypes, [10]);
  const b = radiossBlocks([f]);
  const disp = b.find((x) => x.name === "DISP")!;
  assert.equal(disp.value, 6e-4);
  assert.deepEqual(disp.data.get(10), [0, 0, -0.3]);
  assert.deepEqual(b.find((x) => x.name === "VMIS")!.data.get(8), [50]);
});

test("OpenRadioss real: consola sob degrau — pico ≈ 2× Timoshenko em T₁/2", { skip: !(T.gmsh && T.openradioss) && "OpenRadioss não instalado (CAD_RADIOSS_DIR)", timeout: 1800000 }, async () => {
  const { doc, face } = await bar();
  const r = await (await solve(doc, study(face))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  assert.match(r.solver, /OpenRadioss/);
  const peak = r.metrics.find((x) => x.key === "probe1")!.value;
  // hexaedros lineares com estabilização física (Isolid 24), 4 camadas na espessura
  near(-peak / delta, 2, 0.1);
  near(r.metrics.find((x) => x.key === "tpeak")!.value, 1 / (2 * f1), 0.1);
  assert.ok(r.fem!.timeHistory!.times.length > 20);
});
