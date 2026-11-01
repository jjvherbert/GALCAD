// Definições: leitura robusta do armazenamento e limites pedidos ao agente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, LIMITS, sanitizeSettings, type Settings } from "../src/app/settings.ts";
import { jobLimits } from "../tools/cad-runner.ts";

test("sanitizeSettings: vazio → valores por defeito", () => {
  assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS);
});

test("sanitizeSettings: descarta tipos e enumerados inválidos", () => {
  const s = sanitizeSettings({
    theme: "roxo", displayStyle: 3, reverseWheel: "sim", sketchGrid: 1, agentUrl: "javascript:alert(1)",
  } as unknown as Partial<Settings>);
  assert.equal(s.theme, "system");
  assert.equal(s.displayStyle, DEFAULT_SETTINGS.displayStyle);
  assert.equal(s.reverseWheel, false);
  assert.equal(s.sketchGrid, false);
  assert.equal(s.agentUrl, DEFAULT_SETTINGS.agentUrl);
});

test("sanitizeSettings: números cortados aos limites; NaN/texto → defeito", () => {
  const s = sanitizeSettings({ arrowStep: 500, meshTimeout: 1, solveTimeout: Number.NaN } as Partial<Settings>);
  assert.equal(s.arrowStep, LIMITS.arrowStep[1]);
  assert.equal(s.meshTimeout, LIMITS.meshTimeout[0]);
  assert.equal(s.solveTimeout, DEFAULT_SETTINGS.solveTimeout);
  assert.equal(sanitizeSettings({ arrowStep: "30" } as unknown as Partial<Settings>).arrowStep, DEFAULT_SETTINGS.arrowStep);
});

test("sanitizeSettings: preserva valores válidos e gestos parciais", () => {
  const s = sanitizeSettings({ theme: "dark", sketchGrid: true, agentUrl: "http://10.0.0.5:9000", gestures: { up: "view.iso" } as Settings["gestures"] });
  assert.equal(s.theme, "dark");
  assert.equal(s.sketchGrid, true);
  assert.equal(s.agentUrl, "http://10.0.0.5:9000");
  assert.equal(s.gestures.up, "view.iso");
  assert.equal(s.gestures.down, DEFAULT_SETTINGS.gestures.down);
});

test("sanitizeSettings: nunca guarda campos estranhos (ex. token)", () => {
  const s = sanitizeSettings({ token: "segredo" } as unknown as Partial<Settings>);
  assert.ok(!("token" in s));
});

test("jobLimits: aceita, corta nos máximos e ignora inválidos", () => {
  assert.deepEqual(jobLimits({ meshTimeout: 300, solveTimeout: 7200 }), { meshTimeout: 300, solveTimeout: 7200 });
  assert.deepEqual(jobLimits({ meshTimeout: 1e9, solveTimeout: 1e9 }), { meshTimeout: 7200, solveTimeout: 7 * 24 * 3600 });
  assert.deepEqual(jobLimits({ meshTimeout: -1, solveTimeout: "abc" }), {});
  assert.deepEqual(jobLimits({}), {});
});
