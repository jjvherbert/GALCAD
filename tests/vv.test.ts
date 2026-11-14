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
async function ring(half?: number) {
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
  doc = addFeature(doc, half
    ? { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: half }, end2: { type: "blind", depth: half } }
    : { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 100 } }).doc;
  const r = await new Engine().rebuild(doc);
  const faces = r.ctx.body!.faces.map((f) => ({ name: f.name, p: faceProps(f.face) }));
  const plane = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = faces.find((x) => x.p.normal && Math.abs(Math.abs(x.p.normal[axis]) - 1) < 1e-9 && Math.abs(x.p.center[axis] - v) < 1e-6)!;
    return { kind: "face", name: f.name };
  };
  return { doc, plane, sym: half ? [] : [plane(0, 0), plane(1, 0), plane(2, 0)], outer: faces.filter((x) => x.name.includes(":sp1")).map((x): TopoRef => ({ kind: "face", name: x.name })) };
}

for (const solver of ["calculix", "code_aster"] as const) {
  const has = !!(T.gmsh && (solver === "calculix" ? T.calculix : T.code_aster));
  test(`NAFEMS LE1 (${solver}): σyy no ponto D = 92,7 MPa`, { skip: !has && `${solver} não instalado`, timeout: 900000 }, async () => {
    const { doc, sym, outer } = await ring();
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

/** NAFEMS LE10: placa elíptica espessa (mesmas elipses do LE1, z = −300…300), pressão de 1 MPa na face de cima.
 *  Apoios: y=0 → uy=0; x=0 → ux=0; face exterior → ux=uy=0; aresta a meia espessura da face exterior → uz=0
 *  (aresta aberta por uma partição z=0 e referida como `cut@<face exterior>`). Alvo: σyy em D (2000, 0, 300) = −5,38 MPa. */
for (const solver of ["calculix", "code_aster"] as const) {
  const has = !!(T.gmsh && (solver === "calculix" ? T.calculix : T.code_aster));
  test(`NAFEMS LE10 (${solver}): σyy no ponto D = −5,38 MPa`, { skip: !has && `${solver} não instalado`, timeout: 900000 }, async () => {
    const { doc, plane, outer } = await ring(300);
    const s: FemStudy = {
      ...newFemStudy("s1", 1), solver, material: { ...SIM_MATERIALS[0] },
      mesh: { size: 100, order: 2, curvature: 12, partitions: [{ axis: "z", at: 0 }] },
      loads: [
        { kind: "displacement", faces: [plane(1, 0)], uy: 0 },
        { kind: "displacement", faces: [plane(0, 0)], ux: 0 },
        { kind: "displacement", faces: outer, ux: 0, uy: 0 },
        { kind: "displacement", faces: [], edges: outer.map((f): TopoRef => ({ kind: "edge", name: `cut@${f.name}` })), uz: 0 },
        { kind: "pressure", faces: [plane(2, 300)], p: 1 },
      ],
      probes: [{ name: "σyy D", quantity: "syy", at: { kind: "point", point: [2000, 0, 300] } }],
    } as FemStudy;
    const r = await run(doc, s);
    assert.match(r.solver ?? "", solver === "calculix" ? /calculix/i : /code_aster/);
    const v = r.fem!.metrics.find((m) => m.key === "probe1")!.value;
    console.log(`LE10 ${solver}: σyy(D) = ${v}`);
    near(v, -5.38, 0.05);
  });
}

/** NAFEMS LE11: cilindro/cone/esfera de parede espessa (revolução de 90°) sob o campo de temperatura
 *  T = (√(x² + y²) + z)/1000 °C, α = 2,3e-4, E = 210 GPa, ν = 0,3. Apoios: simetria em x = 0 e y = 0;
 *  uz = 0 nas faces planas z = 0 e z = 1797,1 (corpo em z ≥ 0). Alvo: σzz no ponto A (1000, 0, 0) = −105 MPa. */
async function le11() {
  const s = new SketchBuilder({ kind: "std", name: "XZ" });
  const P = (x: number, y: number) => s.point(x, y, { fixed: true });
  const O = P(0, 0);
  // perfil no plano XZ (x = raio, y do esboço = z global), coordenadas da geometria de referência (m → mm)
  const zc = 1000 * Math.SQRT1_2, zTop = 1797.107, rc = Math.sqrt(1400 ** 2 - zc ** 2);
  const a = P(1000, 0), b = P(1400, 0), c = P(rc, zc), d = P(1000, 1397.107);
  const e = P(1000, zTop), f = P(zc, zTop), g = P(zc, zc);
  s.line(a, b);
  s.entities["arcOut"] = { type: "arc", c: O, s: b, e: c, r: 1400, a0: 0, a1: Math.asin(zc / 1400) } as never;
  s.line(c, d); s.line(d, e); s.line(e, f); s.line(f, g);
  s.entities["arcIn"] = { type: "arc", c: O, s: a, e: g, r: 1000, a0: 0, a1: Math.PI / 4 } as never;
  const axis = s.line(P(0, -400), P(0, -200), true);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "revolve", sketch: "f1", axis: { kind: "sketchLine", sketch: "f1", entity: axis }, op: "add", angle: 90 }).doc;
  const r = await new Engine().rebuild(doc);
  const faces = r.ctx.body!.faces.map((x) => ({ name: x.name, p: faceProps(x.face) }));
  const plane = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const x = faces.find((q) => q.p.normal && Math.abs(Math.abs(q.p.normal[axis]) - 1) < 1e-6 && Math.abs(q.p.center[axis] - v) < 1e-3);
    assert.ok(x, `face plana ${"xyz"[axis]} = ${v} não encontrada`);
    return { kind: "face", name: x.name };
  };
  return { doc, plane, zTop };
}

for (const solver of ["calculix", "code_aster"] as const) {
  const has = !!(T.gmsh && (solver === "calculix" ? T.calculix : T.code_aster));
  test(`NAFEMS LE11 (${solver}): σzz no ponto A = −105 MPa`, { skip: !has && `${solver} não instalado`, timeout: 900000 }, async () => {
    const { doc, plane, zTop } = await le11();
    const s: FemStudy = {
      ...newFemStudy("s1", 1), solver,
      material: { ...SIM_MATERIALS[0], name: "LE11", E: 210000, nu: 0.3, alpha: 2.3e-4 },
      mesh: { size: 80, order: 2, curvature: 12 },
      loads: [
        { kind: "symmetry", faces: [plane(0, 0), plane(1, 0)] },
        { kind: "displacement", faces: [plane(2, 0), plane(2, zTop)], uz: 0 },
        { kind: "thermalField", t: "(sqrt(x^2 + y^2) + z)/1000", tRef: 0 },
      ],
      probes: [{ name: "σzz A", quantity: "szz", at: { kind: "point", point: [1000, 0, 0] } }],
    } as FemStudy;
    const r = await run(doc, s);
    assert.match(r.solver ?? "", solver === "calculix" ? /calculix/i : /code_aster/);
    const v = r.fem!.metrics.find((m) => m.key === "probe1")!.value;
    console.log(`LE11 ${solver}: σzz(A) = ${v}`);
    near(v, -105, 0.05);
  });
}
