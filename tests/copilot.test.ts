// Copiloto de scripts: contexto enviado (sem geometria), pedido à API (modelo, raciocínio adaptativo,
// saída estruturada) e leitura da resposta, com um fetch simulado (sem rede).
import { test } from "node:test";
import assert from "node:assert/strict";
import { copilotInterpret, copilotScript, scriptContext } from "../src/ai/copilot.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import { SketchBuilder } from "./helpers.ts";
import { newFemStudy } from "../src/doc/study.ts";

function doc() {
  const s = new SketchBuilder();
  s.rect(0, 0, "L", 10, 100, 10);
  let d = { ...newDocument("Consola"), variables: [{ name: "L", expr: "100", comment: "comprimento" }] };
  d = addFeature(d, s.build()).doc as typeof d;
  d = addFeature(d, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc as typeof d;
  return { ...d, studies: [{ ...newFemStudy("s1", 1), probes: [{ name: "Ponta", quantity: "uz" as const, at: { kind: "faces" as const, faces: [] } }] }] };
}

function fakeFetch(payload: unknown, seen: { body?: Record<string, unknown> }) {
  return (async (_url: string, init: RequestInit) => {
    seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("copiloto: contexto do modelo sem geometria (variáveis, features, estudos, sondas)", () => {
  const c = scriptContext(doc(), { L: 100 }, { volume: 10000 });
  assert.deepEqual(c.variables, [{ name: "L", expr: "100", value: 100, comment: "comprimento" }]);
  assert.deepEqual(c.features.map((f) => f.type), ["sketch", "extrude"]);
  assert.ok(!JSON.stringify(c.features[0]).includes("entities"), "o esboço não vai inteiro");
  assert.deepEqual((c.studies[0] as { probes: unknown[] }).probes, [{ key: "probe1", name: "Ponta", quantity: "uz" }]);
});

test("copiloto: gera script com a API documentada e devolve explicação, código e avisos", async () => {
  const seen: { body?: Record<string, unknown> } = {};
  const answer = { explanation: "Varre L.", code: "for (const L of [80, 100]) { cad.set('L', L); await cad.rebuild(); }", assumptions: ["L em mm"], warnings: [] };
  const r = await copilotScript("sk-test", "varre L", scriptContext(doc()), { code: "x", error: "ReferenceError: y" }, fakeFetch(answer, seen));
  assert.deepEqual(r, answer);
  const b = seen.body!;
  assert.equal(b.model, "claude-opus-5-5");
  assert.deepEqual(b.thinking, { type: "adaptive" });
  assert.match(String(b.system), /cad\.simulate/);
  assert.match(JSON.stringify(b.messages), /ReferenceError: y/);
  assert.equal((b.output_config as { format: { type: string } }).format.type, "json_schema");
});

test("copiloto: interpretação dos resultados e erros da API", async () => {
  const seen: { body?: Record<string, unknown> } = {};
  const read = { summary: "A flecha cresce com L³.", findings: ["δ(120)/δ(80) ≈ 3,3"], caveats: ["3 pontos"], next: ["mais pontos"] };
  const r = await copilotInterpret("sk-test", scriptContext(doc()), "return 1", { value: 1, tables: [{ name: "T", rows: [{ L: 80 }] }], logs: [] }, fakeFetch(read, seen));
  assert.equal(r.summary, read.summary);
  const denied = (async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad" } }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await assert.rejects(copilotScript("sk-bad", "x", scriptContext(doc()), undefined, denied), /Chave API inválida/);
});
