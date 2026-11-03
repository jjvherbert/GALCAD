// Chave da cache de reconstrução: hash encadeado por feature (A6).
// key(i) = h(key(i-1) | JSON(feature i) | revisão externa) — custo O(tamanho da feature), não O(prefixo).
// 2 × cyrb53 com seeds diferentes ≈ 106 bits: uma colisão reutilizaria a geometria da feature errada.
import type { Feature } from "../doc/types.ts";

function cyrb53(s: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export const hashKey = (s: string) => `${cyrb53(s, 0).toString(36)}:${cyrb53(s, 0x9e3779b1).toString(36)}`;

/** Semente da cadeia: os valores das variáveis globais (mudar uma invalida todas as features). */
export const seedKey = (values: Iterable<[string, number]>) => hashKey(JSON.stringify([...values]));

/** Chave da feature seguinte; `revision` é a revisão da peça de origem de uma referência externa. */
export const chainKey = (prev: string, f: Feature, revision?: string) =>
  hashKey(`${prev}|${JSON.stringify(f)}${revision !== undefined ? `@${revision}` : ""}`);
