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
  const s = sanitizeSettings({ theme: "dark", sketchGrid: true, agentUrl: "http://10.0.0.5:9000", gestures: { up: "view.iso" } as unknown as Settings["gestures"] });
  assert.equal(s.theme, "dark");
  assert.equal(s.sketchGrid, true);
  assert.equal(s.agentUrl, "http://10.0.0.5:9000");
  // formato antigo (plano) migra para o contexto "3d"
  assert.equal(s.gestures["3d"].up, "view.iso");
  assert.equal(s.gestures["3d"].down, DEFAULT_SETTINGS.gestures["3d"].down);
});

test("sanitizeSettings: gestos por contexto (formato novo) parciais", () => {
  const s = sanitizeSettings({ gestures: { sketch: { up: "sk:line" } } as unknown as Settings["gestures"] });
  assert.equal(s.gestures.sketch.up, "sk:line");
  assert.equal(s.gestures.sketch.down, DEFAULT_SETTINGS.gestures.sketch.down);
  assert.deepEqual(s.gestures["3d"], DEFAULT_SETTINGS.gestures["3d"]);
  assert.deepEqual(s.gestures.fem, DEFAULT_SETTINGS.gestures.fem);
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

test("sanitizeSettings: plugins e helpExpanded têm defeito seguro e fundem com definições antigas", () => {
  assert.equal(DEFAULT_SETTINGS.helpExpanded, false);
  assert.deepEqual(DEFAULT_SETTINGS.plugins, { galkeelHull: false });
  // definições antigas (sem as chaves novas)
  const velho = sanitizeSettings({ theme: "dark" });
  assert.deepEqual(velho.plugins, { galkeelHull: false });
  assert.equal(velho.helpExpanded, false);
  // válidos preservados; inválidos descartados
  assert.equal(sanitizeSettings({ plugins: { galkeelHull: true }, helpExpanded: true }).plugins.galkeelHull, true);
  assert.equal(sanitizeSettings({ helpExpanded: true }).helpExpanded, true);
  const mau = sanitizeSettings({ plugins: "sim", helpExpanded: "sim" } as unknown as Partial<Settings>);
  assert.deepEqual(mau.plugins, { galkeelHull: false });
  assert.equal(mau.helpExpanded, false);
  assert.deepEqual(sanitizeSettings({ plugins: { galkeelHull: 1, outro: true } } as unknown as Partial<Settings>).plugins, { galkeelHull: false });
});
