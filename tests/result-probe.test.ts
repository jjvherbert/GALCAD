// Sonda dos resultados: valores interpolados no ponto mais próximo das camadas visíveis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeResult, type ResultView } from "../src/sim/result.ts";

const view = (): ResultView => ({
  fields: [{ name: "U", unit: "mm" }, { name: "σ", unit: "MPa" }],
  modes: ["Estático"],
  layers: [
    { name: "Placa", visible: true, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], triangles: [0, 1, 2], values: [[0, 2, 4], null], displacements: [[0, 0, 0, 0, 0, 2, 0, 0, 4]] },
    { name: "Longe", visible: true, positions: [100, 0, 0, 101, 0, 0, 100, 1, 0], triangles: [0, 1, 2], values: [[9, 9, 9], [5, 5, 5]] },
  ],
} as unknown as ResultView);

test("sonda interpola linearmente no triângulo e mede a distância", () => {
  const p = probeResult(view(), [0.5, 0.5, 1])!;
  assert.equal(p.layer, "Placa");
  assert.deepEqual(p.point.map((x) => +x.toFixed(9)), [0.5, 0.5, 0]);
  assert.ok(Math.abs(p.distance - 1) < 1e-12);
  assert.ok(Math.abs(p.values[0]! - 1.5) < 1e-12);
  assert.equal(p.values[1], null);
  assert.ok(Math.abs(p.disp![2] - 1.5) < 1e-12);
});

test("sonda fora do triângulo agarra-se à aresta e ignora camadas escondidas", () => {
  const p = probeResult(view(), [3, -1, 0])!;
  assert.deepEqual(p.point, [2, 0, 0]);
  assert.equal(p.values[0], 2);
  const q = probeResult(view(), [99, 0, 0], ["Longe"])!;
  assert.equal(q.layer, "Placa");
  assert.equal(probeResult(view(), [0, 0, 0], ["Placa", "Longe"]), null);
});
