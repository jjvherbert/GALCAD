// Setas das cargas na vista 3D (C1c): avaliação, escala relativa e cores por carga.
import { test } from "node:test";
import assert from "node:assert/strict";
import { glyphMagnitude, GLYPH_PALETTE, loadGlyphs } from "../src/app/load-glyphs.ts";
import type { FemLoad, FemStudy } from "../src/doc/study.ts";

const face = (name: string) => ({ kind: "face" as const, name });
const study = (loads: FemLoad[], sets?: unknown[]) => ({ loads, sets } as unknown as FemStudy);
const scope = (vars: Record<string, number>) => (n: string) => vars[n];

test("uma só carga usa a cor do tipo e escala 1", () => {
  const g = loadGlyphs(study([{ kind: "pressure", faces: [face("F1")], p: 2 }]), scope({}));
  assert.equal(g.length, 1);
  assert.equal(g[0].color, 0xdc2626);
  assert.equal(g[0].scale, 1);
  assert.deepEqual(g[0].faces, ["F1"]);
  assert.equal(glyphMagnitude(g[0]), "2 MPa");
});

test("forças avaliam variáveis e escalam pela maior da mesma grandeza", () => {
  const g = loadGlyphs(
    study([
      { kind: "force", faces: [face("A")], f: [0, 0, "-F"] },
      { kind: "pointForce", point: [1, 2, 3], f: [250, 0, 0] },
      { kind: "pressure", faces: [face("B")], p: 0.1 },
    ]),
    scope({ F: 1000 }),
  );
  assert.equal(g.length, 3);
  assert.deepEqual(g[0].vec, [0, 0, -1000]);
  assert.equal(g[0].scale, 1);
  assert.equal(g[1].scale, 0.25);
  assert.equal(g[2].scale, 1, "a pressão compara-se só com pressões");
  assert.deepEqual(g.map((x) => x.color), GLYPH_PALETTE.slice(0, 3));
  assert.equal(glyphMagnitude(g[0]), "1000 N");
});

test("referencial local retangular roda a força para globais", () => {
  const [g] = loadGlyphs(study([{ kind: "force", faces: [face("A")], f: [10, 0, 0], csys: { type: "rect", a: [0, 1, 0], b: [-1, 0, 0] } }]), scope({}));
  assert.ok(Math.abs(g.vec![0]) < 1e-12 && Math.abs(g.vec![1] - 10) < 1e-12 && Math.abs(g.vec![2]) < 1e-12);
});

test("cargas por avaliar, nulas ou sem força ficam sem seta", () => {
  const g = loadGlyphs(
    study([
      { kind: "force", faces: [face("A")], f: [0, 0, "semNome"] },
      { kind: "pressure", faces: [face("B")], p: 0 },
      { kind: "coupling", faces: [face("C")], point: [0, 0, 0], mode: "rigid" },
      { kind: "fixed", faces: [face("D")] } as FemLoad,
      { kind: "gravity", g: [0, 0, -9810] },
    ]),
    scope({}),
  );
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "gravity");
  assert.equal(g[0].index, 4);
  assert.equal(glyphMagnitude(g[0]), "9.81 m/s²");
});

test("faces dos conjuntos entram e a chave do 3D é aplicada", () => {
  const sets = [{ id: "s1", name: "S", faces: [face("X")] }];
  const [g] = loadGlyphs(study([{ kind: "pressure", faces: [face("A")], sets: ["s1"], p: 1 }], sets), scope({}), (n) => `k:${n}`);
  assert.deepEqual(g.faces, ["k:A", "k:X"]);
});
