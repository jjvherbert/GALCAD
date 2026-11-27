// Plurais nos textos (pl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pl } from "../src/doc/plural.ts";

test("pl concorda com o número (0 e 2+ no plural)", () => {
  assert.equal(pl(1, "partição", "partições"), "1 partição");
  assert.equal(pl(0, "partição", "partições"), "0 partições");
  assert.equal(pl(3, "elemento invertido", "elementos invertidos"), "3 elementos invertidos");
});
