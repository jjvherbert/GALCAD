// Fase 4.4: knowledgeware — expressões lógicas, regras, verificações, tabela de configurações
// (peça e componentes de montagem, BOM) e templates de features (PowerCopy/UDF).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { evalExpr } from "../src/doc/expr.ts";
import { configuredDoc, instantiateTemplate, makeTemplate, resolveWithRules, runChecks, tableFromCSV, tableToCSV } from "../src/doc/knowledge.ts";
import { addFeature, newDocument, type NewFeature } from "../src/doc/io.ts";
import { type CadProject, newAssembly, newPart, newProject } from "../src/doc/project.ts";
import type { CadDocument, Variable } from "../src/doc/types.ts";
import { KernelService } from "../src/kernel/service.ts";
import { computeBom } from "../src/assembly/bom.ts";

before(initKernel);

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const v = (name: string, expr: string): Variable => ({ name, expr });

test("expressões: comparações e lógica", () => {
  const s = (n: string) => ({ L: 120, t: 2 } as Record<string, number>)[n];
  assert.equal(evalExpr("if(L > 100 and t < 3, 5, 3)", s), 5);
  assert.equal(evalExpr("L >= 120 && !(t == 2)", s), 0);
  assert.equal(evalExpr("L < 100 or t != 3", s), 1);
  assert.equal(evalExpr("0.1 + 0.2 == 0.3"), 1);
  assert.equal(evalExpr("2 + 3 > 4"), 1); // aritmética antes da comparação
  assert.equal(evalExpr("clamp(L, 0, 100)", s), 100);
});

test("regras: atribuição propagada, senão, desativada, oscilação", () => {
  const vars = [v("L", "120"), v("t", "L/40"), v("W", "t*2")];
  const r = resolveWithRules(vars, [{ name: "Chapa grossa", condition: "L > 100", assign: [{ variable: "t", expr: "4" }], otherwise: [{ variable: "t", expr: "2" }] }]);
  assert.equal(r.values.get("t"), 4);
  assert.equal(r.values.get("W"), 8);
  assert.deepEqual(r.rules[0], { name: "Chapa grossa", fired: true });
  const r2 = resolveWithRules([v("L", "80"), ...vars.slice(1)], [{ name: "x", condition: "L > 100", assign: [{ variable: "t", expr: "4" }], otherwise: [{ variable: "t", expr: "2" }] }]);
  assert.equal(r2.values.get("W"), 4);
  const off = resolveWithRules(vars, [{ name: "x", assign: [{ variable: "t", expr: "9" }], disabled: true }]);
  assert.equal(off.values.get("t"), 3);
  // regras encadeadas: a segunda vê o valor propagado pela primeira
  const chain = resolveWithRules([v("a", "1"), v("b", "a*10"), v("c", "0")], [
    { name: "r1", assign: [{ variable: "a", expr: "5" }] },
    { name: "r2", condition: "b > 20", assign: [{ variable: "c", expr: "b + 1" }] },
  ]);
  assert.equal(chain.values.get("c"), 51);
  const osc = resolveWithRules([v("a", "1")], [{ name: "osc", condition: "a > 0", assign: [{ variable: "a", expr: "-1" }], otherwise: [{ variable: "a", expr: "1" }] }]);
  assert.match(osc.rules[0].error ?? "", /não estabilizam/);
  const bad = resolveWithRules([v("a", "1")], [{ name: "b", assign: [{ variable: "zz", expr: "1" }] }]);
  assert.match(bad.rules[0].error ?? "", /desconhecida/);
});

test("verificações e tabela de configurações (CSV)", () => {
  const res = runChecks([
    { name: "Massa", expr: "massa < 500", severity: "error" },
    { name: "Folga", expr: "L - 2*t >= 100", severity: "warning" },
    { name: "Erro", expr: "naoexiste > 1", severity: "info" },
  ], (n) => ({ massa: 420, L: 120, t: 10 } as Record<string, number>)[n]);
  assert.deepEqual(res.map((r) => r.ok), [true, true, false]);
  assert.ok(res[2].error);

  let doc: CadDocument = { ...newDocument(), variables: [v("L", "100"), v("H", "20")] };
  const s = new SketchBuilder();
  s.rect(0, 0, "L", 30, 100, 30);
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: "H" } }).doc;
  doc = addFeature(doc, { type: "fillet", refs: [], radius: 1 }).doc;
  doc.configurations = {
    active: "Curta", columns: ["L", "$s:f3", "$p:number"],
    rows: [{ name: "Curta", values: { L: "50", "$s:f3": "S", "$p:number": "GK-100-50" } }, { name: "Longa", values: { L: "200", "$s:f3": "", "$p:number": "GK-100-200" } }],
  };
  const c = configuredDoc(doc as CadDocument & { properties?: { number?: string } });
  assert.equal(c.variables.find((x) => x.name === "L")!.expr, "50");
  assert.equal(c.features[2].suppressed, true);
  assert.equal(c.properties?.number, "GK-100-50");
  const l = configuredDoc(doc, "Longa");
  assert.equal(l.variables[0].expr, "200");
  assert.equal(l.features[2].suppressed, undefined);
  const csv = tableToCSV(doc.configurations);
  assert.match(csv, /^Configuração;L;\$s:f3;\$p:number\r\nCurta;50;S;GK-100-50/);
  assert.deepEqual(tableFromCSV(csv, "Longa"), { ...doc.configurations, active: "Longa" });
  assert.throws(() => tableFromCSV("Configuração;L\nA;1\nA;2"), /repetida/);
});

