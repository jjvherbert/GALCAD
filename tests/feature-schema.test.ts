import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { FEATURE_SCHEMAS, featureError } from "../src/doc/schema.ts";
import { FEATURE_LABELS } from "../src/doc/features.ts";
import { addFeature, newDocument, parseDocument, serialize } from "../src/doc/io.ts";
import { parseProject } from "../src/doc/project.ts";
import { defaultFeature } from "../src/app/defaults.ts";
import type { FeatureType } from "../src/doc/types.ts";

const TYPES = Object.keys(FEATURE_LABELS) as FeatureType[];
const FIXTURES = new URL("./e2e/fixtures/", import.meta.url);

/** Documento mínimo com as features dadas, em texto, como sai de um ficheiro. */
function docWith(...features: object[]): string {
  return JSON.stringify({ format: "cadp", version: 1, name: "T", units: "mm", variables: [], features });
}
const sketch = { id: "f1", name: "Esboço1", type: "sketch", plane: { kind: "std", name: "XY" }, entities: {}, constraints: [] };
const extrude = { id: "f2", name: "Extrusão1", type: "extrude", sketch: "f1", op: "new", end: { type: "blind", depth: 10 } };

test("há um schema para cada tipo de feature, e nada mais", () => {
  assert.deepEqual(Object.keys(FEATURE_SCHEMAS).sort(), [...TYPES].sort());
});

test("a feature por defeito de cada tipo passa no seu schema", () => {
  let doc = newDocument();
  for (const type of TYPES) {
    const data = defaultFeature(doc, type, { plugin: "nautica", kind: "casco" });
    const added = addFeature(doc, data);
    doc = added.doc;
    const f = doc.features.find((x) => x.id === added.id)!;
    assert.equal(featureError(f), null, `${type}: ${featureError(f)}`);
  }
  // e o documento inteiro volta a abrir
  assert.equal(parseDocument(serialize(doc)).features.length, TYPES.length);
});

test("todos os documentos de exemplo dos e2e abrem", () => {
  const files = readdirSync(FIXTURES).filter((n) => n.endsWith(".cadp.json"));
  assert.ok(files.length >= 10);
  for (const n of files) {
    assert.doesNotThrow(() => parseProject(readFileSync(new URL(n, FIXTURES), "utf8")), n);
  }
});

test("um campo com o tipo errado é rejeitado, com o id, o nome e o caminho", () => {
  const bad = { ...extrude, end: { type: "blind", depth: true } };
  assert.throws(() => parseDocument(docWith(sketch, bad)), /Feature f2 \(Extrusão1\) inválida em end\.depth/);
});

test("um campo obrigatório em falta é rejeitado", () => {
  const { sketch: _s, ...semEsboco } = extrude;
  assert.throws(() => parseDocument(docWith(sketch, semEsboco)), /f2 \(Extrusão1\) inválida em sketch/);
});

test("um valor de enumeração desconhecido é rejeitado", () => {
  assert.throws(() => parseDocument(docWith(sketch, { ...extrude, op: "merge" })), /inválida em op/);
  const plano = { ...sketch, plane: { kind: "std", name: "AB" } };
  assert.throws(() => parseDocument(docWith(plano)), /f1 \(Esboço1\) inválida em plane/);
});

test("nome e suprimida também são validados", () => {
  assert.throws(() => parseDocument(docWith({ ...sketch, name: 3 })), /Feature f1 inválida em name/);
  assert.throws(() => parseDocument(docWith({ ...sketch, suppressed: "sim" })), /inválida em suppressed/);
});

test("tipo desconhecido, ou herdado do protótipo, dá «Feature inválida»", () => {
  assert.throws(() => parseDocument(docWith({ ...sketch, type: "toString" })), /^Error: Feature inválida/);
  assert.throws(() => parseDocument(docWith({ ...sketch, type: "nada" })), /^Error: Feature inválida/);
});

test("chaves desconhecidas ficam no documento (ficheiros de versões mais novas)", () => {
  const d = parseDocument(docWith({ ...sketch, futuro: { a: 1 } }, extrude));
  assert.deepEqual((d.features[0] as unknown as { futuro: unknown }).futuro, { a: 1 });
});
