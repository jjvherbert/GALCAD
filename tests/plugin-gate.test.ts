// Casco náutico atrás de flag: com a flag desligada, um documento antigo abre, a feature segue suprimida
// (não apagada) e os pedidos ao worker não levam o plugin; a flag liga/desliga a lista de plugins ativos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activePlugins, knownPlugin } from "../src/plugins/index.ts";
import { gateDoc, gateRequest, inactivePluginFeature } from "../src/app/plugin-gate.ts";
import { addFeature, newDocument, parseDocument, serialize } from "../src/doc/io.ts";
import type { Feature } from "../src/doc/types.ts";
import { KernelService } from "../src/kernel/service.ts";
import { DEFAULT_SETTINGS } from "../src/app/settings.ts";

const OFF = { galkeelHull: false };
const ON = { galkeelHull: true };

function docComCasco() {
  const base = addFeature(newDocument(), { type: "plugin", plugin: "nautica", kind: "casco", params: { L: 8000, B: 2600, D: 1200, T: 500, stations: 9 }, op: "add" } as never).doc;
  return base;
}

test("a flag decide se o plugin náutico está ativo; conhecê-lo não depende dela", () => {
  assert.equal(DEFAULT_SETTINGS.plugins.galkeelHull, false);
  assert.deepEqual(activePlugins(OFF).map((p) => p.id), []);
  assert.deepEqual(activePlugins(ON).map((p) => p.id), ["nautica"]);
  assert.equal(knownPlugin("nautica")?.id, "nautica");
  assert.equal(knownPlugin("inexistente"), undefined);
});

test("documento antigo com casco e flag desligada: abre, mantém a feature e vai suprimida", () => {
  const d = docComCasco();
  const reaberto = parseDocument(serialize(d)); // não pode lançar
  assert.equal(reaberto.features.length, 1);
  const f = reaberto.features[0] as Feature;
  assert.ok(inactivePluginFeature(f, OFF));
  assert.ok(!inactivePluginFeature(f, ON));
  const g = gateDoc(reaberto, OFF);
  assert.equal(g.features.length, 1);
  assert.equal(g.features[0].suppressed, true);
  assert.equal(reaberto.features[0].suppressed, undefined, "o documento original não é alterado");
  assert.equal(gateDoc(reaberto, ON), reaberto, "com a flag ligada nada muda");
});

test("a porta cobre doc, peças e projeto de um pedido", () => {
  const d = docComCasco();
  const r = gateRequest({ type: "rebuild", doc: d, parts: [{ ...d, id: "p2" }] }, OFF) as { doc: typeof d; parts: typeof d[] };
  assert.equal(r.doc.features[0].suppressed, true);
  assert.equal(r.parts[0].features[0].suppressed, true);
  const p = gateRequest({ type: "signatures", project: { format: "cadp-project", version: 1, name: "x", parts: [{ ...d, id: "p1" }], assemblies: [], drawings: [] } }, OFF) as { project: { parts: typeof d[] } };
  assert.equal(p.project.parts[0].features[0].suppressed, true);
});

test("o núcleo reconstrói o documento gated sem falhar", async () => {
  const { initKernel } = await import("./helpers.ts");
  await initKernel();
  const r = await new KernelService().rebuild(gateDoc(docComCasco(), OFF));
  const id = docComCasco().features[0].id;
  assert.equal(r.status[id].state, "suppressed");
});
