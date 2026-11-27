// Rótulos e resumo das partições na árvore do estudo (C8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionLabel, partitionSummary } from "../src/app/partition-label.ts";
import type { SimMesh } from "../src/doc/study.ts";

const doc = { features: [{ id: "f3", name: "Plano1" }, { id: "f4", name: "Esboço2" }] } as never;

test("partitionLabel: um rótulo curto por tipo de ferramenta", () => {
  assert.equal(partitionLabel({ axis: "x", at: 50 }, doc), "X = 50");
  assert.equal(partitionLabel({ axis: "z", at: "L/2" }, doc), "Z = L/2");
  assert.equal(partitionLabel({ axis: "n", at: 0.1 + 0.2 }, doc), "n·x = 0.3");
  assert.equal(partitionLabel({ axis: "plane", at: 0 }, doc), "Plano XY");
  assert.equal(partitionLabel({ axis: "plane", at: 0, plane: { kind: "std", name: "YZ" } }, doc), "Plano YZ");
  assert.equal(partitionLabel({ axis: "plane", at: 0, plane: { kind: "datum", feature: "f3" } }, doc), "Plano Plano1");
  assert.equal(partitionLabel({ axis: "plane", at: 0, plane: { kind: "datum", feature: "zz" } }, doc), "Plano de referência");
  assert.equal(partitionLabel({ axis: "sketch", at: 0, sketch: "f4" }, doc), "Esboço Esboço2");
  assert.equal(partitionLabel({ axis: "sketch", at: 0, sketch: "" }, doc), "Esboço (por escolher)");
  assert.equal(partitionLabel({ axis: "cyl", at: 5 }, doc), "Cilindro R 5");
  assert.equal(partitionLabel({ axis: "f", at: 0 }, doc), "Plano de uma face");
});

test("partitionSummary: conta as partições e as suprimidas", () => {
  const m = (partitions: SimMesh["partitions"]) => ({ size: 5, order: 1, partitions }) as SimMesh;
  assert.equal(partitionSummary(m(undefined)), "");
  assert.equal(partitionSummary(m([{ axis: "x", at: 1 }])), "1 partição");
  assert.equal(partitionSummary(m([{ axis: "x", at: 1, suppressed: true }, { axis: "y", at: 1 }])), "2 partições (1 suprimida)");
  assert.equal(partitionSummary(m([{ axis: "x", at: 1, suppressed: true }, { axis: "y", at: 1, suppressed: true }])), "2 partições (2 suprimidas)");
});
