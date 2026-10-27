// Scripts de automação: API cad.*, plano fatorial, superfície de resposta e, com o núcleo e os
// solvers reais, um varrimento paramétrico de uma consola comparado com a teoria.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { type ScriptHost, grid, linspace, runScript, solveDense, surrogate, tableCSV } from "../src/script/api.ts";
import { newDocument, addFeature } from "../src/doc/io.ts";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { type CadProject, newPart, newProject } from "../src/doc/project.ts";
import { SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { nodeHost } from "../tools/cad-script.ts";
import { tools } from "../tools/cad-runner.ts";

const mock: ScriptHost = {
  rebuild: async (doc) => ({ ok: true, errors: [], measures: { volume: Number(doc.variables.find((v) => v.name === "L")?.expr ?? 0) * 100 }, variables: {}, checks: [], pmi: [] }),
  simulate: async () => ({ solver: "mock", metrics: { umax: 1 }, summary: [], warnings: [], cells: 1, seconds: 0 }),
};

test("scripts: plano fatorial, linspace, CSV e sistema linear", () => {
  assert.equal(grid({ L: [80, 100, 120], t: [2, 3] }).length, 6);
  assert.deepEqual(grid({ a: [1], b: ["x", "y"] }), [{ a: 1, b: "x" }, { a: 1, b: "y" }]);
  assert.throws(() => grid({ a: [] }), /sem valores/);
  assert.deepEqual(linspace(0, 1, 5), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(tableCSV([{ L: 80, nota: "a;b" }, { L: 100 }]), "﻿L;nota\n80;\"a;b\"\n100;\n");
  assert.deepEqual(solveDense([[2, 1], [1, 3]], [3, 5]).map((x) => +x.toFixed(12)), [0.8, 1.4]);
});

test("superfície de resposta RBF: exata nos pontos, erro pequeno fora deles, validação cruzada", () => {
  const f = (x: number, y: number) => x * x + 0.5 * y + Math.sin(x);
  const rows: Record<string, number>[] = grid({ x: linspace(0, 2, 6), y: linspace(0, 1, 5) }).map((r) => ({ x: Number(r.x), y: Number(r.y), z: f(Number(r.x), Number(r.y)) }));
  const s = surrogate(rows, ["x", "y"], "z");
  for (const r of rows) assert.ok(Math.abs(s.predict({ x: Number(r.x), y: Number(r.y) }) - Number(r.z)) < 1e-6);
  assert.ok(Math.abs(s.predict({ x: 1.1, y: 0.33 }) - f(1.1, 0.33)) < 0.02, String(s.predict({ x: 1.1, y: 0.33 }) - f(1.1, 0.33)));
  assert.ok(s.looRmse > 0 && s.looRelative < 0.05, `${s.looRmse} (${s.looRelative})`);
  assert.throws(() => surrogate(rows.slice(0, 2), ["x", "y"], "z"), /pelo menos/);
});

test("motor de scripts: cópia do documento, variáveis, tabelas, erros e tempo limite", async () => {
  const doc = newDocument();
  const ok = await runScript(`
    const rows = [];
    for (const L of [10, 20]) { cad.set("L", L); const r = await cad.rebuild(); rows.push({ L, volume: r.measures.volume }); }
    cad.table(rows, "Varrimento");
    cad.log("feito", rows.length);
    return rows.at(-1).volume;`, doc, mock);
  assert.ok(ok.ok, ok.error ?? "");
  assert.equal(ok.value, 2000);
  assert.deepEqual(ok.tables[0].rows, [{ L: 10, volume: 1000 }, { L: 20, volume: 2000 }]);
  assert.deepEqual(ok.logs, ["feito 2"]);
  assert.ok(ok.changed);
  assert.equal(doc.variables.length, 0, "o documento original não muda");
  const bad = await runScript(`cad.update("f9", { x: 1 })`, doc, mock);
  assert.match(bad.error!, /Feature inexistente: f9/);
  assert.match((await runScript(`cad.set("2x", 1)`, doc, mock)).error!, /inválido/);
  assert.match((await runScript(`await cad.simulate("s1")`, doc, mock)).error!, /Estudo inexistente/);
  assert.match((await runScript(`return {}.x.y`, doc, mock)).error!, /TypeError/);
  assert.match((await runScript(`await new Promise((r) => setTimeout(r, 500))`, doc, mock, { timeoutMs: 50 })).error!, /Tempo esgotado/);
  assert.equal((await runScript(`return 1`, doc, mock)).changed, false);
});

// --- com o núcleo e o CalculiX -------------------------------------------------------------------
before(initKernel);
const T = tools();

/** Projeto com uma consola de comprimento L (variável), 10 × 10 mm, e um estudo estático. */
function project(): CadProject {
  const pr: CadProject = { ...newProject("Script"), parts: [] };
  const s = new SketchBuilder();
  s.rect(0, 0, "L", 10, 100, 10);
  let p = newPart(pr, "Consola");
  p = { ...p, variables: [{ name: "L", expr: "100" }] };
  p = { ...p, ...addFeature(p, s.build()).doc };
  p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc };
  p.studies = [{ ...newFemStudy("s1", 1), name: "Consola", material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 2, curvature: 0 },
    loads: [{ kind: "fixed", faces: [{ kind: "face", name: "f2:side:l8" }] }, { kind: "force", faces: [{ kind: "face", name: "f2:side:l6" }], f: [0, 0, -100] }],
    probes: [{ name: "Flecha na ponta", quantity: "uz", at: { kind: "faces", faces: [{ kind: "face", name: "f2:side:l6" }] } }] }];
  pr.parts.push(p);
  return pr;
}

