// Cores por material na vista 3D (C1c): uma cor por material distinto, legenda e faces sem material.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MATERIAL_PALETTE, MISSING_MATERIAL, materialColors, validMaterial } from "../src/app/material-colors.ts";
import type { FemStudy, SimMaterial } from "../src/doc/study.ts";

const steel: SimMaterial = { name: "Aço", E: 210000, nu: 0.3, density: 7.85 };
const alu: SimMaterial = { name: "Alumínio", E: 70000, nu: 0.33, density: 2.7 };
const study = (x: Partial<FemStudy>) => ({ material: steel, loads: [], ...x } as unknown as FemStudy);
const faces = (body: string, ...names: string[]) => names.map((name) => ({ name, body }));

test("peça única: todas as faces com a cor do material do estudo", () => {
  const r = materialColors(study({}), faces("", "F1", "F2"));
  assert.deepEqual([...r.faces.values()], [MATERIAL_PALETTE[0], MATERIAL_PALETTE[0]]);
  assert.deepEqual(r.legend, [{ name: "Aço", color: MATERIAL_PALETTE[0], bodies: 1 }]);
  assert.deepEqual(r.missing, []);
});

test("montagem: material por corpo, por conjunto e do estudo", () => {
  const s = study({
    bodyMaterials: { c2: alu },
    sets: [{ id: "g", name: "G", kind: "body", bodies: ["c3"], material: { ...alu } }],
  } as unknown as Partial<FemStudy>);
  const r = materialColors(s, [...faces("c1", "c1|F1"), ...faces("c2", "c2|F1", "c2|F2"), ...faces("c3", "c3|F1")]);
  assert.equal(r.faces.get("c1|F1"), MATERIAL_PALETTE[0]);
  assert.equal(r.faces.get("c2|F1"), MATERIAL_PALETTE[1]);
  assert.equal(r.faces.get("c3|F1"), MATERIAL_PALETTE[1], "o mesmo material num conjunto partilha a cor");
  assert.deepEqual(r.legend.map((x) => [x.name, x.bodies]), [["Aço", 1], ["Alumínio", 2]]);
});

test("mesmo nome com propriedades diferentes tem outra linha na legenda", () => {
  const r = materialColors(study({ bodyMaterials: { b: { ...steel, E: 200000 } } } as Partial<FemStudy>), [...faces("a", "a|F"), ...faces("b", "b|F")]);
  assert.deepEqual(r.legend.map((x) => x.name), ["Aço", "Aço (2)"]);
  assert.notEqual(r.faces.get("a|F"), r.faces.get("b|F"));
});

test("corpo sem material válido fica a vermelho e conta na legenda", () => {
  const r = materialColors(study({ bodyMaterials: { b: { ...steel, E: 0 }, c: { ...steel, name: " " } } } as Partial<FemStudy>), [...faces("a", "a|F"), ...faces("b", "b|F1", "b|F2"), ...faces("c", "c|F")]);
  assert.deepEqual(r.missing, ["b|F1", "b|F2", "c|F"]);
  assert.equal(r.faces.get("b|F1"), MISSING_MATERIAL);
  assert.deepEqual(r.legend.at(-1), { name: "Sem material", color: MISSING_MATERIAL, bodies: 2, missing: true });
  assert.equal(validMaterial(steel), true);
  assert.equal(validMaterial(undefined), false);
});
