// Registo de features (A4): cada tipo tem um builder em tempo de execução, não só no tipo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDERS } from "../src/kernel/registry.ts";

test("cada entrada do registo é uma função", () => {
  const entries = Object.entries(BUILDERS);
  assert.ok(entries.length >= 40);
  for (const [type, b] of entries) assert.equal(typeof b, "function", type);
});
