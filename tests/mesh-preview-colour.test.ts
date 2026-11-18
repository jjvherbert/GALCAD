// Pré-visualização da malha: faces azul-claro com as arestas dos elementos; a qualidade só colore a pedido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { colourField, isMeshPreview, type ResultView } from "../src/sim/result.ts";

const layer = { name: "Malha", visible: true, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2], values: [[1, 1, 1], [1, 1, 1]] };
const mesh: ResultView = { fields: [{ name: "Jacobiano escalado", unit: "-" }, { name: "Razão de aspeto", unit: "-" }], modes: [], layers: [{ ...layer, edges: [0, 1, 1, 2, 2, 0] }] } as unknown as ResultView;
const result: ResultView = { fields: [{ name: "von Mises", unit: "MPa" }], modes: ["U"], layers: [layer] } as unknown as ResultView;

test("só a malha com arestas e sem deformadas é pré-visualização", () => {
  assert.equal(isMeshPreview(mesh), true);
  assert.equal(isMeshPreview(result), false);
  assert.equal(isMeshPreview({ ...mesh, layers: [layer] } as unknown as ResultView), false);
});

test("a malha não é colorida por omissão; «Colorir pela qualidade» liga o campo", () => {
  assert.equal(colourField(mesh, { field: 1 }), null);
  assert.equal(colourField(mesh, { field: 1, quality: true }), 1);
  assert.equal(colourField(result, { field: 0 }), 0, "os resultados continuam coloridos pelo campo");
});