test("configurações no núcleo: peça ativa, componentes com configuração e BOM", async () => {
  let pr: CadProject = { ...newProject("K"), parts: [] };
  const s = new SketchBuilder();
  s.rect(0, 0, "L", 20, 100, 20);
  let p = { ...newPart(pr, "Barra"), variables: [v("L", "100")], properties: { number: "B", density: 1 } };
  p = { ...p, ...addFeature(p, s.build()).doc };
  p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc };
  p.configurations = { active: "L100", columns: ["L", "$p:number"], rows: [{ name: "L100", values: { L: "100", "$p:number": "B-100" } }, { name: "L50", values: { L: "50", "$p:number": "B-50" } }] };
  p.checks = [{ name: "Comprimento máx.", expr: "dimX <= 80", severity: "warning" }, { name: "Massa", expr: "massa > 1", severity: "error" }];
  p.rules = [{ name: "r", condition: "L < 60", assign: [] }];
  pr.parts.push(p);
  const svc = new KernelService();
  const r = await svc.rebuild(p);
  near(r.mass!.volume, 100 * 20 * 10);
  assert.equal(r.config, "L100");
  assert.deepEqual(r.checks!.map((c) => c.ok), [false, true]);
  assert.deepEqual(r.rules, [{ name: "r", fired: false }]);

  const asm = newAssembly(pr);
  asm.components = [
    { id: "c1", name: "Barra<1>", ref: { kind: "part", id: p.id }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "Barra<2>", ref: { kind: "part", id: p.id }, config: "L50", placement: { t: [0, 50, 0], r: [0, 0, 0] } },
    { id: "c3", name: "Barra<3>", ref: { kind: "part", id: p.id }, config: "L50", placement: { t: [0, 100, 0], r: [0, 0, 0] } },
  ];
  pr = { ...pr, assemblies: [asm] };
  const a = await svc.assembly(pr, asm.id);
  near(a.mass!.volume, 100 * 20 * 10 + 2 * 50 * 20 * 10);
  near(a.partMass[`${p.id}#L50`].volume, 50 * 20 * 10);
  const bom = computeBom(pr, asm.id, "top", Object.fromEntries(Object.entries(a.partMass).map(([k, x]) => [k, x.volume])));
  assert.deepEqual(bom.map((b) => [b.number, b.qty]), [["B-100", 1], ["B-50", 2]]);
  near(bom[1].unitMass!, 10, 1e-9); // 10 cm³ × 1 g/cm³
  const bad = structuredClone(pr);
  bad.assemblies[0].components[1].config = "Inexistente";
  await assert.rejects(svc.assembly(bad, asm.id), /não tem a configuração/);
});

test("templates: furo num bloco reutilizado noutra face, com parâmetros", async () => {
  let doc: CadDocument = { ...newDocument(), variables: [v("D", "8"), v("P", "D*2")] };
  // bloco centrado na origem: o ponto (20, 10) do esboço do furo fica dentro da face de topo e, com o
  // referencial da face de baixo (y invertido), em (20, −10) — dois furos distintos
  const blk = new SketchBuilder();
  blk.rect(-50, -30, 100, 60, 100, 60);
  doc = addFeature(doc, blk.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }).doc;
  // esboço com um ponto no centro da face de topo e furo simples Ø D, profundidade P
  const hs = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  hs.point(20, 10, { fixed: true });
  doc = addFeature(doc, hs.build() as NewFeature).doc;
  doc = addFeature(doc, { type: "hole", sketch: "f3", kind: "simple", diameter: "D", end: { type: "blind", depth: "P" }, tipAngle: 0 }).doc;
  const svc = new KernelService();
  const before = await svc.rebuild(doc);
  near(before.mass!.volume, 100 * 60 * 20 - Math.PI * 16 * 16, 1e-4);

  const tpl = makeTemplate(doc, ["f3", "f4"], "Furo", "t1");
  assert.deepEqual(tpl.inputs.map((i) => [i.kind, i.original]), [["face", "f2:end:l5"]]);
  assert.deepEqual(tpl.parameters.map((x) => x.name).sort(), ["D", "P"]);
  // segunda instância na face de baixo, Ø 10 e profundidade dos parâmetros renomeados
  const { doc: d2, created } = instantiateTemplate(doc, tpl, { in1: "f2:start:l5" }, { D: "10" });
  assert.deepEqual(created, ["f5", "f6"]);
  const hole2 = d2.features.find((f) => f.id === "f6")!;
  assert.equal(hole2.type === "hole" && hole2.sketch, "f5");
  assert.equal(hole2.type === "hole" && hole2.diameter, "D_2");
  assert.deepEqual(d2.variables.map((x) => `${x.name}=${x.expr}`), ["D=8", "P=D*2", "D_2=10", "P_2=D_2*2"]);
  const sk = d2.features.find((f) => f.id === "f5")!;
  assert.equal(sk.type === "sketch" && sk.plane.kind === "face" && sk.plane.ref.name, "f2:start:l5");
  const after = await new KernelService().rebuild(d2);
  assert.deepEqual(Object.values(after.status).filter((s) => s.state === "error"), []);
  near(after.mass!.volume, 100 * 60 * 20 - Math.PI * 16 * 16 - Math.PI * 25 * 20, 1e-4);
  assert.throws(() => instantiateTemplate(doc, tpl, {}), /Falta escolher/);
});
