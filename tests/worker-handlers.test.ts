// Mapa de handlers do worker do núcleo: um handler por tipo de pedido, argumentos passados ao
// serviço e buffers transferidos (sem repetidos) iguais aos que a resposta contém.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, makeHandlers, meshBuffers } from "../src/kernel/handlers.ts";
import type { HandlerService } from "../src/kernel/handlers.ts";
import type { MeshData } from "../src/kernel/mesh.ts";
import type { RequestOf, RequestType } from "../src/kernel/protocol.ts";

const TYPES: RequestType[] = [
  "rebuild", "snapshot", "studyCase", "assemblyStudyCase", "panels", "export", "curvature", "deviation",
  "continuity", "normals", "combs", "assembly", "interference", "drawing", "signatures", "meshSeeds",
];

const mesh = (): MeshData => ({
  vertices: new Float32Array(3), normals: new Float32Array(3), triangles: new Uint32Array(3), lines: new Float32Array(6),
}) as unknown as MeshData;

/** Serviço falso: regista as chamadas e devolve respostas mínimas com buffers reais. */
function fake(over: Partial<Record<RequestType, unknown>> = {}) {
  const calls: [string, unknown[]][] = [];
  const out: Record<string, unknown> = {
    rebuild: { mesh: mesh() },
    curvature: { kind: "gauss", values: new Float32Array(4), min: 0, max: 1 },
    normals: { normals: new Float32Array(6) },
    assembly: { parts: { a: mesh(), b: mesh() } },
    interference: { pairs: [{ a: "a", b: "b", volume: 1, mesh: mesh() }] },
    export: { data: new Uint8Array(8), mime: "x", ext: "step" },
    ...over,
  };
  const svc = Object.fromEntries(TYPES.map((t) => [t, (...args: unknown[]) => {
    calls.push([t, args]);
    return out[t] ?? { tag: t };
  }])) as unknown as HandlerService;
  return { svc, calls };
}

const run = (svc: HandlerService, req: object) => handle(makeHandlers(svc), req as RequestOf<RequestType>);

test("há um handler para cada tipo de pedido", () => {
  const h = makeHandlers(fake().svc);
  assert.deepEqual(Object.keys(h).sort(), [...TYPES].sort());
  for (const t of TYPES) assert.equal(typeof h[t], "function");
});

test("rebuild transfere os buffers da malha; sem malha não transfere nada", async () => {
  const { svc } = fake();
  const r = await run(svc, { type: "rebuild", doc: {} });
  assert.deepEqual(r.transfer, meshBuffers((r.result as { mesh: MeshData }).mesh));
  assert.equal(r.transfer.length, 4);
  const empty = await run(fake({ rebuild: { mesh: null } }).svc, { type: "rebuild", doc: {} });
  assert.deepEqual(empty.transfer, []);
});

test("assembly, interference, export, curvature e normals transferem os seus buffers", async () => {
  const { svc } = fake();
  const asm = await run(svc, { type: "assembly", project: {}, asmId: "x" });
  assert.equal(asm.transfer.length, 8);
  const itf = await run(svc, { type: "interference" });
  assert.equal(itf.transfer.length, 4);
  const exp = await run(svc, { type: "export", format: "step", name: "p" });
  assert.deepEqual(exp.transfer, [(exp.result as { data: Uint8Array }).data.buffer]);
  const cur = await run(svc, { type: "curvature", kind: "gauss" });
  assert.deepEqual(cur.transfer, [(cur.result as { values: Float32Array }).values.buffer]);
  const nor = await run(svc, { type: "normals" });
  assert.deepEqual(nor.transfer, [(nor.result as { normals: Float32Array }).normals.buffer]);
});

test("os restantes tipos não transferem nada e devolvem o resultado do serviço", async () => {
  const { svc } = fake();
  for (const t of ["snapshot", "studyCase", "assemblyStudyCase", "panels", "deviation", "continuity", "combs", "drawing", "signatures", "meshSeeds"] as const) {
    const r = await run(svc, { type: t });
    assert.deepEqual(r.transfer, [], t);
    assert.deepEqual(r.result, { tag: t }, t);
  }
});

test("a lista de transferência sai sem buffers repetidos", async () => {
  const m = mesh();
  const r = await run(fake({ assembly: { parts: { a: m, b: m } } }).svc, { type: "assembly", project: {}, asmId: "x" });
  assert.equal(r.transfer.length, 4);
  assert.equal(new Set(r.transfer).size, r.transfer.length);
});

test("cada handler passa os argumentos do pedido ao serviço", async () => {
  const { svc, calls } = fake();
  const doc = {}, parts: never[] = [], project = {};
  await run(svc, { type: "rebuild", doc, force: true, parts });
  await run(svc, { type: "snapshot", doc, parts, feature: "f1" });
  await run(svc, { type: "studyCase", doc, parts, study: "s1" });
  await run(svc, { type: "panels", doc, parts, faces: ["F1"] });
  await run(svc, { type: "assemblyStudyCase", project, assembly: "a1", study: "s1" });
  await run(svc, { type: "export", format: "stl", name: "n" });
  await run(svc, { type: "curvature", kind: "mean" });
  await run(svc, { type: "combs", edges: ["E1"] });
  await run(svc, { type: "assembly", project, asmId: "a1", force: true });
  await run(svc, { type: "drawing", project, drawingId: "d1", force: false });
  await run(svc, { type: "signatures", project });
  await run(svc, { type: "meshSeeds", doc, parts, study: "s1" });
  assert.deepEqual(calls, [
    ["rebuild", [doc, true, parts]],
    ["snapshot", [doc, parts, "f1"]],
    ["studyCase", [doc, parts, "s1"]],
    ["panels", [doc, parts, ["F1"]]],
    ["assemblyStudyCase", [project, "a1", "s1"]],
    ["export", ["stl", "n"]],
    ["curvature", ["mean"]],
    ["combs", [["E1"]]],
    ["assembly", [project, "a1", true]],
    ["drawing", [project, "d1", false]],
    ["signatures", [project]],
    ["meshSeeds", [doc, parts, "s1"]],
  ]);
});
