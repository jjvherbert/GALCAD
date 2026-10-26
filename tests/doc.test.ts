import { test } from "node:test";
import assert from "node:assert/strict";
import { evalExpr, ExprError, exprIdentifiers } from "../src/doc/expr.ts";
import { resolveVariables } from "../src/doc/variables.ts";
import { History } from "../src/doc/history.ts";
import { addFeature, newDocument, parseDocument, serialize } from "../src/doc/io.ts";
import { dependents, moveFeature, orderProblems } from "../src/doc/features.ts";

test("expressões: precedência, unidades e funções em graus", () => {
  assert.equal(evalExpr("2 + 3 * 4"), 14);
  assert.equal(evalExpr("-2^2"), -4);
  assert.equal(evalExpr("2^3^2"), 512);
  assert.equal(evalExpr("(1 + 2) * 3"), 9);
  assert.equal(evalExpr("10 cm + 5mm"), 105);
  assert.equal(evalExpr("1 in"), 25.4);
  assert.ok(Math.abs(evalExpr("sin(30)") - 0.5) < 1e-12);
  assert.ok(Math.abs(evalExpr("atan2(1, 1)") - 45) < 1e-12);
  assert.equal(evalExpr("max(1, 7, 3)"), 7);
  assert.equal(evalExpr("if(L > 0, 1, 2)".replace("L > 0", "L"), (n) => (n === "L" ? 5 : undefined)), 1);
  assert.equal(evalExpr("L/2 + pi*0", (n) => (n === "L" ? 40 : undefined)), 20);
  assert.equal(evalExpr(12.5), 12.5);
  assert.deepEqual([...exprIdentifiers("a*b + sin(c) + pi")], ["a", "b", "c"]);
});

test("expressões: erros com posição", () => {
  assert.throws(() => evalExpr("2 +"), ExprError);
  assert.throws(() => evalExpr("foo(2)"), /Função desconhecida/);
  assert.throws(() => evalExpr("x + 1"), /Variável desconhecida "x"/);
  assert.throws(() => evalExpr("1/0"), /não finito/);
  assert.throws(() => evalExpr("sqrt(1, 2)"), /espera 1/);
  try { evalExpr("3 * $"); } catch (e) { assert.equal((e as ExprError).pos, 4); }
});

test("variáveis: dependências, ciclos e nomes inválidos", () => {
  const r = resolveVariables([
    { name: "C", expr: "A + B" },
    { name: "A", expr: "10" },
    { name: "B", expr: "A * 2" },
    { name: "X", expr: "Y + 1" },
    { name: "Y", expr: "X + 1" },
    { name: "Z", expr: "X" },
    { name: "2bad", expr: "1" },
    { name: "Comprimento_útil", expr: "A - 1 mm" },
  ]);
  assert.equal(r.values.get("C"), 30);
  assert.equal(r.values.get("Comprimento_útil"), 9);
  assert.match(r.errors.get("X")!, /circular/);
  assert.match(r.errors.get("Y")!, /circular/);
  assert.match(r.errors.get("Z")!, /tem erro/);
  assert.match(r.errors.get("2bad")!, /inválido/);
});

test("histórico: desfazer, refazer e junção de arrastos", () => {
  const h = new History({ state: 0, label: "início" });
  h.push(1, "a"); h.push(2, "arrastar"); h.push(3, "arrastar", true);
  assert.equal(h.undo(), 1);
  assert.equal(h.redo(), 3);
  h.undo(); h.push(9, "b");
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), 1);
});

test("documento: ids, nomes, ordem e serialização", () => {
  let doc = newDocument();
  const s = addFeature(doc, { type: "sketch", plane: { kind: "std", name: "XY" }, entities: {}, constraints: [] });
  doc = s.doc;
  const e = addFeature(doc, { type: "extrude", sketch: s.id, op: "add", end: { type: "blind", depth: 10 } });
  doc = e.doc;
  const f = addFeature(doc, { type: "fillet", refs: [{ kind: "edge", name: `{${e.id}:side:l1&${e.id}:end}` }], radius: 2 });
  doc = f.doc;
  assert.deepEqual(doc.features.map((x) => x.id), ["f1", "f2", "f3"]);
  assert.deepEqual(doc.features.map((x) => x.name), ["Esboço1", "Extrusão1", "Filete1"]);
  assert.deepEqual(dependents(doc, "f1").sort(), ["f2", "f3"]);
  assert.deepEqual(orderProblems(doc.features), []);
  const bad = moveFeature(doc, "f3", 1);
  assert.ok(Array.isArray(bad) && /depende de "Extrusão1"/.test(bad[0]));
  const back = parseDocument(serialize(doc));
  assert.deepEqual(back, doc);
  assert.throws(() => parseDocument("{}"), /não é um projeto/);
  // inserir com rollback ativo insere na barra
  doc = { ...doc, rollback: 1 };
  const p = addFeature(doc, { type: "plane", base: { kind: "std", name: "XY" }, offset: 5 });
  assert.equal(p.doc.features[1].id, "f4");
  assert.equal(p.doc.rollback, 2);
});
