// Malha ao vivo: chave das definições da malha e agendamento com debounce (só quando a chave muda).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newFemStudy } from "../src/doc/study.ts";
import { liveMeshKey, liveMeshScheduler } from "../src/app/live-mesh.ts";

test("a chave só existe com a opção ligada, o agente e uma seed em edição", () => {
  const s = newFemStudy("s1", 1);
  assert.ok(liveMeshKey(true, "tok", true, s.id, s.mesh));
  assert.equal(liveMeshKey(false, "tok", true, s.id, s.mesh), null);
  assert.equal(liveMeshKey(true, "", true, s.id, s.mesh), null);
  assert.equal(liveMeshKey(true, "tok", false, s.id, s.mesh), null);
  assert.notEqual(liveMeshKey(true, "tok", true, s.id, s.mesh), liveMeshKey(true, "tok", true, s.id, { ...s.mesh, size: 3 }));
});

test("o agendamento junta alterações seguidas e ignora a mesma chave", async () => {
  let n = 0;
  const go = liveMeshScheduler(() => n++, 20);
  go("a"); go("b"); go("c");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, 1);
  go("c");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, 1);
  go("d"); go(null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, 1);
});
