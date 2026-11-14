// V&V (F5d): casos de referência NAFEMS corridos com os solvers reais (CalculiX e code_aster).
// Saltam quando gmsh/ccx/run_aster não estão instalados. Dossier: docs/VV.md.
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
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);

async function run(doc: CadDocument, s: FemStudy) {
  const r = await new Engine().rebuild(doc);
  const sim = studyCase(r.ctx, s);
  const dir = mkdtempSync(join(tmpdir(), "cad-vv-"));
  for (const [p, d] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }
  return runCase(dir);
}

/** NAFEMS LE1: placa elíptica (quarto de anel entre elipses), tração normal de 10 MPa na elipse exterior.
 *  Alvo: σyy no ponto D (2000, 0) = 92,7 MPa (estado plano de tensão; aqui 3D com 100 mm de espessura). */
async function le1() {
  const s = new SketchBuilder();
  const n = 24, deg = (i: number) => (Math.PI / 2) * (i / n);
  const D = s.point(2000, 0, { fixed: true }), C = s.point(3250, 0, { fixed: true });
  const B = s.point(0, 2750, { fixed: true }), A = s.point(0, 1000, { fixed: true });
  const outer = [C, ...Array.from({ length: n - 1 }, (_, i) => s.point(3250 * Math.cos(deg(i + 1)), 2750 * Math.sin(deg(i + 1)), { fixed: true })), B];
  const inner = [A, ...Array.from({ length: n - 1 }, (_, i) => s.point(2000 * Math.cos(deg(n - 1 - i)), 1000 * Math.sin(deg(n - 1 - i)), { fixed: true })), D];
  s.line(D, C);
  s.entities["sp1"] = { type: "spline", pts: outer } as never;
  s.line(B, A);
  s.entities["sp2"] = { type: "spline", pts: inner } as never;
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 100 } }).doc;
  const r = await new Engine().rebuild(doc);
  const faces = r.ctx.body!.faces.map((f) => ({ name: f.name, p: faceProps(f.face) }));
  const plane = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = faces.find((x) => x.p.normal && Math.abs(Math.abs(x.p.normal[axis]) - 1) < 1e-9 && Math.abs(x.p.center[axis] - v) < 1e-6)!;
    return { kind: "face", name: f.name };
  };
  return { doc, sym: [plane(0, 0), plane(1, 0), plane(2, 0)], outer: faces.filter((x) => x.name.includes(":sp1")).map((x): TopoRef => ({ kind: "face", name: x.name })) };
}

for (const solver of ["calculix", "code_aster"] as const) {
  const has = !!(T.gmsh && (solver === "calculix" ? T.calculix : T.code_aster));
  test(`NAFEMS LE1 (${solver}): σyy no ponto D = 92,7 MPa`, { skip: !has && `${solver} não instalado`, timeout: 900000 }, async () => {
    const { doc, sym, outer } = await le1();
    const s: FemStudy = {
      ...newFemStudy("s1", 1), solver, material: { ...SIM_MATERIALS[0] }, mesh: { size: 80, order: 2, curvature: 12 },
      loads: [{ kind: "symmetry", faces: sym }, { kind: "pressure", faces: outer, p: -10 }],
      probes: [{ name: "σyy D", quantity: "syy", at: { kind: "point", point: [2000, 0, 0] } }],
    } as FemStudy;
    const r = await run(doc, s);
    assert.match(r.solver ?? "", solver === "calculix" ? /calculix/i : /code_aster/);
    const v = r.fem!.metrics.find((m) => m.key === "probe1")!.value;
    console.log(`LE1 ${solver}: σyy(D) = ${v}`);
    near(v, 92.7, 0.03);
  });
}
