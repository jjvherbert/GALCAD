// Dinâmica transitória (implícita e explícita) no CalculiX e no code_aster, verificada com a consola
// sob carga em degrau: sem amortecimento a flecha máxima é 2× a estática (fator de amplificação
// dinâmica de um oscilador sob degrau) e chega em T₁/2, com f₁ = 1,875²/(2π)·√(EI/(ρA·L⁴)) ≈ 835 Hz;
// com Rayleigh ζ no 1.º modo o fator é 1 + exp(−ζπ/√(1−ζ²)).
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
import { type FemCase, amplitudeAt, amplitudeIntegral, amplitudeTable } from "../src/sim/case.ts";
import { runCase, tools } from "../tools/cad-runner.ts";
import { parseMsh } from "../src/sim/msh.ts";
import { calculixDeck } from "../src/sim/calculix.ts";
import { asterCase } from "../src/sim/aster.ts";
import { radiossDeck } from "../src/sim/radioss.ts";

before(initKernel);
const T = tools();
const hasFem = !!(T.gmsh && T.calculix);
const hasAster = !!(T.gmsh && T.code_aster);
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
  const dir = mkdtempSync(join(tmpdir(), "cad-dyn-"));
  for (const [p, data] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  return { sim, dir, c: sim.case as FemCase, run: () => runCase(dir) };
}

const E = 210000, I = (10 * 10 ** 3) / 12, rhoA = 7.85e-9 * 100, L = 100;
const f1 = ((1.875104 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (rhoA * L ** 4));
const tip = [100, 5, 5] as [number, number, number];

/** Estudo da consola com uma sonda uz na ponta: estática ou dinâmica. */
function study(face: (a: 0 | 1 | 2, v: number) => TopoRef, patch: Partial<FemStudy>): FemStudy {
  return {
    ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 5, order: 2, curvature: 0, element: "hex" },
    loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -100] }],
    probes: [{ name: "Ponta", quantity: "uz", at: { kind: "point", point: tip } }], ...patch,
  };
}
const probe = (r: Awaited<ReturnType<typeof runCase>>) => r.metrics.find((x) => x.key === "probe1")!.value;

test("amplitude: degrau, rampa, meio seno e seno", () => {
  assert.deepEqual(amplitudeTable("step", 1), [[0, 1], [1, 1]]);
  assert.deepEqual(amplitudeTable("ramp", 1, 0.25), [[0, 0], [0.25, 1], [1, 1]]);
  const hs = amplitudeTable("halfsine", 1, undefined, 0.2);
  assert.deepEqual(hs.at(-1), [1, 0]);
  const c = { dynamic: { amplitude: hs } } as FemCase;
  near(amplitudeAt(c, 0.1), 1, 0.005);
  near(amplitudeAt(c, 0.05), Math.SQRT1_2, 0.005);
  assert.equal(amplitudeAt(c, 0.5), 0);
  near(amplitudeAt({ dynamic: { amplitude: amplitudeTable("sine", 1, undefined, 0.4) } } as FemCase, 0.3), -1, 0.005);
  // integral (deslocamento de uma velocidade imposta): degrau → reta; rampa → parábola; meio seno de duração T → 2T/π
  assert.deepEqual(amplitudeIntegral([[0, 1], [1, 1]], 1), [[0, 0], [1, 1], [1.5, 1.5]]);
  const ri = amplitudeIntegral([[0, 0], [1, 1]], 1);
  near(ri.find(([t]) => t === 0.5)![1], 0.125, 1e-12);
  near(ri.at(-1)![1], 1, 1e-12);
  const hi = amplitudeIntegral(amplitudeTable("halfsine", 1, undefined, 0.2), 1);
  near(hi.at(-1)![1], (2 * 0.2) / Math.PI, 0.01);
  assert.deepEqual(amplitudeIntegral([[0.5, 2]], 1).slice(0, 2), [[0, 0], [0.5, 1]]);
});

test("caso dinâmico: amplitude, Rayleigh, hipóteses e deck do CalculiX", async () => {
  const { doc, face } = await bar();
  const { c } = await solve(doc, study(face, { analysis: "dynamic", dynamic: { scheme: "implicit", duration: 3e-3, load: "step", alpha: 500 } }));
  assert.equal(c.dynamic!.dt, 1.5e-5);
  assert.equal(c.dynamic!.alpha, 500);
  assert.ok(c.hypotheses[0].includes("integração implícita") && /Rayleigh/.test(c.hypotheses[0]));
});

