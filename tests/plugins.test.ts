// Contrato dos plugins: metadados coerentes, ajuda obrigatória e schema dos parâmetros validado antes de construir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_METAS, PLUGINS, pluginKind } from "../src/plugins/meta.ts";
import { evalPluginParams } from "../src/plugins/params.ts";
import type { PluginKind } from "../src/plugins/types.ts";
import { FEATURE_HELP, helpForFeature } from "../src/app/feature-help.ts";
import { featureLabel } from "../src/doc/features.ts";
import type { Feature } from "../src/doc/types.ts";

test("a chave de cada plugin é o seu id", () => {
  for (const [key, meta] of Object.entries(PLUGIN_METAS)) assert.equal(meta.id, key);
  assert.equal(new Set(PLUGINS.map((p) => p.id)).size, PLUGINS.length);
});

test("cada tipo de plugin tem ajuda, parâmetros e valores por omissão dentro do schema", () => {
  for (const p of PLUGINS) {
    for (const [k, kind] of Object.entries(p.kinds)) {
      const at = `${p.id}.${k}`;
      assert.ok(kind.label.trim(), `${at}: rótulo vazio`);
      assert.ok(kind.help.title.trim() && kind.help.what.trim(), `${at}: ajuda vazia`);
      assert.ok(kind.help.steps.length > 0 && kind.help.steps.every((s) => s.trim()), `${at}: passos vazios`);
      assert.ok(Object.keys(kind.params).length > 0, `${at}: sem parâmetros`);
      const defaults = Object.fromEntries(Object.entries(kind.params).map(([n, d]) => [n, d.value]));
      assert.doesNotThrow(() => evalPluginParams(kind, defaults, (v) => v ?? NaN), `${at}: omissões fora do schema`);
    }
  }
});

test("pluginKind só encontra tipos instalados", () => {
  assert.equal(pluginKind("nautica", "casco"), PLUGIN_METAS.nautica.kinds.casco);
  assert.equal(pluginKind("nautica", "toString"), undefined);
  assert.equal(pluginKind("inexistente", "casco"), undefined);
});

const kind: PluginKind = {
  label: "Teste",
  params: { L: { label: "Comprimento", value: 10, unit: "mm", min: 1, max: 100 }, n: { label: "Secções", value: 5, integer: true } },
  help: { title: "Teste", what: "Teste.", steps: ["Passo."] },
};
const run = (raw: Record<string, number>) => evalPluginParams(kind, raw, (v) => v ?? NaN);

test("evalPluginParams devolve só os parâmetros declarados", () => {
  assert.deepEqual(run({ L: 20, n: 7, extra: 3 }), { L: 20, n: 7 });
});

test("evalPluginParams recusa valores fora do schema com mensagem clara", () => {
  assert.throws(() => run({ n: 7 }), /Comprimento: valor inválido/);
  assert.throws(() => run({ L: 0.5, n: 7 }), /Comprimento: mínimo 1 mm \(0,5 mm\)/);
  assert.throws(() => run({ L: 200, n: 7 }), /Comprimento: máximo 100 mm/);
  assert.throws(() => run({ L: 20, n: 6.5 }), /Secções: tem de ser inteiro \(6,5\)/);
});

test("helpForFeature e featureLabel usam a ajuda e o rótulo do tipo de plugin", () => {
  const f = (plugin: string, k: string) => ({ id: "p1", name: "P1", type: "plugin", plugin, kind: k, params: {}, op: "add" }) as unknown as Feature;
  assert.equal(helpForFeature(f("nautica", "casco")), PLUGIN_METAS.nautica.kinds.casco.help);
  assert.equal(helpForFeature(f("inexistente", "x")), FEATURE_HELP.plugin);
  assert.equal(featureLabel(f("nautica", "casco")), "Casco paramétrico");
  assert.equal(featureLabel(f("inexistente", "x")), "Plugin");
});
