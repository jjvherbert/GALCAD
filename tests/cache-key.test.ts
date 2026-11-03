// Chave da cache de reconstrução (A6): hash encadeado por feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feature } from "../src/doc/types.ts";
import { chainKey, hashKey, seedKey } from "../src/kernel/cache-key.ts";

const feat = (id: string, depth: number) => ({ id, type: "extrude", sketch: "s1", depth }) as unknown as Feature;

const chain = (seed: string, fs: Feature[], rev?: string) => {
  const keys: string[] = [];
  let k = seed;
  for (const f of fs) keys.push((k = chainKey(k, f, rev)));
  return keys;
};

test("hashKey é determinística e distingue entradas próximas", () => {
  assert.equal(hashKey("abc"), hashKey("abc"));
  assert.notEqual(hashKey("abc"), hashKey("abd"));
  assert.notEqual(hashKey(""), hashKey(" "));
});

test("prefixos iguais dão chaves iguais", () => {
  const seed = seedKey(new Map([["L", 100]]));
  const a = chain(seed, [feat("f1", 10), feat("f2", 20)]);
  const b = chain(seed, [feat("f1", 10), feat("f2", 20), feat("f3", 30)]);
  assert.deepEqual(b.slice(0, 2), a);
});

test("mudar a feature i muda as chaves de i em diante e não as anteriores", () => {
  const seed = seedKey([]);
  const a = chain(seed, [feat("f1", 10), feat("f2", 20), feat("f3", 30)]);
  const b = chain(seed, [feat("f1", 10), feat("f2", 21), feat("f3", 30)]);
  assert.equal(b[0], a[0]);
  assert.notEqual(b[1], a[1]);
  assert.notEqual(b[2], a[2]);
});

test("a revisão de uma referência externa entra na chave", () => {
  const f = feat("f1", 10);
  assert.notEqual(chainKey("s", f, "1"), chainKey("s", f, "2"));
  assert.notEqual(chainKey("s", f, "1"), chainKey("s", f));
});

test("mudar uma variável global muda todas as chaves", () => {
  const fs = [feat("f1", 10), feat("f2", 20)];
  const a = chain(seedKey(new Map([["L", 100]])), fs);
  const b = chain(seedKey(new Map([["L", 101]])), fs);
  assert.ok(a.every((k, i) => k !== b[i]));
});
