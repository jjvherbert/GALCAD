// Ajuda por feature: todos os tipos têm texto completo e o corte extrudido tem o seu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CUT_HELP, FEATURE_HELP, helpForFeature } from "../src/app/feature-help.ts";
import { FEATURE_LABELS } from "../src/doc/features.ts";
import type { Feature } from "../src/doc/types.ts";

test("FEATURE_HELP cobre exatamente os tipos de feature", () => {
  assert.deepEqual(Object.keys(FEATURE_HELP).sort(), Object.keys(FEATURE_LABELS).sort());
});

test("cada ajuda tem título, descrição e passos", () => {
  for (const [type, h] of Object.entries(FEATURE_HELP)) {
    assert.ok(h.title.trim(), `${type}: título vazio`);
    assert.ok(h.what.trim(), `${type}: descrição vazia`);
    assert.ok(h.steps.length > 0 && h.steps.every((s) => s.trim()), `${type}: passos vazios`);
  }
});

test("helpForFeature distingue o corte extrudido", () => {
  const ext = { id: "f1", type: "extrude", sketch: "s1", op: "cut" } as unknown as Feature;
  assert.equal(helpForFeature(ext), CUT_HELP);
  assert.equal(helpForFeature({ ...ext, op: "new" } as Feature), FEATURE_HELP.extrude);
  assert.equal(helpForFeature({ id: "f2", type: "curve" } as unknown as Feature), FEATURE_HELP.curve);
});
