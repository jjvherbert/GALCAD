// Fecho da Fase 2: curvas 3D, superfície limite, regrada, desaparar, substituir face, apagar e remendar,
// aparar mútuo, padrões de superfícies, análise de desvio e dependências dos aparares.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine, type RebuildResult } from "../src/kernel/rebuild.ts";
import { bbox, edgeProps, oc, volume, type TopoDS_Shape } from "../src/kernel/occ.ts";
import { type NamedBody, namedEdges } from "../src/kernel/naming.ts";
import { deviation } from "../src/kernel/analysis.ts";
import { addFeature, newDocument, type NewFeature } from "../src/doc/io.ts";
import { dependents, moveFeature } from "../src/doc/features.ts";
import type { CadDocument, PlaneRef, TopoRef, Vec3 } from "../src/doc/types.ts";

before(initKernel);

const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const errors = (r: RebuildResult) => Object.entries(r.status).filter(([, s]) => s.state === "error").map(([id, s]) => `${id}: ${s.error}`);

function doc(...features: NewFeature[]): CadDocument {
  let d = newDocument();
  for (const f of features) d = addFeature(d, f).doc;
  return d;
}
const build = async (...features: NewFeature[]) => {
  const r = await new Engine().rebuild(doc(...features));
  assert.deepEqual(errors(r), []);
  return r;
};

function props(s: TopoDS_Shape, kind: "area" | "length"): number {
  const o = oc();
  const p = new o.GProp_GProps();
  if (kind === "area") o.BRepGProp.SurfaceProperties(s, p, false, false);
  else o.BRepGProp.LinearProperties(s, p, false, false);
  const v = p.Mass();
  p.delete();
  return v;
}
const area = (s: TopoDS_Shape) => props(s, "area");
const length = (s: TopoDS_Shape) => props(s, "length");

function lineSketch(x0: number, y0: number, x1: number, y1: number, plane?: PlaneRef) {
  const s = new SketchBuilder(plane);
  s.line(s.point(x0, y0, { fixed: true }), s.point(x1, y1, { fixed: true }));
  return s.build();
}
function block() {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 90, 50);
  return [s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }] as NewFeature[];
}
const pts = (...p: Vec3[]): NewFeature => ({ type: "curve", def: { kind: "points", points: p } });
const edgesWhere = (b: NamedBody, where: (m: Vec3) => boolean): TopoRef[] =>
  namedEdges(b).filter((e) => e.faces.length === 1 && where(edgeProps(e.edge).mid)).map((e) => ({ kind: "edge", name: e.name }));

test("curvas 3D: spline por pontos, hélice, projeção, interseção e composta", async () => {
  const r = await build(pts([0, 0, 0], [50, 20, 10], [100, 0, 0]));
  const c = r.ctx.curves.get("f1")!;
  assert.equal(c.edges[0].name, "f1:c0");
  assert.ok(length(c.shape) > 100 && length(c.shape) < 115);

  const h = await build({ type: "curve", def: { kind: "helix", axis: { kind: "std", name: "Z" }, radius: 10, pitch: 5, height: 20 } });
  near(length(h.ctx.curves.get("f1")!.shape), 4 * Math.hypot(2 * Math.PI * 10, 5), 2e-3);

  // círculo r=10 no XY projetado num plano a z = 30
  const c10 = new SketchBuilder();
  c10.circle(0, 0, 10);
  const p = await build(c10.build(), { type: "plane", base: { kind: "std", name: "XY" }, offset: 30 },
    { type: "curve", def: { kind: "projected", sketch: "f1", onto: { kind: "plane", plane: { kind: "datum", feature: "f2" } } } });
  near(length(p.ctx.curves.get("f3")!.shape), 2 * Math.PI * 10);
  near(bbox(p.ctx.curves.get("f3")!.shape).min[2], 30);

  // cilindro r=10 ∩ plano a z = 5 = círculo
  const i = await build(lineSketch(10, 0, 10, 20, { kind: "std", name: "XZ" }),
    { type: "surfaceRevolve", sketch: "f1", axis: { kind: "std", name: "Z" }, angle: 360 },
    { type: "plane", base: { kind: "std", name: "XY" }, offset: 5 },
    { type: "curve", def: { kind: "intersection", a: { kind: "sheet", sheet: "f2" }, b: { kind: "plane", plane: { kind: "datum", feature: "f3" } } } });
  near(length(i.ctx.curves.get("f4")!.shape), 2 * Math.PI * 10, 1e-3);

  // arestas de topo do bloco → contorno 2·(100+60)
  const top: TopoRef[] = ["l5", "l6", "l7", "l8"].map((l) => ({ kind: "edge", name: `{f2:end:l5&f2:side:${l}}` }));
  const k = await build(...block(), { type: "curve", def: { kind: "composite", edges: top } });
  near(length(k.ctx.curves.get("f3")!.shape), 320);
});

