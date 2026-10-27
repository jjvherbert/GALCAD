// Superfícies: criação, preenchimento, costura em sólido, espessar, aparar, desviar e apagar faces.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine, type RebuildResult } from "../src/kernel/rebuild.ts";
import { bbox, edgeProps, oc, volume, type TopoDS_Shape } from "../src/kernel/occ.ts";
import { type NamedBody, namedEdges } from "../src/kernel/naming.ts";
import { addFeature, newDocument, type NewFeature } from "../src/doc/io.ts";
import type { CadDocument, PlaneRef, TopoRef } from "../src/doc/types.ts";

before(initKernel);

const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const errors = (r: RebuildResult) => Object.entries(r.status).filter(([, s]) => s.state === "error").map(([id, s]) => `${id}: ${s.error}`);

function doc(...features: NewFeature[]): CadDocument {
  let d = newDocument();
  for (const f of features) d = addFeature(d, f).doc;
  return d;
}

function area(s: TopoDS_Shape): number {
  const o = oc();
  const p = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(s, p, false, false);
  const a = p.Mass();
  p.delete();
  return a;
}

/** Arestas livres (de uma só face) de um corpo de superfície, filtradas por uma condição no ponto médio. */
function freeEdges(b: NamedBody, where: (mid: number[]) => boolean): TopoRef[] {
  return namedEdges(b).filter((e) => e.faces.length === 1 && where(edgeProps(e.edge).mid)).map((e) => ({ kind: "edge", name: e.name }));
}

/** Linha aberta de (x0,y0) a (x1,y1), com as extremidades fixas. */
function lineSketch(x0: number, y0: number, x1: number, y1: number, plane?: PlaneRef) {
  const s = new SketchBuilder(plane);
  s.line(s.point(x0, y0, { fixed: true }), s.point(x1, y1, { fixed: true }));
  return s.build();
}

/** Retângulo 100×60 na origem (esboço XY). */
function rectSketch() {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 90, 50);
  return s.build();
}

test("superfície extrudida de um contorno aberto: faces nomeadas e área", async () => {
  const s = new SketchBuilder();
  const a = s.point(0, 0, { fixed: true }), b = s.point(10, 0, { fixed: true }), c = s.point(10, 20, { fixed: true }), d = s.point(20, 20, { fixed: true });
  s.line(a, b); s.line(b, c); s.line(c, d);
  const r = await new Engine().rebuild(doc(s.build(), { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 15 } }));
  assert.deepEqual(errors(r), []);
  assert.equal(r.ctx.body, null);
  const sheet = r.ctx.sheets.get("f2")!;
  assert.deepEqual(sheet.faces.map((f) => f.name).sort(), ["f2:side:l5", "f2:side:l6", "f2:side:l7"]);
  near(area(sheet.shape), (10 + 20 + 10) * 15);
});

