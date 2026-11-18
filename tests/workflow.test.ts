// Fluxo de trabalho guiado (C1a): estado dos passos (por fazer / em curso / concluído /
// desatualizado, com a razão), validação por passo, o que pode correr e a escolha do tipo de estudo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type FemLoad, type FemStudy, newFemStudy } from "../src/doc/study.ts";
import type { CadDocument } from "../src/doc/types.ts";
import {
  assemblySnapshot, canRun, diffTypeChange, firstOpenStep, geomRev, isEnabled, markDonePatch, nextStep,
  partSnapshot, stableJson, stepStates, stepsFor, studyTypePatch, touchUser, typeOf, validate,
} from "../src/app/workflow.ts";

const face = (name: string) => ({ kind: "face" as const, name });
const fixed: FemLoad = { kind: "fixed", faces: [face("F1")] };
const force: FemLoad = { kind: "force", faces: [face("F2")], f: [0, 0, -100] };

function doc(features: CadDocument["features"], extra: Partial<CadDocument> = {}): CadDocument {
  return { format: "galcad", version: 1, name: "p", units: "mm", variables: [{ name: "L", expr: "100" }], features, ...extra } as unknown as CadDocument;
}
const box = { id: "f1", name: "Extrusão 1", type: "extrude", sketch: "s1", depth: "L" } as unknown as CadDocument["features"][number];
const hole = { id: "f2", name: "Furo 1", type: "hole", d: 5 } as unknown as CadDocument["features"][number];

const state = (s: FemStudy, g = partSnapshot(doc([box]))) => Object.fromEntries(stepStates(s, g).map((i) => [i.id, i]));
const done = (s: FemStudy, step: Parameters<typeof markDonePatch>[1], g = partSnapshot(doc([box]))): FemStudy => ({ ...s, ...markDonePatch(s, step, g) });

