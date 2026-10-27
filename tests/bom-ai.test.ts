// Assistente de BOM local: reconhecimento de normalizados pela geometria, chapa, duplicados e coerência.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature, type NewFeature } from "../src/doc/io.ts";
import { type CadProject, type PartDoc, newPart } from "../src/doc/project.ts";
import { classify, localSuggestions, materialFamily } from "../src/ai/bom-assistant.ts";
import { bomPayload } from "../src/ai/claude.ts";
import type { PartSignature } from "../src/kernel/signature.ts";

before(initKernel);

function part(pr: CadProject, name: string, ...features: NewFeature[]): PartDoc {
  let p = newPart(pr, name);
  for (const f of features) p = { ...p, ...addFeature(p, f).doc };
  pr.parts.push(p);
  return p;
}

/** Hexágono regular com distância entre faces s, centrado na origem. */
function hexagon(s: number) {
  const b = new SketchBuilder();
  const R = s / Math.sqrt(3);
  const pts = Array.from({ length: 6 }, (_, i) => b.point(R * Math.cos((i * Math.PI) / 3), R * Math.sin((i * Math.PI) / 3), { fixed: true }));
  pts.forEach((p, i) => b.line(p, pts[(i + 1) % 6]));
  return b.build();
}
function circle(r: number, plane?: SketchBuilder extends never ? never : ConstructorParameters<typeof SketchBuilder>[0], r2?: number) {
  const b = new SketchBuilder(plane);
  const c = b.circle(0, 0, r);
  b.constrain("radius", [c], r);
  b.constrain("coincident", [b.entities[c].type === "circle" ? (b.entities[c] as { c: string }).c : "", "O"]);
  if (r2) { const c2 = b.circle(0, 0, r2); b.constrain("radius", [c2], r2); b.constrain("coincident", [(b.entities[c2] as { c: string }).c, "O"]); }
  return b.build();
}
function rect(w: number, h: number) {
  const b = new SketchBuilder();
  b.rect(0, 0, w, h, w, h);
  return b.build();
}

test("assistente local: parafuso, anilha, chapa, duplicado e massa volúmica incoerente", async () => {
  const pr: CadProject = { format: "cadp-project", version: 1, name: "T", parts: [], assemblies: [], drawings: [] };
  part(pr, "Parafuso", hexagon(10), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 4 } },
    { type: "plane", base: { kind: "std", name: "XY" }, offset: 4 },
    circle(3, { kind: "datum", feature: "f3" }), { type: "extrude", sketch: "f4", op: "add", end: { type: "blind", depth: 20 } });
  part(pr, "Anilha", circle(6, undefined, 3.2), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 1.6 } });
  const plate = part(pr, "Chapa", rect(200, 100), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 5 } });
  plate.properties = { material: "Alumínio EN AW-5083", density: 7.85 };
  part(pr, "Chapa copia", rect(200, 100), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 5 } });
  pr.assemblies.push({ id: "a1", name: "M", components: pr.parts.map((p, i) => ({ id: `c${i + 1}`, name: p.name, ref: { kind: "part" as const, id: p.id }, placement: { t: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number] } })), mates: [] });

  const sig = (await new KernelService().signatures(pr)).parts;
  for (const [id, s] of Object.entries(sig)) assert.ok(!("error" in s), `${id}: ${"error" in s ? s.error : ""}`);
  const bolt = classify(sig.p1 as PartSignature);
  assert.equal(bolt.kind, "bolt");
  assert.equal(bolt.designation, "ISO 4017 M6 × 20");
  const washer = classify(sig.p2 as PartSignature);
  assert.equal(washer.designation, "ISO 7089 - 6");
  const pl = classify(sig.p3 as PartSignature);
  assert.equal(pl.kind, "plate");
  assert.match(pl.description, /^Chapa 5 mm — 200 × 100/);

  const sugs = localSuggestions(pr, sig, undefined, "a1");
  const std = sugs.find((s) => s.kind === "standard" && s.part === "p1")!;
  assert.equal(std.patch?.number, "ISO 4017 M6 × 20");
  assert.ok(sugs.some((s) => s.kind === "duplicate" && s.part === "p4"), "a cópia da chapa é um duplicado");
  const dens = sugs.find((s) => s.kind === "consistency" && s.part === "p3" && /massa volúmica/.test(s.title));
  assert.ok(dens && dens.patch && Math.abs(dens.patch.density! - 2.73) < 0.05, JSON.stringify(dens));
  assert.ok(sugs.some((s) => s.kind === "cost" && s.part === "p3"));
  assert.ok(sugs.every((s) => s.kind !== "supplier" || !/Lda|S\.A\./.test(s.detail)), "categorias, não empresas");
  assert.equal(materialFamily("Aço inox 1.4404"), "stainless");

  // o pedido ao Claude leva só a BOM e o resumo da geometria
  const payload = bomPayload(pr, "a1", sig);
  assert.equal(payload.length, 4);
  assert.ok(JSON.stringify(payload).length < 8000);
  assert.equal(payload[0].geometry?.hex_across_flats_mm, 10);
});

test("Claude: pedido (modelo, fallback, saída estruturada) e leitura das sugestões, com fetch simulado", async () => {
  const { claudeSuggestions, CLAUDE_MODEL } = await import("../src/ai/claude.ts");
  const pr: CadProject = { format: "cadp-project", version: 1, name: "T", parts: [], assemblies: [], drawings: [] };
  part(pr, "Base", rect(100, 60), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } });
  pr.parts[0].properties = { material: "Aço S235JR" };
  pr.assemblies.push({ id: "a1", name: "M", components: [{ id: "c1", name: "Base", ref: { kind: "part", id: "p1" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } }], mates: [] });
  const sig = (await new KernelService().signatures(pr)).parts;
  let sent: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    const answer = { suggestions: [{ part: "p1", kind: "description", title: "Descrição normalizada", detail: "Placa 100 × 60 × 20 a partir da caixa.", confidence: 0.7, patch: { number: null, description: "Placa 100 × 60 × 20", material: null, finish: null, process: "Fresagem CNC" } }] };
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: CLAUDE_MODEL, content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
  }) as unknown as typeof fetch;
  const out = await claudeSuggestions("sk-ant-teste", pr, "a1", sig, { fetch: fakeFetch });
  assert.ok(sent, "houve pedido");
  const s = sent as unknown as { url: string; headers: Headers; body: Record<string, unknown> };
  assert.match(s.url, /\/v1\/messages/);
  assert.equal(s.body.model, "claude-opus-5-5");
  assert.equal(s.body.fallbacks, "default");
  assert.match(s.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.ok((s.headers.get("x-api-key") ?? s.headers.get("authorization") ?? "").includes("sk-ant-teste"), "a chave vai no cabeçalho de autenticação");
  assert.equal(s.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal((s.body.output_config as { format: { type: string } }).format.type, "json_schema");
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "claude");
  assert.equal(out[0].patch?.description, "Placa 100 × 60 × 20");
  assert.equal(out[0].patch?.material, "Aço S235JR", "mantém as propriedades que não mudam");
  assert.equal(out[0].patch?.custom?.Processo, "Fresagem CNC");
});
