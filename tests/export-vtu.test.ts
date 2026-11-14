// Exportação .vtu: estrutura VTK XML, campos com unidades, deformadas como vetores e camadas escondidas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toVtu } from "../src/sim/export-vtu.ts";
import type { ResultView } from "../src/sim/result.ts";

const view: ResultView = {
  fields: [{ name: "von Mises", unit: "MPa" }, { name: "p", unit: "" }],
  modes: ["Modo 1"],
  layers: [
    { name: "Peça", visible: true, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], triangles: [0, 1, 2, 1, 3, 2], values: [[1, 2, 3, 4], null], displacements: [[0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]] },
    { name: "Corte <A>", visible: false, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2], values: [[5, 6, 7], [1, 1, 1]] },
  ],
};

test("vtu: pontos, triângulos (tipo 5), offsets e campos com unidade", () => {
  const x = toVtu(view);
  assert.match(x, /^<\?xml version="1.0"\?>\n<VTKFile type="UnstructuredGrid"/);
  assert.equal((x.match(/<Piece /g) ?? []).length, 1);
  assert.match(x, /<Piece NumberOfPoints="4" NumberOfCells="2">/);
  assert.match(x, /Name="connectivity" format="ascii">\n0 1 2 1 3 2\n/);
  assert.match(x, /Name="offsets" format="ascii">\n3 6\n/);
  assert.match(x, /Name="types" format="ascii">\n5 5\n/);
  assert.match(x, /Name="von Mises \(MPa\)" format="ascii">\n1 2 3 4\n/);
  assert.match(x, /Name="p" format="ascii">\nNaN NaN NaN NaN\n/);
  assert.match(x, /Name="Deslocamento Modo 1 \(mm\)" NumberOfComponents="3" format="ascii">/);
});

test("vtu: todas as camadas com `all`, nomes escapados e campos em falta como NaN", () => {
  const x = toVtu(view, { all: true });
  assert.equal((x.match(/<Piece /g) ?? []).length, 2);
  assert.match(x, /<!-- Corte &lt;A&gt; -->/);
  assert.equal((x.match(/<DataArray[^>]*Deslocamento/g) ?? []).length, 2);
  assert.ok(x.trimEnd().endsWith("</VTKFile>"));
  assert.doesNotMatch(x, /undefined/);
});

test("vtu: camada escondida pelo utilizador fica de fora; escondida por defeito entra com «+»", () => {
  assert.doesNotMatch(toVtu(view, { hidden: ["Peça"] }), /<Piece /);
  assert.equal((toVtu(view, { hidden: ["+Corte <A>"] }).match(/<Piece /g) ?? []).length, 2);
});
