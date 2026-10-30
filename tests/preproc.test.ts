// Pré-processador (R4): conjuntos de faces, simetria e verificação do modelo com matriz de
// compatibilidade por solver. A simetria verifica-se contra o modelo inteiro (meia viga com
// metade da carga e simetria no plano y = 5 dá a mesma flecha que a viga inteira) com o CalculiX
// e o code_aster reais, e contra Timoshenko.
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
import { type FemStudy, SIM_MATERIALS, loadFaces, newCfdStudy, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import type { FemCase } from "../src/sim/case.ts";
import { CAPABILITIES, checkStudy, countLevel, solverVerdict, usedFeatures } from "../src/sim/modelcheck.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);
const T = tools();
const hasFem = !!(T.gmsh && T.calculix);
const hasAster = !!(T.gmsh && T.code_aster);
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);

/** Viga de 100 × `w` × 10 mm (x, y, z) com extrusão em z. */
async function beam(w: number) {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, w, 100, w);
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
  const dir = mkdtempSync(join(tmpdir(), "cad-pre-"));
  for (const [p, data] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  return { c: sim.case as FemCase, run: () => runCase(dir) };
}

const E = 210000, nu = 0.3, G = E / (2 * (1 + nu)), I = (10 * 10 ** 3) / 12, A = 100, L = 100;
const delta = (100 * L ** 3) / (3 * E * I) + (100 * L) / ((5 / 6) * G * A); // 0,19196 mm

const base = (patch: Partial<FemStudy>): FemStudy => ({ ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 2, curvature: 0, element: "hex", integration: "reduced" }, ...patch });
const endUz = (face: (a: 0 | 1 | 2, v: number) => TopoRef): FemStudy["probes"] => [{ name: "Ponta", quantity: "uz", at: { kind: "faces", faces: [face(0, 100)] } }];
const tip = (r: Awaited<ReturnType<typeof runCase>>) => r.metrics.find((x) => x.key === "probe1")!.value;

test("conjuntos: as condições com `sets` dão o mesmo caso que com as faces diretas", async () => {
  const { doc, face } = await beam(10);
  const direct = base({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -100] }] });
  const viaSets = base({
    sets: [{ id: "g1", name: "Apoio", faces: [face(0, 0)] }, { id: "g2", name: "Ponta", faces: [face(0, 100)] }],
    loads: [{ kind: "fixed", faces: [], sets: ["g1"] }, { kind: "force", faces: [], sets: ["g2"], f: [0, 0, -100] }],
  });
  const a = (await solve(doc, direct)).c, b = (await solve(doc, viaSets)).c;
  assert.deepEqual(b.groups, a.groups);
  assert.deepEqual(b.loads, a.loads);
  // união sem repetir: faces diretas + conjunto com a mesma face
  const dup = base({ sets: [{ id: "g1", name: "Apoio", faces: [face(0, 0)] }], loads: [{ kind: "fixed", faces: [face(0, 0)], sets: ["g1"] }] });
  assert.equal(loadFaces(dup, dup.loads[0]).length, 1);
});

test("simetria: faces normais a X, Y ou Z viram deslocamento normal nulo; faces curvas são recusadas", async () => {
  const { doc, face } = await beam(5);
  const { c } = await solve(doc, base({ loads: [{ kind: "symmetry", faces: [face(1, 5)] }, { kind: "fixed", faces: [face(0, 0)] }] }));
  const sym = c.loads.find((l) => l.kind === "displacement" && l.group.includes("SYMMETRY"))!;
  assert.deepEqual((sym as { u: (number | null)[] }).u, [null, 0, null]); // só Y fica impedido
  assert.ok(c.hypotheses.some((h) => /Simetria: modelo parcial/.test(h)));
  const s = new SketchBuilder();
  s.circle(0, 0, 10);
  let d2 = newDocument();
  d2 = addFeature(d2, s.build()).doc;
  d2 = addFeature(d2, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(d2);
  const cyl = r.ctx.body!.faces.find((x) => faceProps(x.face).type !== "plane")!;
  await assert.rejects(async () => studyCase(r.ctx, base({ loads: [{ kind: "symmetry", faces: [{ kind: "face", name: cyl.name }] }] })), /plana e alinhada/);
});

test("simetria no CalculiX: meia viga com metade da carga = viga inteira (e Timoshenko)", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 600000 }, async () => {
  const full = await beam(10), half = await beam(5);
  const rf = await (await solve(full.doc, base({ loads: [{ kind: "fixed", faces: [full.face(0, 0)] }, { kind: "force", faces: [full.face(0, 100)], f: [0, 0, -100] }], probes: endUz(full.face) }))).run();
  const rh = await (await solve(half.doc, base({ loads: [{ kind: "fixed", faces: [half.face(0, 0)] }, { kind: "symmetry", faces: [half.face(1, 5)] }, { kind: "force", faces: [half.face(0, 100)], f: [0, 0, -50] }], probes: endUz(half.face) }))).run();
  assert.ok(rf.ok && rh.ok, JSON.stringify([rf.warnings, rh.warnings]));
  near(-tip(rh), -tip(rf), 0.01);
  near(-tip(rh), delta, 0.04);
});