test("scripts com o núcleo: varrimento de L reconstrói o modelo (volume = 100·L)", async () => {
  const pr = project();
  const out = await runScript(`
    const rows = [];
    for (const L of cad.linspace(60, 140, 5)) { cad.set("L", L); const r = await cad.rebuild(); rows.push({ L, volume: r.measures.volume, ok: r.ok }); }
    return rows;`, pr.parts[0], nodeHost(pr, pr.parts[0].id));
  assert.ok(out.ok, out.error ?? "");
  for (const r of out.value as { L: number; volume: number; ok: boolean }[]) { assert.ok(r.ok); assert.ok(Math.abs(r.volume - 100 * r.L) < 1e-6); }
});

test("simulação automática: varrimento de L no CalculiX contra Timoshenko (δ ∝ L³)", { skip: !(T.gmsh && T.calculix) && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const pr = project();
  const out = await runScript(`
    const rows = [];
    for (const L of [80, 100, 120]) {
      cad.set("L", L);
      const r = await cad.rebuild();
      const s = await cad.simulate("s1");
      rows.push({ L, flecha: -s.metrics.probe1, massa: r.measures.massa });
    }
    cad.table(rows, "Consola");
    const m = cad.surrogate(rows, ["L"], "flecha");
    return { rows, L110: m.predict({ L: 110 }) };`, pr.parts[0], nodeHost(pr, pr.parts[0].id));
  assert.ok(out.ok, out.error ?? "");
  const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, G = E / (2 * (1 + nu));
  const delta = (L: number) => (100 * L ** 3) / (3 * E * I) + (100 * L) / ((5 / 6) * G * A);
  const v = out.value as { rows: { L: number; flecha: number }[]; L110: number };
  for (const r of v.rows) assert.ok(Math.abs(r.flecha - delta(r.L)) < 0.03 * delta(r.L), `L=${r.L}: ${r.flecha} vs ${delta(r.L)}`);
  assert.ok(Math.abs(v.L110 - delta(110)) < 0.05 * delta(110), `superfície de resposta L=110: ${v.L110} vs ${delta(110)}`);
  assert.equal(out.tables[0].rows.length, 3);
});
