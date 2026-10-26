import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature, newDocument, type NewFeature } from "../src/doc/io.ts";
import type { CadDocument } from "../src/doc/types.ts";
import { crc32 } from "../src/io/mesh-export.ts";

before(initKernel);

function doc(...features: NewFeature[]): CadDocument {
  let d = newDocument();
  for (const f of features) d = addFeature(d, f).doc;
  return d;
}
const errs = (s: Record<string, { state: string; error?: string }>) => Object.entries(s).filter(([, x]) => x.state === "error").map(([k, x]) => `${k}: ${x.error}`);
const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

function block(h: number | string = 20): NewFeature[] {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 90, 50);
  return [s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: h } }];
}

test("malha com nomes, propriedades de massa e exportações", async () => {
  const svc = new KernelService();
  const r = await svc.rebuild(doc(...block()));
  assert.deepEqual(errs(r.status), []);
  assert.ok(r.mesh);
  assert.equal(r.mesh.faces.length, 6);
  assert.ok(r.mesh.faces.every((f) => f.name.startsWith("f2:")));
  assert.equal(r.mesh.edges.length, 12);
  assert.ok(r.mesh.edges.every((e) => e.name.startsWith("{")));
  near(r.mass!.volume, 120000);
  near(r.mass!.area, 2 * (100 * 60 + 100 * 20 + 60 * 20));
  assert.deepEqual(r.mass!.center.map((v) => Math.round(v)), [50, 30, 10]);
  assert.equal(r.sketches.f1.dof, 0);

  const step = await svc.export("step", "bloco");
  assert.match(new TextDecoder().decode(step.data.slice(0, 20)), /ISO-10303-21/);
  const stl = await svc.export("stl", "bloco");
  const tris = new DataView(stl.data.buffer).getUint32(80, true);
  assert.ok(tris >= 12);
  assert.equal(stl.data.length, 84 + 50 * tris);
  const tmf = await svc.export("3mf", "bloco");
  assert.equal(new DataView(tmf.data.buffer).getUint32(0, true), 0x04034b50);
  const glb = await svc.export("glb", "bloco");
  assert.equal(new TextDecoder().decode(glb.data.slice(0, 4)), "glTF");
  const obj = await svc.export("obj", "bloco");
  assert.match(new TextDecoder().decode(obj.data), /^# Exportado/);

  // reimportar o STEP como feature
  const r2 = await new KernelService().rebuild(doc({ type: "import", format: "step", fileName: "bloco.step", data: new TextDecoder().decode(step.data), op: "add" }));
  assert.deepEqual(errs(r2.status), []);
  near(r2.mass!.volume, 120000);
});

test("até à face, sistema de coordenadas, eixo e chanfro assimétrico", async () => {
  const s = new SketchBuilder({ kind: "csys", feature: "f3", name: "XY" });
  s.circle(20, 20, 5);
  const d = doc(
    ...block(),
    { type: "csys", origin: [0, 0, 50], rotation: [0, 0, 0] },
    s.build(),
    { type: "extrude", sketch: "f4", op: "add", flip: true, end: { type: "upToFace", face: { kind: "face", name: "f2:end:l5" } } },
    { type: "axis", mode: "twoPlanes", planes: [{ kind: "std", name: "XZ" }, { kind: "std", name: "YZ" }] },
    { type: "chamfer", refs: [{ kind: "edge", name: "{f2:side:l5&f2:start:l5}" }], distance: 2, distance2: 4 },
  );
  const r = await new KernelService().rebuild(d);
  assert.deepEqual(errs(r.status), []);
  near(r.mass!.volume, 120000 + Math.PI * 25 * 30 - 0.5 * 2 * 4 * 100);
  assert.deepEqual(r.axes.f6.d.map((v) => Math.round(Math.abs(v))), [0, 0, 1]);
});

test("plugin náutico: casco com hidrostática", async () => {
  const r = await new KernelService().rebuild(doc({ type: "plugin", plugin: "nautica", kind: "casco", params: { L: 8000, B: 2600, D: 1200, T: 500, stations: 9 }, op: "add" }));
  assert.deepEqual(errs(r.status), []);
  const rows = Object.fromEntries(r.status.f1.info!.rows);
  assert.match(rows["Volume imerso ∇"], /^4,8\d m³$/);
});

test("crc32 conhecido", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("regressão: furo cego (face cónica) não impede a malha", async () => {
  const top = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  top.point(30, 30);
  const r = await new KernelService().rebuild(doc(...block(), top.build(), { type: "hole", sketch: "f3", kind: "tapped", size: "M8", end: { type: "blind", depth: 10 } }));
  assert.deepEqual(errs(r.status), []);
  assert.ok(r.mesh!.faces.some((f) => f.type === "cone"));
  assert.ok(r.mass!.volume < 120000);
});
