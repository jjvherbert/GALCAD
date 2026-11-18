// Os avisos do caso (planeador da malha, apoios, passos) chegam ao resultado mostrado, sem repetidos.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "../src/app/sim-client.ts";

// sim-client importa o store (singleton com worker, localStorage e tema): simulam-se os globais do navegador.
const mem = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
});
g.document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {} } };
g.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
g.Worker = class { onmessage = null; onerror = null; postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };
const { withCaseWarnings } = await import("../src/app/sim-client.ts");
const { store } = await import("../src/app/store.ts");
clearTimeout((store as unknown as { timer: ReturnType<typeof setTimeout> }).timer);

const res = (warnings: string[]) => ({ ok: true, physics: "fem", warnings }) as unknown as RunResult;

test("withCaseWarnings: avisos do caso primeiro, depois os do agente, sem repetidos", () => {
  const hex = "Hexaedros por subdivisão (qualidade inferior): Corpo 1 não é um bloco hexaédrico";
  const r = withCaseWarnings([hex, "Sem apoios: movimento de corpo rígido"], res(["260 assinalamento(s) de qualidade", hex]));
  assert.deepEqual(r.warnings, [hex, "Sem apoios: movimento de corpo rígido", "260 assinalamento(s) de qualidade"]);
});

test("withCaseWarnings: sem avisos do caso devolve a mesma resposta; resposta sem avisos não rebenta", () => {
  const r = res(["a"]);
  assert.equal(withCaseWarnings([], r), r);
  assert.deepEqual(withCaseWarnings(["x"], { ok: true } as unknown as RunResult).warnings, ["x"]);
});
