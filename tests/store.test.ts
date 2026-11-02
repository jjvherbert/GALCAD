// Resultados de simulação/desenho por documento (A3) e regresso ao último modelo ao sair do Desenho.
// O store é um singleton com efeitos no import (worker, localStorage, tema): simulam-se os globais do
// navegador antes de o importar e anula-se a reconstrução (o núcleo não corre em node).
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
});
g.document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {} } };
g.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
g.Worker = class { onmessage = null; onerror = null; postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };

const { store, shallowEqual } = await import("../src/app/store.ts");
const { setWorkspace } = await import("../src/app/workspaces.ts");
clearTimeout((store as unknown as { timer: ReturnType<typeof setTimeout> }).timer);
store.rebuild = () => Promise.resolve();

type SimResult = NonNullable<typeof store.state.simResult>;
const sim = (doc: string) => ({ doc, studyId: "s1", result: {} }) as unknown as SimResult;
const drawing = (tag: string) => ({ tag }) as unknown as NonNullable<typeof store.state.drawingResult>;

function fresh() {
  store.newDoc();
  store.set({ workspace: "design", error: null });
}

test("o resultado de simulação sobrevive a trocar de documento e voltar", () => {
  fresh();
  const p1 = store.state.active.id;
  store.addDocument("part");
  const p2 = store.state.active.id;
  assert.equal(store.state.simResult, null);
  store.set({ simResult: sim(p2) });
  store.setActive({ kind: "part", id: p1 });
  assert.equal(store.state.simResult, null);
  store.setActive({ kind: "part", id: p2 });
  assert.equal((store.state.simResult as SimResult | null)?.doc, p2);
  // limpar o resultado só apaga o do documento ativo
  store.set({ simResult: null });
  store.setActive({ kind: "part", id: p1 });
  store.setActive({ kind: "part", id: p2 });
  assert.equal(store.state.simResult, null);
});

test("os resultados de desenho são por desenho e não passam para peças", () => {
  fresh();
  store.addDocument("drawing");
  const d1 = store.state.active.id;
  store.set({ drawingResult: drawing("a") });
  store.addDocument("drawing");
  const d2 = store.state.active.id;
  assert.equal(store.state.drawingResult, null);
  store.set({ drawingResult: drawing("b") });
  store.setActive({ kind: "drawing", id: d1 });
  assert.equal((store.state.drawingResult as unknown as { tag: string }).tag, "a");
  store.setActive({ kind: "part", id: store.state.project.parts[0].id });
  assert.equal(store.state.drawingResult, null);
  store.setActive({ kind: "drawing", id: d2 });
  assert.equal((store.state.drawingResult as unknown as { tag: string }).tag, "b");
});

test("apagar um documento descarta os resultados dele e o último modelo", () => {
  fresh();
  store.addDocument("part");
  const p2 = store.state.active.id;
  store.set({ simResult: sim(p2) });
  assert.equal(store.lastModelDoc?.id, p2);
  store.deleteDocument({ kind: "part", id: p2 });
  assert.notEqual(store.lastModelDoc?.id, p2);
  assert.ok(!store.state.project.parts.some((d) => d.id === p2));
  assert.ok(!(store as unknown as { simResults: Map<string, unknown> }).simResults.has(p2));
});

test("novo projeto limpa resultados e último modelo", () => {
  fresh();
  const p1 = store.state.active.id;
  store.set({ simResult: sim(p1) });
  store.newDoc();
  assert.equal(store.lastModelDoc, null);
  assert.equal(store.state.simResult, null);
});

test("sair do Desenho volta à última montagem aberta", () => {
  fresh();
  store.addDocument("assembly");
  const a = store.state.active.id;
  setWorkspace("drawing");
  assert.equal(store.state.active.kind, "drawing");
  setWorkspace("design");
  assert.deepEqual({ ...store.state.active }, { kind: "assembly", id: a });
  assert.equal(store.state.workspace, "design");
});

test("sair do Desenho cai na primeira peça se o último modelo foi apagado", () => {
  fresh();
  const p1 = store.state.active.id;
  store.addDocument("part");
  const p2 = store.state.active.id;
  setWorkspace("drawing");
  store.lastModelDoc = { kind: "part", id: "apagado" };
  setWorkspace("fem");
  assert.deepEqual({ ...store.state.active }, { kind: "part", id: p1 });
  assert.notEqual(p1, p2);
});

test("a CFD a partir de uma montagem vai para uma peça", () => {
  fresh();
  const p1 = store.state.active.id;
  store.addDocument("assembly");
  setWorkspace("cfd");
  assert.deepEqual({ ...store.state.active }, { kind: "part", id: p1 });
  assert.equal(store.state.workspace, "cfd");
});

test("shallowEqual compara objetos e arrays um nível", () => {
  const x = { n: 1 };
  assert.ok(shallowEqual({ a: 1, b: x }, { a: 1, b: x }));
  assert.ok(!shallowEqual({ a: 1, b: x }, { a: 1, b: { n: 1 } }));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(shallowEqual([1, x], [1, x]));
  assert.ok(!shallowEqual([1], [1, 2]));
  assert.ok(shallowEqual(3, 3));
  assert.ok(!shallowEqual(null, {}));
});