test("simetria no code_aster: a mesma meia viga", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 900000 }, async () => {
  const half = await beam(5);
  const r = await (await solve(half.doc, base({ solver: "code_aster", loads: [{ kind: "fixed", faces: [half.face(0, 0)] }, { kind: "symmetry", faces: [half.face(1, 5)] }, { kind: "force", faces: [half.face(0, 100)], f: [0, 0, -50] }], probes: endUz(half.face) }))).run();
  assert.ok(r.ok, JSON.stringify(r.warnings));
  near(-tip(r), delta, 0.05);
});

test("verificação: condição sem faces, material impossível, sem apoios e análise que o solver não faz", async () => {
  const { face } = await beam(10);
  const ok = base({ loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -100] }] });
  assert.equal(countLevel(checkStudy(ok), "erro"), 0);
  assert.equal(countLevel(checkStudy(ok), "aviso"), 0);
  // sem faces
  const noFaces = checkStudy({ ...ok, loads: [{ kind: "fixed", faces: [] }, ok.loads[1]] });
  assert.ok(noFaces.some((i) => i.level === "erro" && i.where === "conditions" && /sem faces/.test(i.text)));
  // ... mas um conjunto resolve-a
  assert.equal(countLevel(checkStudy({ ...ok, sets: [{ id: "g1", name: "A", faces: [face(0, 0)] }], loads: [{ kind: "fixed", faces: [], sets: ["g1"] }, ok.loads[1]] }), "erro"), 0);
  // material
  assert.ok(checkStudy({ ...ok, material: { ...ok.material, E: 0 } }).some((i) => i.where === "material" && i.level === "erro"));
  assert.ok(checkStudy({ ...ok, material: { ...ok.material, nu: 0.5 } }).some((i) => i.where === "material" && /Poisson/.test(i.text)));
  // sem apoios: aviso (não bloqueia); modal sem apoios: info
  const free = checkStudy({ ...ok, loads: [ok.loads[1]] });
  assert.ok(free.some((i) => i.level === "aviso" && /Sem apoios/.test(i.text)));
  assert.ok(checkStudy({ ...ok, analysis: "modal", loads: [] }).some((i) => i.level === "info" && /Modal sem apoios/.test(i.text)));
  // térmica com condições estruturais
  assert.ok(checkStudy({ ...ok, analysis: "thermal" }).some((i) => i.level === "erro" && /térmico/.test(i.text)));
  // OpenRadioss só faz dinâmica explícita com elementos lineares
  const rad = checkStudy({ ...ok, solver: "openradioss" }).filter((i) => i.level === "erro").map((i) => i.text);
  assert.ok(rad.some((t) => /Estática linear: não suportado/.test(t)) && rad.some((t) => /ordem 1/.test(t)));
  // code_aster não faz encurvadura nem térmica
  assert.ok(checkStudy({ ...ok, solver: "code_aster", analysis: "buckling" }).some((i) => /Encurvadura linear: não suportado/.test(i.text)));
  // encurvadura sem carga de referência
  assert.ok(checkStudy({ ...ok, analysis: "buckling", loads: [ok.loads[0]] }).some((i) => i.level === "erro" && /carga de referência/.test(i.text)));
});