test("caixa por superfícies: paredes extrudidas + 2 preenchimentos + costura em sólido", async () => {
  const base = doc(rectSketch(), { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } });
  const e = new Engine();
  const r0 = await e.rebuild(base);
  assert.deepEqual(errors(r0), []);
  const walls = r0.ctx.sheets.get("f2")!;
  assert.equal(walls.faces.length, 4);
  const top = freeEdges(walls, (m) => Math.abs(m[2] - 20) < 1e-6);
  const bottom = freeEdges(walls, (m) => Math.abs(m[2]) < 1e-6);
  assert.equal(top.length, 4);
  assert.equal(bottom.length, 4);

  const d = doc(
    rectSketch(),
    { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    { type: "fill", edges: top, continuity: "contact" },
    { type: "fill", edges: bottom, continuity: "contact" },
    { type: "knit", sheets: ["f2", "f3", "f4"], makeSolid: true, op: "add" },
  );
  const r = await e.rebuild(d);
  assert.deepEqual(errors(r), []);
  assert.equal(r.ctx.sheets.size, 0, "a costura consome os corpos de superfície");
  near(volume(r.ctx.body!.shape).volume, 100 * 60 * 20);
  const names = r.ctx.body!.faces.map((f) => f.name).sort();
  assert.ok(names.includes("f3:fill") && names.includes("f4:fill") && names.includes("f2:side:l5"), names.join());

  // sem a tampa de baixo, a costura não fecha
  const open = doc(
    rectSketch(),
    { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    { type: "fill", edges: top, continuity: "contact" },
    { type: "knit", sheets: ["f2", "f3"], makeSolid: true },
  );
  const r2 = await new Engine().rebuild(open);
  assert.match(r2.status.f4.error ?? "", /aresta\(s\) livre\(s\)/);
  assert.equal(r2.ctx.sheets.size, 2, "uma costura falhada não consome os corpos de entrada");

  // costura sem sólido: um só corpo de superfície com as arestas livres de baixo
  const r3 = await new Engine().rebuild({ ...open, features: open.features.map((f) => f.type === "knit" ? { ...f, makeSolid: false } : f) });
  assert.deepEqual(errors(r3), []);
  assert.equal(r3.ctx.sheets.size, 1);
  assert.equal(r3.status.f4.info?.rows.find((x) => x[0] === "Arestas livres")?.[1], "4");
});

test("espessar: para a frente, para trás e dos dois lados", async () => {
  for (const [side, zmin, zmax] of [["front", 0, 2], ["back", -2, 0], ["both", -1, 1]] as const) {
    const s = new SketchBuilder({ kind: "std", name: "XZ" });
    // linha ao longo de X no plano XZ, extrudida segundo a normal do XZ (−Y): superfície no plano z = 0
    s.line(s.point(0, 0, { fixed: true }), s.point(100, 0, { fixed: true }));
    const d = doc(
      s.build(),
      { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
      { type: "thicken", sheet: "f2", thickness: 2, side, op: "add" },
    );
    const r = await new Engine().rebuild(d);
    assert.deepEqual(errors(r), [], side);
    near(volume(r.ctx.body!.shape).volume, 100 * 20 * 2);
    assert.equal(r.ctx.sheets.size, 0);
    const b = bbox(r.ctx.body!.shape);
    // a espessura é em Z (o sentido "frente" segue a normal da face)
    const t = [b.min[2], b.max[2]];
    const ok = (Math.abs(t[0] - zmin) < 1e-3 && Math.abs(t[1] - zmax) < 1e-3) || (Math.abs(t[0] + zmax) < 1e-3 && Math.abs(t[1] + zmin) < 1e-3);
    assert.ok(ok, `${side}: z ∈ [${t}]`);
  }
});

test("aparar por um plano: fica a parte indicada; a escolha muda o resultado", async () => {
  const mk = (keep: [number, number, number]) => doc(
    lineSketch(-50, 0, 50, 0),
    { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    { type: "plane", base: { kind: "std", name: "YZ" }, offset: 20 },
    { type: "trimSurface", sheet: "f2", tool: { kind: "plane", plane: { kind: "datum", feature: "f3" } }, keep: [keep] },
  );
  const r = await new Engine().rebuild(mk([40, 0, 10]));
  assert.deepEqual(errors(r), []);
  near(area(r.ctx.sheets.get("f2")!.shape), 30 * 20);
  const r2 = await new Engine().rebuild(mk([-10, 0, 10]));
  near(area(r2.ctx.sheets.get("f2")!.shape), 70 * 20);
  assert.ok(r2.ctx.sheets.get("f2")!.faces.every((f) => f.name.startsWith("f2:side:")));

  // aparar por um esboço (círculo projetado na normal)
  const c = new SketchBuilder();
  c.circle(0, 0, 10);
  const d = doc(
    lineSketch(-50, 0, 50, 0),
    { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    c.build(),
    { type: "trimSurface", sheet: "f2", tool: { kind: "sketch", sketch: "f3" }, keep: [[0, 0, 10]] },
  );
  // o círculo de raio 10 no XY corta a faixa (y=0) em x=±10: fica 20×20
  const r3 = await new Engine().rebuild(d);
  assert.deepEqual(errors(r3), []);
  near(area(r3.ctx.sheets.get("f2")!.shape), 20 * 20);
});

test("superfície de revolução e superfície deslocada", async () => {
  const d = doc(
    lineSketch(10, 0, 10, 20, { kind: "std", name: "XZ" }),
    { type: "surfaceRevolve", sketch: "f1", axis: { kind: "std", name: "Z" }, angle: 360 },
    { type: "offsetSurface", faces: [{ kind: "face", name: "f2:side:l3" }], distance: 5 },
  );
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  near(area(r.ctx.sheets.get("f2")!.shape), 2 * Math.PI * 10 * 20);
  const off = area(r.ctx.sheets.get("f3")!.shape);
  const ratio = off / (2 * Math.PI * 10 * 20);
  assert.ok(Math.abs(ratio - 1.5) < 1e-3 || Math.abs(ratio - 0.5) < 1e-3, `razão ${ratio}`);
  assert.equal(r.ctx.sheets.get("f3")!.faces[0].name, "f3:off{f2:side:l3}");
});

test("loft de superfície entre duas linhas e varrimento aberto", async () => {
  const d = doc(
    lineSketch(0, 0, 100, 0),
    { type: "plane", base: { kind: "std", name: "XY" }, offset: 30 },
    lineSketch(0, 40, 100, 40, { kind: "datum", feature: "f2" }),
    { type: "surfaceLoft", sections: ["f1", "f3"], ruled: true },
  );
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  near(area(r.ctx.sheets.get("f4")!.shape), 100 * 50);

  // perfil aberto no YZ (Y de −5 a 5) varrido ao longo de X (50)
  const sw = doc(
    lineSketch(-5, 0, 5, 0, { kind: "std", name: "YZ" }),
    lineSketch(0, 0, 50, 0),
    { type: "surfaceSweep", profile: "f1", path: "f2" },
  );
  const r2 = await new Engine().rebuild(sw);
  assert.deepEqual(errors(r2), []);
  near(area(r2.ctx.sheets.get("f3")!.shape), 10 * 50);
});

test("preenchimento tangente fecha um cone em cúpula", async () => {
  // cone a 45° (raio 20 em z=0, raio 10 em z=10): a tampa tangente sobe em cúpula
  const base = (cont: "contact" | "tangent") => doc(
    lineSketch(20, 0, 10, 10, { kind: "std", name: "XZ" }),
    { type: "surfaceRevolve", sketch: "f1", axis: { kind: "std", name: "Z" }, angle: 360 },
    { type: "fill", edges: [{ kind: "edge", name: "{f2:side:l3}#1" }], continuity: cont },
  );
  const e = new Engine();
  const flat = await e.rebuild(base("contact"));
  assert.deepEqual(errors(flat), []);
  near(area(flat.ctx.sheets.get("f3")!.shape), Math.PI * 100, 1e-2);
  const dome = await new Engine().rebuild(base("tangent"));
  assert.deepEqual(errors(dome), []);
  const a = area(dome.ctx.sheets.get("f3")!.shape);
  assert.ok(a > Math.PI * 100 * 1.05, `tangente ao cone: não é plana (área ${a})`);
  assert.ok(bbox(dome.ctx.sheets.get("f3")!.shape).max[2] > 11, "a cúpula sobe acima do topo do cone");
});

test("apagar face: o sólido passa a superfície; preencher e costurar repõe o volume", async () => {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 90, 50);
  const d0 = doc(s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }, { type: "deleteFace", faces: [{ kind: "face", name: "f2:end:l5" }] });
  const e = new Engine();
  const r0 = await e.rebuild(d0);
  assert.deepEqual(errors(r0), []);
  assert.equal(r0.ctx.body, null);
  const sheet = r0.ctx.sheets.get("f3")!;
  assert.equal(sheet.faces.length, 5);
  const hole = freeEdges(sheet, () => true);
  assert.equal(hole.length, 4);
  const d = doc(
    s.build(),
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    { type: "deleteFace", faces: [{ kind: "face", name: "f2:end:l5" }] },
    { type: "fill", edges: hole, continuity: "contact" },
    { type: "knit", sheets: ["f3", "f4"], makeSolid: true },
  );
  const r = await e.rebuild(d);
  assert.deepEqual(errors(r), []);
  near(volume(r.ctx.body!.shape).volume, 100 * 60 * 20);
});
