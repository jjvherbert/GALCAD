// C9c: limites configuráveis estimados pelo histograma e mapa de tamanho pretendido vs obtido por aresta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failFromHist } from "../src/sim/quality.ts";
import { sizeMap } from "../src/sim/mesh-advice.ts";
import type { SeedPreview } from "../src/kernel/sim-fem.ts";

const hist = { edges: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], counts: [1, 0, 2, 0, 0, 3, 0, 0, 4, 10] };

test("failFromHist: mínimo e máximo contam os intervalos do lado errado", () => {
  assert.equal(failFromHist(hist, { min: 0.3 }), 3);
  assert.equal(failFromHist(hist, { min: 0.6 }), 6);
  assert.equal(failFromHist(hist, { max: 0.8 }), 14);
  assert.equal(failFromHist(hist, {}), 0);
});

test("sizeMap: comprimento / n.º de elementos e razão para o alvo", () => {
  const p = { edges: [
    { tag: 1, kind: "auto", n: 4, points: [0, 0, 0, 5, 0, 0, 10, 0, 0] },
    { tag: 2, kind: "user", n: 2, points: [0, 0, 0, 0, 3, 4] },
    { tag: 3, kind: "auto", n: 0, points: [0, 0, 0, 1, 0, 0] },
  ] } as unknown as SeedPreview;
  const r = sizeMap(p, 2.5);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => [x.tag, x.length, x.h, x.ratio]), [[1, 10, 2.5, 1], [2, 5, 2.5, 1]]);
  assert.ok(Number.isNaN(sizeMap(p, 0)[0].ratio));
});