test("varrimento sólido ao longo de uma curva 3D", async () => {
  const c = new SketchBuilder();
  c.circle(0, 0, 5);
  const r = await build(c.build(), pts([0, 0, 0], [0, 0, 25], [0, 0, 50]), { type: "sweep", profile: "f1", path: "f2", op: "add" });
  near(volume(r.ctx.body!.shape).volume, Math.PI * 25 * 50, 1e-3);
});

test("superfície limite: 4 curvas planas, curva guia interior e só uma direção", async () => {
  const flat = await build(pts([0, 0, 0], [100, 0, 0]), pts([0, 50, 0], [100, 50, 0]), pts([0, 0, 0], [0, 50, 0]), pts([100, 0, 0], [100, 50, 0]),
    { type: "boundary", dir1: [{ kind: "curve", feature: "f1" }, { kind: "curve", feature: "f2" }], dir2: [{ kind: "curve", feature: "f3" }, { kind: "curve", feature: "f4" }] });
  near(area(flat.ctx.sheets.get("f5")!.shape), 5000, 1e-3);

  // limites em arco (z=10 a meio) e curva guia interior que sobe a 15 no centro
  const g = await build(pts([0, 0, 0], [100, 0, 0]), pts([0, 50, 0], [100, 50, 0]),
    pts([0, 0, 0], [0, 25, 10], [0, 50, 0]), pts([100, 0, 0], [100, 25, 10], [100, 50, 0]), pts([0, 25, 10], [50, 25, 15], [100, 25, 10]),
    { type: "boundary", dir1: [{ kind: "curve", feature: "f1" }, { kind: "curve", feature: "f5" }, { kind: "curve", feature: "f2" }], dir2: [{ kind: "curve", feature: "f3" }, { kind: "curve", feature: "f4" }] });
  const zmax = bbox(g.ctx.sheets.get("f6")!.shape).max[2];
  assert.ok(zmax > 14 && zmax < 16.5, `a guia interior é respeitada (z máx. ${zmax})`);

  const one = await build(pts([0, 0, 0], [100, 0, 0]), pts([0, 50, 30], [100, 50, 30]), { type: "boundary", dir1: [{ kind: "curve", feature: "f1" }, { kind: "curve", feature: "f2" }], dir2: [] });
  near(area(one.ctx.sheets.get("f3")!.shape), 100 * Math.hypot(50, 30), 1e-3);
});

