// Edição de nós/elementos da malha: mover nós (com recusa de inversões), apagar elementos e limpar
// as faces de fronteira que deixam de o ser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMeshEdits } from "../src/sim/mshedit.ts";
import type { Msh } from "../src/sim/msh.ts";

// dois hexaedros lado a lado em X (0–1 e 1–2), com as faces X=0 e X=2 como fronteira (quads)
function twoHex(): Msh {
  const nodes = new Map<number, [number, number, number]>();
  const t = (i: number, j: number, k: number) => 1 + i + 3 * j + 6 * k;
  for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) nodes.set(t(i, j, k), [i, j, k]);
  const hex = (i: number) => [t(i, 0, 0), t(i + 1, 0, 0), t(i + 1, 1, 0), t(i, 1, 0), t(i, 0, 1), t(i + 1, 0, 1), t(i + 1, 1, 1), t(i, 1, 1)];
  return {
    nodes,
    blocks: [
      { dim: 3, entity: 1, type: 5, conn: [...hex(0), ...hex(1)], tags: [1, 2] },
      { dim: 2, entity: 1, type: 3, conn: [t(0, 0, 0), t(0, 1, 0), t(0, 1, 1), t(0, 0, 1)], tags: [3] },
      { dim: 2, entity: 2, type: 3, conn: [t(2, 0, 0), t(2, 1, 0), t(2, 1, 1), t(2, 0, 1)], tags: [4] },
    ],
    physicals: new Map(), entityPhysicals: new Map(), entityBox: new Map(),
  } as Msh;
}

test("sem edições devolve a mesma malha", () => {
  const m = twoHex();
  assert.equal(applyMeshEdits(m, []).msh, m);
});

test("mover um nó: muda só a cópia", () => {
  const m = twoHex();
  const r = applyMeshEdits(m, [{ kind: "move", at: [2.01, 0, 0], to: [2.2, 0, 0] }]);
  assert.deepEqual(r.msh.nodes.get(3), [2.2, 0, 0]);
  assert.deepEqual(m.nodes.get(3), [2, 0, 0]);
  assert.match(r.notes[0], /nó 3 movido/);
});

test("mover recusa inversões e pontos longe da malha", () => {
  assert.throws(() => applyMeshEdits(twoHex(), [{ kind: "move", at: [1, 0, 0], to: [3, 0, 0] }]), /inverte ou degenera/);
  assert.throws(() => applyMeshEdits(twoHex(), [{ kind: "move", at: [10, 10, 10], to: [0, 0, 0] }]), /não há nenhum nó/);
});

test("apagar um elemento limpa a fronteira órfã e os nós soltos", () => {
  const r = applyMeshEdits(twoHex(), [{ kind: "delete", at: [1.5, 0.5, 0.5] }]);
  const solid = r.msh.blocks.filter((b) => b.dim === 3);
  assert.deepEqual(solid.map((b) => b.tags), [[1]]);
  const faces = r.msh.blocks.filter((b) => b.dim === 2);
  assert.deepEqual(faces.map((b) => b.tags), [[3]]);
  assert.equal(r.msh.nodes.size, 8);
  assert.ok(![...r.msh.nodes.values()].some((p) => p[0] === 2));
  assert.ok(r.notes.some((n) => /1 elemento\(s\) de fronteira/.test(n)));
});

test("apagar por raio e recusas", () => {
  const r = applyMeshEdits(twoHex(), [{ kind: "delete", at: [0.5, 0.5, 0.5], radius: 0.6 }]);
  assert.deepEqual(r.msh.blocks.filter((b) => b.dim === 3).map((b) => b.tags), [[2]]);
  assert.throws(() => applyMeshEdits(twoHex(), [{ kind: "delete", at: [1, 0.5, 0.5], radius: 5 }]), /todos os elementos/);
  assert.throws(() => applyMeshEdits(twoHex(), [{ kind: "delete", at: [9, 9, 9] }]), /não há nenhum elemento/);
});

test("casca: mover para um ponto colinear degenera o triângulo", () => {
  const m = {
    nodes: new Map<number, [number, number, number]>([[1, [0, 0, 0]], [2, [1, 0, 0]], [3, [0, 1, 0]], [4, [1, 1, 0]]]),
    blocks: [{ dim: 2, entity: 1, type: 2, conn: [1, 2, 3, 2, 4, 3], tags: [1, 2] }],
    physicals: new Map(), entityPhysicals: new Map(), entityBox: new Map(),
  } as Msh;
  assert.throws(() => applyMeshEdits(m, [{ kind: "move", at: [0, 1, 0], to: [2, 0, 0] }]), /degenera/);
  const r = applyMeshEdits(m, [{ kind: "move", at: [1, 1, 0], to: [1.2, 1.1, 0] }]);
  assert.deepEqual(r.msh.nodes.get(4), [1.2, 1.1, 0]);
});