test("impressão estável: a ordem das chaves e os undefined não contam", () => {
  assert.equal(stableJson({ b: 1, a: { d: undefined, c: [1, 2] } }), stableJson({ a: { c: [1, 2] }, b: 1 }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
});

test("passos: interações só nas montagens; o seguinte avança e para no fim", () => {
  assert.ok(!stepsFor(false).includes("interacoes"));
  assert.ok(stepsFor(true).includes("interacoes"));
  assert.equal(nextStep("material", false), "cargas");
  assert.equal(nextStep("material", true), "interacoes");
  assert.equal(nextStep("resultados"), "resultados");
});

test("estado: por fazer → concluído → em curso ao mudar os próprios dados", () => {
  const s0 = newFemStudy("e1", 1);
  assert.equal(state(s0).material.state, "por fazer");
  const s1 = done(s0, "material");
  assert.equal(state(s1).material.state, "concluído");
  const s2: FemStudy = { ...s1, material: { ...s1.material, E: 1000 } } as FemStudy;
  assert.equal(state(s2).material.state, "em curso");
  assert.equal(firstOpenStep(s1, partSnapshot(doc([box]))), "estudo");
});

test("estado: mudar a montante deixa o passo desatualizado, com a razão", () => {
  let s: FemStudy = { ...newFemStudy("e1", 1), loads: [fixed, force] };
  s = done(s, "estudo");
  s = done(s, "cargas");
  assert.equal(state(s).cargas.state, "concluído");
  const s2 = { ...s, analysis: "modal" as const };
  const c = state(s2).cargas;
  assert.equal(c.state, "desatualizado");
  assert.match(c.reason, /passo «Estudo» alterado/);
  // o próprio estudo, com dados novos, está em curso (e não desatualizado)
  assert.equal(state(s2).estudo.state, "em curso");
});

test("estado: geometria alterada, operação adicionada/removida, rollback e variáveis", () => {
  const g1 = partSnapshot(doc([box]));
  const s = done({ ...newFemStudy("e1", 1), loads: [fixed, force] }, "cargas", g1);
  assert.equal(state(s, g1).cargas.state, "concluído");
  // renomear a operação não conta
  assert.equal(state(s, partSnapshot(doc([{ ...box, name: "Outra" }]))).cargas.state, "concluído");
  const edited = state(s, partSnapshot(doc([{ ...box, depth: "2*L" } as unknown as typeof box]))).cargas;
  assert.equal(edited.state, "desatualizado");
  assert.match(edited.reason, /geometria alterada em «Extrusão 1»/);
  assert.match(state(s, partSnapshot(doc([box, hole]))).cargas.reason, /operação adicionada «Furo 1»/);
  assert.match(state(s, partSnapshot(doc([]))).cargas.reason, /operação removida/);
  assert.match(state(s, partSnapshot(doc([box], { variables: [{ name: "L", expr: "200" }] } as Partial<CadDocument>))).cargas.reason, /variáveis alteradas/);
  // a barra de rollback vem primeiro e esconde as operações a seguir
  const rb = state(s, partSnapshot(doc([box, hole], { rollback: 1 } as Partial<CadDocument>))).cargas;
  assert.match(rb.reason, /^barra de rollback movida/);
  assert.doesNotMatch(rb.reason, /Furo/);
  // o material não depende da geometria
  const m = done(s, "material", g1);
  assert.equal(state(m, partSnapshot(doc([box, hole]))).material.state, "concluído");
});

test("montagem: componente movido, ligação removida e peça revista", () => {
  const asm = {
    components: [{ id: "c1", name: "Casco", ref: { kind: "part", id: "p1" }, placement: { t: [0, 0, 0] } }],
    mates: [{ id: "m1", name: "Fixa", kind: "fixed", a: {}, b: {} }],
  } as unknown as Parameters<typeof assemblySnapshot>[0];
  const rev = (r: string) => () => ({ rev: r, name: "Casco.galcad" });
  const g1 = assemblySnapshot(asm, rev("a"));
  let s: FemStudy = { ...newFemStudy("e1", 1), loads: [fixed, force] };
  s = { ...s, ...markDonePatch(s, "interacoes", g1, true) };
  const st = (g: ReturnType<typeof assemblySnapshot>) => stepStates(s, g, true).find((i) => i.id === "interacoes")!;
  assert.equal(st(g1).state, "concluído");
  assert.match(st(assemblySnapshot(asm, rev("b"))).reason, /geometria alterada em «Casco.galcad»/);
  assert.match(st(assemblySnapshot({ ...asm, mates: [] }, rev("a"))).reason, /ligação removida/);
  const moved = { ...asm, components: [{ ...asm.components[0], placement: { t: [10, 0, 0] } }] } as typeof asm;
  assert.match(st(assemblySnapshot(moved, rev("a"))).reason, /geometria alterada em «Casco»/);
  assert.notEqual(geomRev(g1), geomRev(assemblySnapshot(moved, rev("a"))));
});

test("em curso sem carimbo quando o utilizador já mexeu num campo do passo", () => {
  const s = newFemStudy("e1", 1);
  const t = touchUser(s, { mesh: { ...s.mesh, size: 2 } });
  assert.deepEqual(t?.workflow?.user, ["mesh"]);
  assert.equal(state({ ...s, ...t }).malha.state, "em curso");
  assert.equal(touchUser({ ...s, ...t }, { mesh: s.mesh }), undefined, "não repete");
  assert.equal(touchUser(s, { name: "x" } as Partial<FemStudy>), undefined, "o nome não é de nenhum passo");
});

test("validação: sem apoios e sem cargas bloqueiam a estática de uma peça", () => {
  const s = newFemStudy("e1", 1);
  const errs = validate(s, "todos").filter((i) => i.level === "erro").map((i) => i.text);
  assert.ok(errs.some((t) => t.startsWith("Sem apoios")));
  assert.ok(errs.some((t) => t.startsWith("Sem cargas")));
  assert.ok(!canRun(s));
  assert.ok(validate(s, "cargas").every((i) => i.step === "cargas"));
  const ok = { ...s, loads: [fixed, force] };
  assert.ok(canRun(ok), validate(ok, "todos").map((i) => i.text).join(" | "));
  // modal sem apoios continua a poder correr (modos de corpo rígido)
  assert.ok(canRun({ ...s, analysis: "modal" }));
  // dinâmica com velocidade inicial não precisa de cargas
  const dyn: FemStudy = { ...s, analysis: "dynamic", loads: [fixed], dynamic: { scheme: "implicit", duration: 0.01, load: "step", v0: [0, 0, 5] } };
  assert.ok(!validate(dyn, "todos").some((i) => i.level === "erro" && i.text.startsWith("Sem cargas")));
});

test("isEnabled: edição em curso, sem estudo, a correr, erro e resultados", () => {
  const s = { ...newFemStudy("e1", 1), loads: [fixed, force] };
  assert.deepEqual(isEnabled("sim.run", { busy: true, study: s }), { ok: false, reason: "Termine a edição em curso" });
  assert.equal(isEnabled("sim.run", {}).ok, false);
  assert.equal(isEnabled("sim.run", { study: s }).ok, true);
  assert.equal(isEnabled("sim.run", { study: s, running: true }).ok, false);
  const r = isEnabled("sim.run", { study: newFemStudy("e2", 2) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^Sem (apoios|cargas)/);
  assert.equal(isEnabled("sim.results", { study: s }).ok, false);
  assert.equal(isEnabled("sim.results", { study: s, hasResult: true }).ok, true);
  assert.equal(isEnabled("part.extrude", {}).ok, true);
});

test("tipo de estudo: typeOf e o patch de cada tipo", () => {
  const s = { ...newFemStudy("e1", 1), loads: [fixed, force] };
  assert.equal(typeOf(s), "static");
  assert.equal(typeOf({ ...s, nonlinear: { geometry: true } }), "nonlinear");
  assert.equal(typeOf({ ...s, analysis: "dynamic", dynamic: { scheme: "explicit", duration: 1, load: "step" } }), "explicit");
  assert.deepEqual(studyTypePatch(s, "static"), {});
  assert.deepEqual(studyTypePatch(s, "nonlinear"), { nonlinear: { geometry: true } });
  const ex = studyTypePatch(s, "explicit");
  assert.equal(ex.solver, "openradioss");
  assert.equal(ex.dynamic?.scheme, "explicit");
  assert.deepEqual({ order: ex.mesh?.order, element: ex.mesh?.element, integration: ex.mesh?.integration }, { order: 1, element: "hex", integration: "reduced" });
  // voltar do OpenRadioss repõe o CalculiX e a malha quadrática (se o utilizador não mexeu na malha)
  const back = studyTypePatch({ ...s, ...ex } as FemStudy, "static");
  assert.equal(back.solver, "calculix");
  assert.equal(back.mesh?.order, 2);
  assert.equal(back.mesh?.element, undefined);
  // code_aster não faz térmica: passa a CalculiX; as cargas estruturais caem
  const th = studyTypePatch({ ...s, solver: "code_aster" }, "thermal");
  assert.equal(th.solver, "calculix");
  assert.deepEqual(th.loads, []);
  assert.deepEqual(studyTypePatch(s, "fatigue"), {});
});

test("diffTypeChange: lista as mudanças e marca as destrutivas", () => {
  const s = { ...newFemStudy("e1", 1), loads: [fixed, force] };
  const m = diffTypeChange(s, "modal");
  assert.deepEqual(m.changes, ["Análise: estática linear → modal"]);
  assert.equal(m.destructive, false);
  const t = diffTypeChange(s, "thermal");
  assert.ok(t.changes.includes("2 condições removidas (não servem para este tipo)"));
  assert.equal(t.destructive, true);
  const e = diffTypeChange(s, "explicit");
  assert.ok(e.changes.includes("Solver: CalculiX → OpenRadioss"));
  assert.ok(e.changes.includes("Malha: ordem 2 → 1"));
});
