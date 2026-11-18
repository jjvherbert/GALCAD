// Rótulos curtos da barra: cada comando traz o seu `short` (já não há cadeia de regex na Toolbar).
import { test } from "node:test";
import assert from "node:assert/strict";

const g = globalThis as Record<string, unknown>;
const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });
g.document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {} } };
g.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
g.Worker = class { onmessage = null; onerror = null; postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };
g.innerWidth = 1280; g.innerHeight = 800; g.addEventListener = () => {};

const { COMMANDS, commandAvailable } = await import("../src/app/commands.ts");
const { store } = await import("../src/app/store.ts");
clearTimeout((store as unknown as { timer: ReturnType<typeof setTimeout> }).timer);

test("todos os comandos têm rótulo curto, curto e sem espaços nas pontas", () => {
  for (const c of COMMANDS) {
    assert.ok(c.short.trim() && c.short === c.short.trim(), `${c.id}: short vazio`);
    assert.ok(c.short.length <= 24, `${c.id}: short demasiado longo (${c.short})`);
  }
});

test("os comandos de plugins só estão disponíveis com a flag ligada", () => {
  const casco = COMMANDS.find((c) => c.id === "plugin.nautica.casco")!;
  assert.equal(casco.short, "Casco paramétrico");
  store.state.settings = { ...store.state.settings, plugins: { galkeelHull: false } };
  assert.equal(commandAvailable(casco), false);
  store.state.settings = { ...store.state.settings, plugins: { galkeelHull: true } };
  assert.equal(commandAvailable(casco), true);
});