test("CalculiX implícito: consola sob degrau — amplificação 2 em T₁/2; Rayleigh ζ = 5 %", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const ds = probe(await (await solve(doc, study(face, {}))).run());
  const r = await (await solve(doc, study(face, { analysis: "dynamic", dynamic: { scheme: "implicit", duration: 3e-3, load: "step", frames: 200 } }))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  const peak = probe(r);
  near(peak / ds, 2, 0.06);
  const h = r.fem!.timeHistory!;
  const s = h.series.find((x) => x.key === "probe1")!.values;
  // primeiro mínimo (pico da flecha) em T₁/2
  const first = s.findIndex((v, i) => i > 0 && i < s.length - 1 && v < s[i - 1] && v <= s[i + 1]);
  near(h.times[first], 1 / (2 * f1), 0.06);
  assert.ok(r.fem!.displacements.length > 10 && r.fem!.displacements.some((d) => /pico/.test(d.label)));
  assert.ok(r.summary.some(([k, v]) => k === "Integração no tempo" && /implícita/.test(v)));
  // amortecimento proporcional à massa com ζ = 5 % no 1.º modo: α = 2ζω₁
  const zeta = 0.05;
  const rd = await (await solve(doc, study(face, { analysis: "dynamic", dynamic: { scheme: "implicit", duration: 3e-3, load: "step", alpha: 2 * zeta * 2 * Math.PI * f1, frames: 200 } }))).run();
  near(probe(rd) / ds, 1 + Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta ** 2)), 0.06);
});

test("CalculiX explícito: passo estável da malha (sem escalar massa), amplificação 2", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const mesh: FemStudy["mesh"] = { size: 2.5, order: 1, curvature: 0, element: "hex", integration: "reduced" };
  const ds = probe(await (await solve(doc, study(face, { mesh }))).run());
  const r = await (await solve(doc, study(face, { mesh, analysis: "dynamic", dynamic: { scheme: "explicit", duration: 1.2e-3, load: "step" } }))).run();
  assert.ok(r.ok);
  assert.ok(!r.warnings.some((w) => /escalou a massa/.test(w)), r.warnings.join(" | "));
  assert.ok(r.summary.some(([k, v]) => k === "Integração no tempo" && /explícita/.test(v) && /estável da malha/.test(v)));
  near(probe(r) / ds, 2, 0.08);
  near(r.metrics.find((x) => x.key === "tpeak")!.value, 1 / (2 * f1), 0.1);
});

test("code_aster implícito (Newmark): amplificação 2 e Rayleigh ζ = 5 % (convenção AMOR_ALPHA/AMOR_BETA)", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 1800000 }, async () => {
  const { doc, face } = await bar();
  const base = { solver: "code_aster" as const };
  const ds = probe(await (await solve(doc, study(face, base))).run());
  const r = await (await solve(doc, study(face, { ...base, analysis: "dynamic", dynamic: { scheme: "implicit", duration: 1.5e-3, load: "step", frames: 100 } }))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(probe(r) / ds, 2, 0.06);
  near(r.metrics.find((x) => x.key === "tpeak")!.value, 1 / (2 * f1), 0.06);
  const zeta = 0.05;
  const rd = await (await solve(doc, study(face, { ...base, analysis: "dynamic", dynamic: { scheme: "implicit", duration: 1.5e-3, load: "step", alpha: 2 * zeta * 2 * Math.PI * f1, frames: 100 } }))).run();
  near(probe(rd) / ds, 1 + Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta ** 2)), 0.06);
});

test("code_aster explícito (DIFF_CENT, massa diagonal): amplificação 2", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 1800000 }, async () => {
  const { doc, face } = await bar();
  const mesh: FemStudy["mesh"] = { size: 5, order: 1, curvature: 0, element: "hex", integration: "full" };
  const ds = probe(await (await solve(doc, study(face, { solver: "code_aster", mesh }))).run());
  const r = await (await solve(doc, study(face, { solver: "code_aster", mesh, analysis: "dynamic", dynamic: { scheme: "explicit", duration: 0.8e-3, load: "step", frames: 40 } }))).run();
  assert.ok(r.ok);
  // HEXA8 com integração completa é mais rígido (bloqueio): compara-se com a estática da mesma malha
  near(probe(r) / ds, 2, 0.08);
});

/** Barra livre (sem apoios nem cargas) lançada a v₀ = −1 m/s em Z: ao fim de 1 ms desceu 1 mm como corpo rígido. */
const fly = (face: (a: 0 | 1 | 2, v: number) => TopoRef, patch: Partial<FemStudy>, dyn: Partial<NonNullable<FemStudy["dynamic"]>>) =>
  study(face, { loads: [], ...patch, analysis: "dynamic", dynamic: { scheme: "implicit", duration: 1e-3, load: "step", frames: 20, v0: [0, 0, -1], ...dyn } });