test("superfície limite tangente a duas faixas: desvio de tangência verificado", async () => {
  // faixa A: z = 0, y ∈ [−20, 0]; faixa B: z = 10, y ∈ [50, 70]
  const base: NewFeature[] = [
    lineSketch(0, 0, 100, 0, { kind: "std", name: "XZ" }),
    { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    lineSketch(0, 10, 100, 10, { kind: "std", name: "XZ" }),
    { type: "surfaceExtrude", sketch: "f3", end: { type: "blind", depth: 20 }, flip: true },
    { type: "linearPattern", features: ["f4"], direction: { kind: "std", name: "Y" }, count: 2, spacing: 50 },
  ];
  const r0 = await build(...base);
  const a = r0.ctx.sheets.get("f2")!, b = r0.ctx.sheets.get("f5")!;
  const ea = edgesWhere(a, (m) => Math.abs(m[1]) < 1e-6 && Math.abs(m[0] - 50) < 1e-6);
  const eb = edgesWhere(b, (m) => Math.abs(m[1] - 50) < 1e-6 && Math.abs(m[0] - 50) < 1e-6);
  assert.equal(ea.length, 1); assert.equal(eb.length, 1);
  const mk = (cont1: "contact" | "tangent") => [...base, pts([0, 0, 0], [0, 50, 10]), pts([100, 0, 0], [100, 50, 10]),
    { type: "boundary", dir1: [{ kind: "edge", ref: ea[0] }, { kind: "edge", ref: eb[0] }], dir2: [{ kind: "curve", feature: "f6" }, { kind: "curve", feature: "f7" }], cont1 } as NewFeature];
  const flat = await build(...mk("contact"));
  near(area(flat.ctx.sheets.get("f8")!.shape), 100 * Math.hypot(50, 10), 1e-3);
  const t = await build(...mk("tangent"));
  const dev = t.status.f8.info?.rows.find((x) => x[0].startsWith("Desvio"))?.[1];
  assert.ok(dev && parseFloat(dev) < 1, `desvio de tangência ${dev}`);
  assert.ok(area(t.ctx.sheets.get("f8")!.shape) > 100 * Math.hypot(50, 10) * 1.001, "a superfície tangente curva-se (forma em S)");
  assert.deepEqual([...t.ctx.sheets.keys()].sort(), ["f2", "f4", "f5", "f8"], "o padrão da faixa é um corpo de superfície");
});

test("superfície regrada: normal, tangente e direção", async () => {
  const top: TopoRef[] = ["l5", "l6", "l7", "l8"].map((l) => ({ kind: "edge", name: `{f2:end:l5&f2:side:${l}}` }));
  const face: TopoRef = { kind: "face", name: "f2:end:l5" };
  const n = await build(...block(), { type: "ruled", edges: top, face, mode: "normal", distance: 10 });
  near(area(n.ctx.sheets.get("f3")!.shape), 320 * 10, 1e-3);
  near(bbox(n.ctx.sheets.get("f3")!.shape).max[2], 30, 1e-4);
  const t = await build(...block(), { type: "ruled", edges: top, face, mode: "tangent", distance: 10 });
  const tb = bbox(t.ctx.sheets.get("f3")!.shape);
  near(tb.max[0], 110, 1e-4); near(tb.min[1], -10, 1e-4); near(tb.max[2], 20, 1e-4);
  const d = await build(...block(), { type: "ruled", edges: top.slice(0, 1), mode: "direction", direction: { kind: "std", name: "Z" }, distance: 5 });
  assert.equal(d.ctx.sheets.get("f3")!.faces[0].name, `f3:rul{${top[0].name}}`);
});

test("desaparar: furo desaparece e o cilindro volta aos limites naturais", async () => {
  const s = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  s.circle(50, 30, 10);
  const r = await build(...block(), s.build(), { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" } },
    { type: "untrim", faces: [{ kind: "face", name: "f2:end:l5" }] });
  near(area(r.ctx.sheets.get("f5")!.shape), 100 * 60, 1e-4);
  const q = await build(lineSketch(10, 0, 10, 20, { kind: "std", name: "XZ" }),
    { type: "surfaceRevolve", sketch: "f1", axis: { kind: "std", name: "Z" }, angle: 90 },
    { type: "untrim", faces: [{ kind: "face", name: "f2:side:l3" }] });
  near(area(q.ctx.sheets.get("f3")!.shape), 2 * Math.PI * 10 * 20, 1e-4);
  assert.ok(!q.ctx.sheets.has("f2"), "a face desaparada sai do corpo de origem");
});

test("substituir face: estender e aparar o sólido até à superfície", async () => {
  for (const [z, vol] of [[30, 100 * 60 * 30], [10, 100 * 60 * 10]] as const) {
    const r = await build(...block(), lineSketch(-10, z, 110, z, { kind: "std", name: "XZ" }),
      { type: "surfaceExtrude", sketch: "f3", end: { type: "midplane", depth: 200 } },
      { type: "replaceFace", faces: [{ kind: "face", name: "f2:end:l5" }], sheet: "f4" });
    near(volume(r.ctx.body!.shape).volume, vol, 1e-4);
    assert.equal(r.ctx.sheets.size, 0);
  }
  // superfície que não cobre a face → erro claro
  const bad = await new Engine().rebuild(doc(...block(), lineSketch(20, 30, 40, 30, { kind: "std", name: "XZ" }),
    { type: "surfaceExtrude", sketch: "f3", end: { type: "midplane", depth: 200 } },
    { type: "replaceFace", faces: [{ kind: "face", name: "f2:end:l5" }], sheet: "f4" }));
  assert.match(bad.status.f5.error ?? "", /não atravessa/);
});

test("apagar e remendar mantém o sólido; aparar mútuo; padrão de superfície", async () => {
  const p = await build(...block(), { type: "deleteFace", faces: [{ kind: "face", name: "f2:end:l5" }], mode: "patch", continuity: "contact" });
  near(volume(p.ctx.body!.shape).volume, 100 * 60 * 20, 1e-4);
  assert.ok(p.ctx.body!.faces.some((f) => f.name === "f3:patch0"));
  assert.equal(p.ctx.sheets.size, 0);

  // parede A (y=0, x∈[0,100]) e parede B (x=50, y∈[−50,50]): fica o canto x<50 de A e y>0 de B
  const m = await build(lineSketch(0, 0, 100, 0), { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    lineSketch(50, -50, 50, 50), { type: "surfaceExtrude", sketch: "f3", end: { type: "blind", depth: 20 } },
    { type: "trimSurface", sheet: "f2", tool: { kind: "sheet", sheet: "f4" }, mutual: true, keep: [[20, 0, 10], [50, 30, 10]] });
  const sh = m.ctx.sheets.get("f2")!;
  near(area(sh.shape), 50 * 20 + 50 * 20, 1e-4);
  assert.ok(!m.ctx.sheets.has("f4"), "o aparar mútuo consome a ferramenta");
  assert.equal(namedEdges(sh).filter((e) => e.faces.length === 2).length, 1, "as duas partes ficam costuradas pelo canto");

  const pat = await build(lineSketch(0, 0, 100, 0), { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    { type: "linearPattern", features: ["f2"], direction: { kind: "std", name: "Y" }, count: 3, spacing: 30 });
  near(area(pat.ctx.sheets.get("f3")!.shape), 2 * 100 * 20, 1e-4);
});

test("análise de desvio: arestas tangentes (filete) vs. vivas", async () => {
  const r = await build(...block(), { type: "fillet", refs: [{ kind: "edge", name: "{f2:end:l5&f2:side:l5}" }], radius: 5 });
  const dev = deviation(r.ctx.body!);
  // as duas arestas de concordância do filete (com o topo e com a face lateral l5) são tangentes
  const fil = dev.edges.filter((e) => e.name.includes("fil") && (e.name.startsWith("{f2:end:l5&") || e.name.startsWith("{f2:side:l5&")));
  assert.ok(fil.length >= 2 && fil.every((e) => e.deg < 0.5), JSON.stringify(fil));
  assert.ok(dev.edges.some((e) => Math.abs(e.deg - 90) < 0.5), "há arestas vivas a 90°");
});

test("dependências: quem consome um corpo de superfície depende dos aparares anteriores", () => {
  const d = doc(lineSketch(-50, 0, 50, 0), { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 20 } },
    { type: "trimSurface", sheet: "f2", tool: { kind: "plane", plane: { kind: "std", name: "YZ" } }, keep: [[10, 0, 5]] },
    { type: "thicken", sheet: "f2", thickness: 2, side: "front", op: "add" });
  assert.ok(dependents(d, "f3").includes("f4"));
  assert.ok(Array.isArray(moveFeature(d, "f4", 2)), "não se pode pôr o espessar antes do aparar");
});