test("compatibilidade por solver: veredito, características usadas e consistência da matriz", async () => {
  const { face } = await beam(10);
  const s = base({ mesh: { size: 5, order: 2, curvature: 0 }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -100] }] });
  assert.deepEqual(usedFeatures(s).sort(), ["Encastramento", "Estática linear", "Força nas faces", "Tetraedros quadráticos (10 nós)"].sort());
  assert.equal(solverVerdict(s, "calculix").support, "sim");
  assert.equal(solverVerdict(s, "code_aster").support, "sim");
  assert.equal(solverVerdict(s, "openradioss").support, "nao");
  // dinâmica explícita com hexaedros lineares: o OpenRadioss é o indicado; o code_aster é parcial
  const dyn = base({ analysis: "dynamic", dynamic: { scheme: "explicit", duration: 1e-3, load: "step" }, mesh: { size: 5, order: 1, curvature: 0, element: "hex" }, loads: s.loads });
  assert.equal(solverVerdict(dyn, "openradioss").support, "sim");
  assert.equal(solverVerdict(dyn, "code_aster").support, "parcial");
  // atrito só no CalculiX
  const fr = base({ contact: { mode: "friction" }, loads: s.loads });
  assert.deepEqual(["calculix", "code_aster", "openradioss"].map((x) => solverVerdict(fr, x as FemStudy["solver"]).support), ["sim", "nao", "nao"]);
  // toda a característica usada tem linha na matriz
  for (const f of [...usedFeatures(s), ...usedFeatures(dyn), ...usedFeatures(fr)]) assert.ok(CAPABILITIES.some((c) => c.feature === f), f);
  // o que o CalculiX não faz não existe na matriz (referência do que está verificado)
  assert.ok(CAPABILITIES.every((c) => c.calculix === "sim"));
});

test("verificação CFD: entrada e saída por definir, velocidade nula", () => {
  const c = newCfdStudy("c1", 1);
  const items = checkStudy(c);
  assert.ok(items.some((i) => /faces de entrada/.test(i.text)) && items.some((i) => /faces de saída/.test(i.text)));
  assert.ok(checkStudy({ ...c, regime: "external", freestream: { velocity: [0, 0, 0] } }).some((i) => /escoamento livre nula/.test(i.text)));
  assert.equal(countLevel(checkStudy({ ...c, regime: "external" }), "erro"), 0);
});

test("força pontual: o nó mais próximo recebe a força; a flecha a meio vão segue Timoshenko (CalculiX e code_aster)", { skip: !(hasFem || hasAster) && "Gmsh/solvers não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await beam(10);
  const x = 50;
  const mid = (100 * x * x * (3 * L - x)) / (6 * E * I) + (100 * x) / ((5 / 6) * G * A);
  const study = (solver: FemStudy["solver"]): FemStudy => base({
    solver, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "pointForce", point: [100, 5, 10], f: [0, 0, -100] }],
    probes: [{ name: "Meio", quantity: "uz", at: { kind: "point", point: [x, 5, 5] } }],
  });
  const { c } = await solve(doc, study("calculix"));
  assert.deepEqual(c.loads.find((l) => l.kind === "pointForce"), { kind: "pointForce", point: [100, 5, 10], f: [0, 0, -100] });
  for (const [name, ok, solver] of [["CalculiX", hasFem, "calculix"], ["code_aster", hasAster, "code_aster"]] as const) {
    if (!ok) continue;
    const r = await (await solve(doc, study(solver))).run();
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.warnings)}`);
    assert.ok(r.warnings.some((w) => /Força pontual aplicada no nó/.test(w)), name);
    near(-tip(r), mid, 0.03);
    // reação = força (só CalculiX devolve as reações totais no resumo)
    if (solver === "calculix") assert.ok(r.summary.some(([k, v]) => /Reações/.test(k) && /100\.00/.test(v)), JSON.stringify(r.summary));
  }
  // o OpenRadioss recusa-a com mensagem clara
  const rad = base({ solver: "openradioss", analysis: "dynamic", dynamic: { scheme: "explicit", duration: 1e-3, load: "step" }, mesh: { size: 5, order: 1, curvature: 0, element: "hex", integration: "reduced" }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "pointForce", point: [100, 5, 10], f: [0, 0, -100] }] });
  assert.ok(checkStudy(rad).some((i) => /Força pontual \(nó mais próximo\): não suportado/.test(i.text)));
});
