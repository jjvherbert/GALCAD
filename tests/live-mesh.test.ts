// Malha ao vivo (C9b): chave, agendamento (debounce, nunca duas malhas, sem ciclo de erro), cache e fase do Gmsh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newFemStudy } from "../src/doc/study.ts";
import { type LiveRun, fullCovers, keyDoc, liveMeshKey, liveMeshScheduler, lru, materialsRev, meshPhase, meshStamp } from "../src/app/live-mesh.ts";

const s = newFemStudy("s1", 1);
const base = { on: true, token: "tok", doc: "d1", studyId: s.id, geom: "g1", materials: materialsRev(s), mesh: s.mesh };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a chave só existe com a opção ligada, o agente e um estudo FEM", () => {
  assert.ok(liveMeshKey(base));
  assert.equal(liveMeshKey({ ...base, on: false }), null);
  assert.equal(liveMeshKey({ ...base, token: "" }), null);
  assert.equal(liveMeshKey({ ...base, studyId: undefined, mesh: undefined }), null);
  assert.equal(keyDoc(liveMeshKey(base)!), "d1");
});

test("a chave muda com a malha, a geometria, os materiais e o documento", () => {
  const k = liveMeshKey(base);
  assert.notEqual(liveMeshKey({ ...base, mesh: { ...s.mesh, size: 3 } }), k);
  assert.notEqual(liveMeshKey({ ...base, mesh: { ...s.mesh, partitions: [{ axis: "x", at: 10 }] } }), k);
  assert.notEqual(liveMeshKey({ ...base, mesh: { ...s.mesh, edits: [{ kind: "move", at: [0, 0, 0], to: [0, 0, 1] }] } }), k);
  assert.notEqual(liveMeshKey({ ...base, geom: "g2" }), k);
  assert.notEqual(liveMeshKey({ ...base, doc: "d2" }), k);
  assert.notEqual(liveMeshKey({ ...base, materials: materialsRev({ ...s, bodyMaterials: { b1: { ...s.material, E: 70000 } } }) }), k);
  assert.equal(liveMeshKey({ ...base, mesh: { ...s.mesh } }), k);
});

/** Corrida controlada pelo teste: cada chamada fica pendente até `finish`. */
function harness(o: { blocked?: () => boolean } = {}) {
  const calls: string[] = [], pending: ((r: LiveRun) => void)[] = [];
  let cancels = 0;
  const update = liveMeshScheduler((k) => { calls.push(k); return new Promise<LiveRun>((r) => pending.push(r)); },
    { delay: 10, blocked: o.blocked, cancel: () => { cancels++; } });
  const finish = async (r: LiveRun) => { pending.shift()!(r); await wait(0); };
  return { calls, update, finish, cancels: () => cancels };
}

test("20 alterações seguidas dão uma só malha, com a última chave", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) h.update(`d|s|g|m|${i}`);
  await wait(60);
  assert.deepEqual(h.calls, ["d|s|g|m|19"]);
  await h.finish("ok");
  h.update("d|s|g|m|19");
  await wait(60);
  assert.equal(h.calls.length, 1, "a mesma chave não volta a correr");
});

test("uma alteração durante a malha cancela-a e corre a mais recente no fim", async () => {
  const h = harness();
  h.update("a"); await wait(50);
  h.update("b"); h.update("c"); await wait(50);
  assert.deepEqual(h.calls, ["a"], "nunca duas malhas ao mesmo tempo");
  assert.equal(h.cancels(), 1);
  await h.finish("cancelled");
  assert.deepEqual(h.calls, ["a", "c"]);
  await h.finish("ok");
  await wait(50);
  assert.equal(h.calls.length, 2);
});

test("um erro não entra em ciclo; uma chave nova volta a tentar", async () => {
  const h = harness();
  h.update("a"); await wait(50);
  await h.finish("error");
  h.update("a"); await wait(60);
  assert.deepEqual(h.calls, ["a"]);
  h.update("b"); await wait(50);
  assert.deepEqual(h.calls, ["a", "b"]);
  await h.finish("ok");
  h.update("a"); await wait(50);
  assert.deepEqual(h.calls, ["a", "b", "a"], "voltar a uma chave que falhou antes tenta de novo");
});

test("bloqueado adia; o próximo update com a mesma chave retoma", async () => {
  let busy = true;
  const h = harness({ blocked: () => busy });
  h.update("a"); await wait(50);
  assert.deepEqual(h.calls, []);
  busy = false;
  h.update("a"); await wait(50);
  assert.deepEqual(h.calls, ["a"]);
});

test("null cancela a malha em curso e não corre nada", async () => {
  const h = harness();
  h.update("a"); await wait(50);
  h.update(null);
  assert.equal(h.cancels(), 1);
  await h.finish("cancelled");
  await wait(50);
  assert.deepEqual(h.calls, ["a"]);
  h.update("b"); h.update(null); await wait(50);
  assert.deepEqual(h.calls, ["a"], "null antes do debounce não corre");
});

test("lru: guarda as últimas n e o acesso renova", () => {
  const c = lru<number>(2);
  c.set("a", 1); c.set("b", 2);
  assert.equal(c.get("a"), 1);
  c.set("c", 3);
  assert.equal(c.get("b"), undefined, "b era a menos recente");
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  assert.equal(c.size, 2);
});

test("fase do Gmsh a partir do registo", () => {
  assert.equal(meshPhase(""), null);
  assert.equal(meshPhase("Info    : Reading 'model.step'..."), null);
  const d1 = meshPhase("Info    : Meshing 1D...\nInfo    : [ 50%] Meshing curve 3 (Line)");
  assert.equal(d1?.label, "Malha 1D (arestas)");
  assert.ok(Math.abs(d1!.frac - 0.05) < 1e-9);
  const done1 = meshPhase("Info    : Meshing 1D...\nInfo    : Done meshing 1D (Wall 0.01s, CPU 0s)");
  assert.equal(done1?.label, "Malha 1D (arestas)", "«Done meshing 1D» não salta para a escrita");
  const d3 = meshPhase("Info    : Meshing 2D...\nInfo    : Done meshing 2D\nInfo    : Meshing 3D...\nInfo    : [ 40%] Tetrahedrizing");
  assert.equal(d3?.label, "Malha 3D (volumes)");
  assert.ok(Math.abs(d3!.frac - (0.4 + 0.45 * 0.4)) < 1e-9);
  assert.equal(meshPhase("Info    : Optimizing mesh...")?.label, "A otimizar a malha");
  assert.equal(meshPhase("Info    : Writing 'mesh.inp'...")?.frac, 0.95);
});

test("um cálculo completo com a mesma malha não é trocado pela malha ao vivo", () => {
  const k = liveMeshKey(base)!;
  const full = meshStamp(base);
  assert.ok(fullCovers(k, { doc: "d1", studyId: s.id, full }));
  // só malha (sem carimbo), outro documento, outro estudo ou geometria editada: a malha ao vivo corre
  assert.equal(fullCovers(k, { doc: "d1", studyId: s.id }), false);
  assert.equal(fullCovers(k, { doc: "d2", studyId: s.id, full }), false);
  assert.equal(fullCovers(k, { doc: "d1", studyId: "s2", full }), false);
  assert.equal(fullCovers(liveMeshKey({ ...base, geom: "g2" })!, { doc: "d1", studyId: s.id, full }), false);
  assert.equal(fullCovers(liveMeshKey({ ...base, mesh: { ...s.mesh, size: 3 } })!, { doc: "d1", studyId: s.id, full }), false);
  assert.equal(fullCovers(k, null), false);
});