test("velocidade inicial: caso e decks do CalculiX, code_aster e OpenRadioss", { skip: !T.gmsh && "Gmsh não instalado" }, async () => {
  const { doc, face } = await bar();
  const mesh: FemStudy["mesh"] = { size: 5, order: 1, curvature: 0, element: "hex", integration: "reduced" };
  const { dir, c } = await solve(doc, fly(face, { mesh }, { v0: [0, "0", "-2/2"] }));
  assert.deepEqual(c.dynamic!.v0, [0, 0, -1]);
  // omissa ou nula: repouso (sem campo no caso)
  assert.equal((await solve(doc, fly(face, { mesh }, { v0: [0, 0, 0] }))).c.dynamic!.v0, undefined);
  await assert.rejects(async () => solve(doc, fly(face, { mesh }, { v0: [0, 0, "x/0"] })), /velocidade inicial/i);
  spawnSync(T.gmsh!.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], { cwd: dir, shell: /\.(cmd|bat)$/i.test(T.gmsh!.path) });
  const m = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const inp = calculixDeck(c, m).inp;
  assert.match(inp, /\*INITIAL CONDITIONS, TYPE=VELOCITY\r?\nNALL, 3, -1000\.?0*\r?\n/);
  assert.ok(!/NALL, 1,/.test(inp));
  assert.match(asterCase(c, m).files["job.comm"], /V0 = CREA_CHAMP\(.*VALE=\(0\.?0*, 0\.?0*, -1000\.?0*\)\)\)[\s\S]*ETAT_INIT=_F\(VITE=V0\)/);
  const S = radiossDeck({ ...c, dynamic: { ...c.dynamic!, scheme: "explicit" } }, m).starter.split("\n");
  const iv = S.indexOf("/INIVEL/TRA/1");
  assert.ok(iv > 0);
  const row = S[iv + 3];
  assert.deepEqual([Number(row.slice(0, 20)), Number(row.slice(20, 40)), Number(row.slice(40, 60))], [0, 0, -1]);
  // sem v₀ não há /INIVEL
  assert.ok(!radiossDeck({ ...c, dynamic: { ...c.dynamic!, scheme: "explicit", v0: undefined } }, m).starter.includes("/INIVEL"));
});

/** Barra com a face x = 0 a −1 m/s em z (x e y presos): a face desce 1 mm em 1 ms. */
const pushed = (face: (a: 0 | 1 | 2, v: number) => TopoRef, patch: Partial<FemStudy>, dyn: Partial<NonNullable<FemStudy["dynamic"]>> = {}) =>
  fly(face, { loads: [{ kind: "displacement", faces: [face(0, 0)], ux: 0, uy: 0, uz: -1, velocity: true }], probes: [{ name: "Face", quantity: "uz", at: { kind: "point", point: [0, 5, 5] } }], ...patch }, { v0: undefined, ...dyn });

