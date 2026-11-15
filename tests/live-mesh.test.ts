// Malha ao vivo: chave das definições da malha e agendamento com debounce (só quando a chave muda).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newFemStudy } from "../src/doc/study.ts";
import { liveMeshKey, liveMeshScheduler } from "../src/app/live-mesh.ts";

test("a chave só existe com a opção ligada, o agente e um estudo FEM", () => {
  const s = newFemStudy("s1", 1);
  assert.ok(liveMeshKey(true, "tok", s.id, s.mesh));
  assert.equal(liveMeshKey(false, "tok", s.id, s.mesh), null);
  assert.equal(liveMeshKey(true, "", s.id, s.mesh), null);
  assert.equal(liveMeshKey(true, "tok", undefined, undefined), null);
  assert.notEqual(liveMeshKey(true, "tok", s.id, s.mesh), liveMeshKey(true, "tok", s.id, { ...s.mesh, size: 3 }));
});

test("partições e edições de nós/elementos também mudam a chave (regeneram a malha ao vivo)", () => {
  const s = newFemStudy("s1", 1), k = liveMeshKey(true, "tok", s.id, s.mesh);
  const part = { ...s.mesh, partitions: [{ axis: "x" as const, at: 10 }] };
  const moved = { ...s.mesh, edits: [{ kind: "move" as const, at: [0, 0, 0] as [number, number, number], to: [0, 0, 1] as [number, number, number] }] };
  assert.notEqual(liveMeshKey(true, "tok", s.id, part), k);
  assert.notEqual(liveMeshKey(true, "tok", s.id, moved), k);
  assert.notEqual(liveMeshKey(true, "tok", s.id, { ...part, partitions: [{ axis: "x" as const, at: 20 }] }), liveMeshKey(true, "tok", s.id, part));
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