test("velocidade imposta: validação e decks do CalculiX e code_aster", { skip: !T.gmsh && "Gmsh não instalado" }, async () => {
  const { doc, face } = await bar();
  const mesh: FemStudy["mesh"] = { size: 5, order: 1, curvature: 0, element: "hex", integration: "reduced" };
  const { dir, c } = await solve(doc, pushed(face, { mesh }));
  const ld = c.loads.find((l) => l.kind === "displacement")!;
  assert.ok(ld.kind === "displacement" && ld.velocity && ld.u[2] === -1);
  await assert.rejects(async () => solve(doc, { ...pushed(face, { mesh }), analysis: "static" }), /só existe na análise dinâmica/);
  spawnSync(T.gmsh!.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], { cwd: dir, shell: /\.(cmd|bat)$/i.test(T.gmsh!.path) });
  const m = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const inp = calculixDeck(c, m).inp;
  assert.match(inp, /\*AMPLITUDE, NAME=A2\r?\n0\.?0*, 0\.?0*, /);
  assert.match(inp, /\*BOUNDARY, AMPLITUDE=A2\r?\n\S+, 3, 3, -1000/);
  const comm = asterCase(c, m).files["job.comm"];
  assert.match(comm, /BCV = AFFE_CHAR_MECA\([\s\S]*DZ=-1000/);
  assert.match(comm, /F2 = DEFI_FONCTION\(NOM_PARA='INST'/);
  assert.match(comm, /_F\(CHARGE=BCV, FONC_MULT=F2\)/);
});

test("CalculiX real: face a −1 m/s imposta desce 1 mm em 1 ms (implícito e explícito)", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const r = await (await solve(doc, pushed(face, {}))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(probe(r), -1, 0.02);
  const mesh: FemStudy["mesh"] = { size: 5, order: 1, curvature: 0, element: "hex", integration: "reduced" };
  const re = await (await solve(doc, pushed(face, { mesh }, { scheme: "explicit" }))).run();
  assert.ok(re.ok, JSON.stringify(re.warnings));
  near(probe(re), -1, 0.02);
});

test("code_aster real: face a −1 m/s imposta desce 1 mm em 1 ms", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 1800000 }, async () => {
  const { doc, face } = await bar();
  const r = await (await solve(doc, pushed(face, { solver: "code_aster", mesh: { size: 5, order: 1, curvature: 0, element: "hex", integration: "full" } }))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(probe(r), -1, 0.02);
});

test("CalculiX real: barra livre a v₀ = −1 m/s desce 1 mm em 1 ms (implícito e explícito)", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const r = await (await solve(doc, fly(face, {}, {}))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(probe(r), -1, 0.02);
  const mesh: FemStudy["mesh"] = { size: 5, order: 1, curvature: 0, element: "hex", integration: "reduced" };
  const re = await (await solve(doc, fly(face, { mesh }, { scheme: "explicit" }))).run();
  assert.ok(re.ok, JSON.stringify(re.warnings));
  near(probe(re), -1, 0.02);
});

test("code_aster real: barra livre a v₀ = −1 m/s desce 1 mm em 1 ms (ETAT_INIT)", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 1800000 }, async () => {
  const { doc, face } = await bar();
  const r = await (await solve(doc, fly(face, { solver: "code_aster", mesh: { size: 5, order: 1, curvature: 0, element: "hex", integration: "full" } }, {}))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(probe(r), -1, 0.02);
});

/** Barra presa em x = 0 e puxada em x = 100 a 1 m/s durante 1 ms: ε ≈ 1 % ≫ εy = 0,11 % (S235). */
const pulled = (face: (a: 0 | 1 | 2, v: number) => TopoRef, patch: Partial<FemStudy>, dyn: Partial<NonNullable<FemStudy["dynamic"]>> = {}) =>
  fly(face, {
    nonlinear: { plasticity: true }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "displacement", faces: [face(0, 100)], ux: 1, velocity: true }],
    probes: [{ name: "Ponta", quantity: "ux", at: { kind: "point", point: [100, 5, 5] } }], ...patch,
  }, { v0: undefined, ...dyn });
const peeqOk = (r: Awaited<ReturnType<typeof runCase>>) => {
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(probe(r), 1, 0.02);
  const pe = r.metrics.find((x) => x.key === "peeq")?.value ?? 0;
  assert.ok(pe > 0.004 && pe < 0.05, `PEEQ ${pe}`);
};

test("plasticidade na dinâmica: decks do CalculiX (*PLASTIC, PEEQ) e code_aster (VMIS_ISOT_LINE, VARI_NOEU)", { skip: !T.gmsh && "Gmsh não instalado" }, async () => {
  const { doc, face } = await bar();
  const { dir, c } = await solve(doc, pulled(face, {}));
  assert.ok(c.nonlinear?.plasticity && !c.nonlinear.geometry);
  spawnSync(T.gmsh!.path, ["mesh.geo", "-3", "-o", "mesh.msh", "-nt", "1"], { cwd: dir, shell: /\.(cmd|bat)$/i.test(T.gmsh!.path) });
  const m = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const inp = calculixDeck(c, m).inp;
  assert.match(inp, /\*PLASTIC/);
  assert.match(inp, /\*EL FILE[^\n]*\r?\nS, PEEQ/);
  const comm = asterCase(c, m).files["job.comm"];
  assert.match(comm, /DYNA_NON_LINE\([\s\S]*RELATION='VMIS_ISOT_LINE'/);
  assert.match(comm, /VARI_INTERNE=\('VARI_NOEU',\)/);
});

test("CalculiX real: barra puxada a 1 m/s plastifica na dinâmica implícita", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  peeqOk(await (await solve(doc, pulled(face, { mesh: { size: 5, order: 1, curvature: 0, element: "hex", integration: "full" } }))).run());
});

test("code_aster real: barra puxada a 1 m/s plastifica (DYNA_NON_LINE, VMIS_ISOT_LINE)", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 1800000 }, async () => {
  const { doc, face } = await bar();
  peeqOk(await (await solve(doc, pulled(face, { solver: "code_aster", mesh: { size: 5, order: 1, curvature: 0, element: "hex", integration: "full" } }))).run());
});
