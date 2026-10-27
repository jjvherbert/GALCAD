// Fase 4.1: superfícies ao estilo GSD — matemática pura (splines, Gordon, Hermite, círculos) e as
// features multi-secção, concordância, varrimento circular, extrapolar, curar, juntar e as opções
// avançadas de varrimento, com valores analíticos.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initKernel, SketchBuilder } from "./helpers.ts";
import { Engine, type RebuildResult } from "../src/kernel/rebuild.ts";
import { edgeProps, oc, vertexAt, distance, type TopoDS_Shape } from "../src/kernel/occ.ts";
import { namedEdges } from "../src/kernel/naming.ts";
import { addFeature, newDocument, type NewFeature } from "../src/doc/io.ts";
import { dependents } from "../src/doc/features.ts";
import type { CadDocument, CurveRef, Vec3 } from "../src/doc/types.ts";
import { Spline, arcRadius, bezierDeriv, circle3, gordonGrid, hermitePoles, reparam, resample } from "../src/geom/spline.ts";

before(initKernel);

const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const nearV = (a: Vec3, b: Vec3, tol = 1e-6) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol, `${a} ≉ ${b}`);
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
const line = (a: Vec3, b: Vec3): NewFeature => ({ type: "curve", def: { kind: "points", points: [a, b] } });
const pts = (...p: Vec3[]): NewFeature => ({ type: "curve", def: { kind: "points", points: p } });
const cv = (id: string): CurveRef => ({ kind: "curve", feature: id });
const info = (r: RebuildResult, id: string) => Object.fromEntries(r.status[id].info?.rows ?? []);
const deg = (s: string) => Number(s.replace("°", ""));

// ---------------------------------------------------------------------------
// matemática pura
// ---------------------------------------------------------------------------

test("spline: reproduz uma cúbica com tangentes impostas, linha natural e círculo periódico", () => {
  const xs = [0, 1, 2, 3, 4];
  const sp = new Spline(xs, xs.map((x) => [x, x ** 3, 0] as Vec3), { kind: "clamped", d: [1, 0, 0] }, { kind: "clamped", d: [1, 48, 0] });
  nearV(sp.eval(2.5), [2.5, 15.625, 0], 1e-9);
  nearV(sp.eval(1.5, 1), [1, 3 * 1.5 ** 2, 0], 1e-9);
  const lin = new Spline([0, 2, 5], [[0, 0, 0], [2, 4, 0], [5, 10, 0]]);
  nearV(lin.eval(3.3), [3.3, 6.6, 0], 1e-12);
  const n = 24;
  const t = Array.from({ length: n + 1 }, (_, i) => i / n);
  const circ = new Spline(t, t.map((u) => [Math.cos(2 * Math.PI * u), Math.sin(2 * Math.PI * u), 0] as Vec3), undefined, undefined, true);
  for (const u of [0.013, 0.5, 0.77]) near(Math.hypot(...circ.eval(u)), 1, 1e-4);
  // C2 no fecho
  nearV(circ.eval(0, 2), circ.eval(1, 2), 1e-9);
});

test("reamostragem e reparametrização por comprimento de arco", () => {
  const p = resample([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 5);
  nearV(p[2], [10, 0, 0]);
  nearV(p[3], [10, 5, 0]);
  // o ponto a 1/4 do comprimento passa para meio
  const q = reparam([[0, 0, 0], [8, 0, 0]], [0, 0.25, 1], [0, 0.5, 1], 5);
  nearV(q[2], [2, 0, 0]);
});

test("Gordon: reproduz um paraboloide a partir de 3 secções e 3 guias", () => {
  const S = (u: number, v: number): Vec3 => [100 * u, 100 * v, 30 * (u - 0.5) ** 2 + 20 * (v - 0.5) ** 2];
  const nu = 41, nv = 41;
  const uG = [0, 0.5, 1], vS = [0, 0.5, 1];
  const sections = vS.map((v) => Array.from({ length: nu }, (_, i) => S(i / (nu - 1), v)));
  const guides = uG.map((u) => Array.from({ length: nv }, (_, k) => S(u, k / (nv - 1))));
  const g = gordonGrid({ sections, guides, uG, vS });
  // passa exatamente pelas secções e guias; no interior é quadrática em u e v (interpolada por cúbicas)
  nearV(g[20][0], S(0.5, 0), 1e-9);
  nearV(g[0][13], S(0, 13 / 40), 1e-9);
  const p = g[10][30];
  assert.ok(Math.hypot(p[0] - S(0.25, 0.75)[0], p[1] - S(0.25, 0.75)[1], p[2] - S(0.25, 0.75)[2]) < 0.5);
});

test("Hermite G1/G2 e círculos", () => {
  const a = { p: [0, 0, 0] as Vec3, d: [30, 0, 0] as Vec3, dd: [0, 0, 5] as Vec3 };
  const b = { p: [100, 0, 20] as Vec3, d: [30, 0, 0] as Vec3, dd: [0, 0, -5] as Vec3 };
  const q = hermitePoles(a, b);
  assert.equal(q.length, 6);
  nearV(bezierDeriv(q, 0, 1), a.d, 1e-9);
  nearV(bezierDeriv(q, 0, 2), a.dd, 1e-9);
  nearV(bezierDeriv(q, 1, 1), b.d, 1e-9);
  nearV(bezierDeriv(q, 1, 2), b.dd, 1e-9);
  const c = circle3([10, 0, 0], [0, 10, 0], [-10, 0, 0])!;
  nearV(c.c, [0, 0, 0], 1e-9);
  near(c.r, 10, 1e-12);
  const arc = arcRadius([30, 0, 0], [-30, 0, 0], 50, [0, 0, 1], 9)!;
  for (const p of arc) near(Math.hypot(p[0], p[1] - (arc[4][1] > 0 ? -40 : 40)), 50, 1e-9);
});

// ---------------------------------------------------------------------------
// features
// ---------------------------------------------------------------------------

test("multi-secção: sem guias (loft) e com guias (Gordon) reproduzem um meio cilindro", async () => {
  const semi = (z: number): NewFeature => pts(...Array.from({ length: 9 }, (_, i) => { const a = (Math.PI * i) / 8; return [50 * Math.cos(a), 50 * Math.sin(a), z] as Vec3; }));
  const r1 = await build(semi(0), semi(100), { type: "multiSection", sections: [cv("f1"), cv("f2")] });
  near(area(r1.ctx.sheets.get("f3")!.shape), Math.PI * 50 * 100, 2e-3);
  // com guias nas pontas e no topo (Gordon); as secções em sentidos opostos são alinhadas
  const flipped: NewFeature = pts(...Array.from({ length: 9 }, (_, i) => { const a = Math.PI - (Math.PI * i) / 8; return [50 * Math.cos(a), 50 * Math.sin(a), 100] as Vec3; }));
  const r2 = await build(semi(0), flipped, line([50, 0, 0], [50, 0, 100]), line([-50, 0, 0], [-50, 0, 100]), line([0, 50, 0], [0, 50, 100]),
    { type: "multiSection", sections: [cv("f1"), cv("f2")], guides: [cv("f3"), cv("f4"), cv("f5")] });
  near(area(r2.ctx.sheets.get("f6")!.shape), Math.PI * 50 * 100, 2e-3);
  // uma guia curva obriga a superfície a passar por ela
  const r3 = await build(line([0, -50, 0], [0, 50, 0]), line([0, -50, 100], [0, 50, 100]), pts([0, 0, 0], [20, 0, 50], [0, 0, 100]),
    { type: "multiSection", sections: [cv("f1"), cv("f2")], guides: [cv("f3")] });
  const face = r3.ctx.sheets.get("f4")!.shape;
  assert.ok(distance(vertexAt([20, 0, 50]), face) < 1e-3);
  assert.ok(distance(vertexAt([0, 40, 50]), face) > 5); // longe da guia a superfície também curva (translação de Gordon)
});

test("multi-secção: tangência à face de suporte na primeira secção", async () => {
  // tira plana z = 0 (y 0…50); a multi-secção sai da aresta y = 50 tangente ao plano e sobe até z = 40
  const r = await build(line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    line([0, 100, 40], [100, 100, 40]),
    { type: "multiSection", sections: [cv("f2"), cv("f4")], startTangent: { face: { kind: "face", name: "f3:bnd" } } });
  const dev = deg(info(r, "f5")["Tangência na 1.ª secção"]);
  assert.ok(dev < 0.5, `desvio ${dev}`);
  assert.equal(r.status.f5.state, "ok");
});

test("concordância: G1 entre duas tiras coplanares é plana; G2 entre planos desfasados cumpre a tangência", async () => {
  const strips = (z2: number): NewFeature[] => [
    line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    line([0, 100, z2], [100, 100, z2]), line([0, 150, z2], [100, 150, z2]), { type: "boundary", dir1: [cv("f4"), cv("f5")], dir2: [] },
  ];
  const side = (curve: string, face: string, continuity: "tangent" | "curvature") => ({ curve: cv(curve), support: { kind: "face" as const, name: face }, continuity });
  const r = await build(...strips(0), { type: "blend", side1: side("f2", "f3:bnd", "tangent"), side2: side("f4", "f6:bnd", "tangent") });
  near(area(r.ctx.sheets.get("f7")!.shape), 100 * 50, 1e-4);
  const r2 = await build(...strips(40), { type: "blend", side1: side("f2", "f3:bnd", "curvature"), side2: side("f4", "f6:bnd", "curvature") });
  const i = info(r2, "f7");
  assert.ok(deg(i["Tangência no lado 1"]) < 0.5 && deg(i["Tangência no lado 2"]) < 0.5, JSON.stringify(i));
  // tensão maior → superfície mais longa
  const r3 = await build(...strips(40), { type: "blend", side1: { ...side("f2", "f3:bnd", "tangent"), tension: 2 }, side2: { ...side("f4", "f6:bnd", "tangent"), tension: 2 } });
  assert.ok(area(r3.ctx.sheets.get("f7")!.shape) > area(r2.ctx.sheets.get("f7")!.shape));
});

test("varrimento circular: 3 guias, 2 guias + raio e tubo", async () => {
  const r = await build(line([30, 0, 0], [30, 0, 100]), line([0, 30, 0], [0, 30, 100]), line([-30, 0, 0], [-30, 0, 100]),
    { type: "circleSweep", mode: "threeGuides", guides: [cv("f1"), cv("f2"), cv("f3")] });
  near(area(r.ctx.sheets.get("f4")!.shape), Math.PI * 30 * 100, 2e-3);
  const r2 = await build(line([30, 0, 0], [30, 0, 100]), line([-30, 0, 0], [-30, 0, 100]),
    { type: "circleSweep", mode: "twoGuidesRadius", guides: [cv("f1"), cv("f2")], radius: 50 });
  near(area(r2.ctx.sheets.get("f3")!.shape), 50 * 2 * Math.asin(0.6) * 100, 2e-3);
  const r3 = await build(line([0, 0, 0], [0, 0, 100]), { type: "circleSweep", mode: "centerRadius", guides: [cv("f1")], radius: 5 });
  near(area(r3.ctx.sheets.get("f2")!.shape), 2 * Math.PI * 5 * 100, 1e-4);
  const bad = await new Engine().rebuild(doc(line([30, 0, 0], [30, 0, 100]), line([-30, 0, 0], [-30, 0, 100]),
    { type: "circleSweep", mode: "twoGuidesRadius", guides: [cv("f1"), cv("f2")], radius: 20 }));
  assert.match(bad.status.f3.error ?? "", /2 × raio/);
});

test("extrapolar: tangente numa tira plana e em curvatura num cilindro", async () => {
  const r0 = await build(line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] });
  const sheet = r0.ctx.sheets.get("f3")!;
  const e50 = namedEdges(sheet).find((e) => e.faces.length === 1 && Math.abs(edgeProps(e.edge).mid[1] - 50) < 1e-6)!;
  const r = await build(line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    { type: "extrapolate", sheet: "f3", edges: [{ kind: "edge", name: e50.name }], length: 30, continuity: "tangent" });
  const ext = r.ctx.sheets.get("f3")!;
  near(area(ext.shape), 100 * 80, 1e-4);
  assert.equal(ext.faces.length, 2);
  assert.ok(ext.faces.some((x) => x.name === `f4:ext{${e50.name}}`));
  // a feature seguinte que usa f3 depende da extrapolação
  const d = doc(line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    { type: "extrapolate", sheet: "f3", edges: [{ kind: "edge", name: e50.name }], length: 30, continuity: "tangent" },
    { type: "thicken", sheet: "f3", thickness: 1, side: "front", op: "add" });
  assert.ok(dependents(d, "f4").includes("f5"));

  // meio cilindro r = 20, altura 40 (revolução de uma reta); prolongar as arestas retas 10 mm em curvatura
  const s = new SketchBuilder({ kind: "std", name: "XZ" });
  s.line(s.point(20, 0, { fixed: true }), s.point(20, 40, { fixed: true }));
  const c0 = await build(s.build(), { type: "surfaceRevolve", sketch: "f1", axis: { kind: "std", name: "Z" }, angle: 180 });
  const straight = namedEdges(c0.ctx.sheets.get("f2")!).filter((e) => e.faces.length === 1 && edgeProps(e.edge).type === "line");
  assert.equal(straight.length, 2);
  const c = await build(s.build(), { type: "surfaceRevolve", sketch: "f1", axis: { kind: "std", name: "Z" }, angle: 180 },
    { type: "extrapolate", sheet: "f2", edges: straight.map((e) => ({ kind: "edge" as const, name: e.name })), length: 10, continuity: "curvature" });
  const rows = info(c, "f3");
  for (const v of Object.values(rows)) assert.ok(deg(v) < 0.5, JSON.stringify(rows));
  near(area(c.ctx.sheets.get("f2")!.shape), Math.PI * 20 * 40 + 2 * 10 * 40, 5e-3);
});

test("curar: fecha uma folga de 0,05 mm; juntar com verificação de ligação", async () => {
  const strips: NewFeature[] = [
    line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    line([0, 50.05, 0], [100, 50.05, 0]), line([0, 100, 0], [100, 100, 0]), { type: "boundary", dir1: [cv("f4"), cv("f5")], dir2: [] },
  ];
  const r = await build(...strips, { type: "heal", sheets: ["f3", "f6"], distance: 0.1, simplify: false });
  const i = info(r, "f7");
  assert.equal(i["Arestas livres antes"], "8");
  assert.equal(i["Arestas livres depois"], "6");
  assert.equal(i["Partes ligadas"], "1");
  const j = await new Engine().rebuild(doc(...strips, { type: "knit", sheets: ["f3", "f6"], tolerance: 0.01, checkConnected: true }));
  assert.match(j.status.f7.error ?? "", /2 partes desligadas/);
  // juntar e simplificar: as duas faces coplanares unem-se numa só
  const k = await build(...strips, { type: "knit", sheets: ["f3", "f6"], tolerance: 0.1, simplify: true });
  assert.equal(k.ctx.sheets.get("f7")!.faces.length, 1);
});

test("varrimento: lei de escala linear (tronco de cone) e orientação por binormal", async () => {
  const prof = new SketchBuilder({ kind: "std", name: "XY" });
  prof.circle(0, 0, 10);
  const r = await build(prof.build(), line([0, 0, 0], [0, 0, 100]), { type: "surfaceSweep", profile: "f1", path: "f2", orientation: "fixed", scale: 2 });
  near(area(r.ctx.sheets.get("f3")!.shape), Math.PI * (10 + 20) * Math.hypot(100, 10), 2e-3);
  const r2 = await build(prof.build(), pts([0, 0, 0], [0, 30, 50], [0, 0, 100]), { type: "surfaceSweep", profile: "f1", path: "f2", orientation: "binormal", binormal: { kind: "std", name: "X" } });
  assert.ok(area(r2.ctx.sheets.get("f3")!.shape) > 2 * Math.PI * 10 * 100);
});

test("curva prolongada e regrada a um ângulo", async () => {
  const r = await build(line([0, 0, 0], [100, 0, 0]), { type: "curve", def: { kind: "extend", curve: cv("f1"), start: 10, end: 20 } });
  near(length(r.ctx.curves.get("f2")!.shape), 130, 1e-6);
  // arco r=50 (quarto de círculo) prolongado 10 mm em curvatura: comprimento ≈ arco + 10
  const arc = pts(...Array.from({ length: 9 }, (_, i) => { const a = (Math.PI / 2) * (i / 8); return [50 * Math.cos(a), 50 * Math.sin(a), 0] as Vec3; }));
  const r2 = await build(arc, { type: "curve", def: { kind: "extend", curve: cv("f1"), end: 10, continuity: "curvature" } });
  near(length(r2.ctx.curves.get("f2")!.shape), (Math.PI / 2) * 50 + 10, 2e-3);
  // regrada a 30° de uma tira plana: a aresta oposta fica a d·sin 30° de altura
  const s = await build(line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] });
  const e = namedEdges(s.ctx.sheets.get("f3")!).find((x) => x.faces.length === 1 && Math.abs(edgeProps(x.edge).mid[1] - 50) < 1e-6)!;
  const g = await build(line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    { type: "ruled", edges: [{ kind: "edge", name: e.name }], mode: "angle", angle: 30, distance: 20 });
  const top = namedEdges(g.ctx.sheets.get("f4")!).map((x) => edgeProps(x.edge).mid[2]);
  near(Math.max(...top.map(Math.abs)), 10, 1e-6);
});

// ---------------------------------------------------------------------------
// Fase 4.2: análises de classe A
// ---------------------------------------------------------------------------

test("continuidade: filete (G1), arestas vivas (G0) e concordância G2 costurada", async () => {
  const { continuity, combs } = await import("../src/kernel/analysis.ts");
  const { sceneOf } = await import("../src/kernel/service.ts");
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 100, 60);
  const b0 = await build(s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } });
  const top = namedEdges(b0.ctx.body!).filter((e) => Math.abs(edgeProps(e.edge).mid[2] - 20) < 1e-6).map((e) => ({ kind: "edge" as const, name: e.name }));
  const r = await build(s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }, { type: "fillet", refs: top, radius: 5 });
  const c = continuity(r.ctx.body!);
  const cls = (want: number) => c.edges.filter((e) => e.cls === want).length;
  // 4 arestas de topo arredondadas = 8 arestas tangentes (G1: a curvatura salta de 0 para 1/5) e 4 cantos esféricos
  assert.ok(cls(1) >= 8, JSON.stringify(c.edges.map((e) => e.cls)));
  assert.ok(cls(0) >= 4); // arestas verticais e de base
  assert.equal(cls(-1), 0);

  // concordância G2 entre tiras desfasadas, costurada: as costuras são pelo menos G2
  const strips: NewFeature[] = [
    line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
    line([0, 100, 40], [100, 100, 40]), line([0, 150, 40], [100, 150, 40]), { type: "boundary", dir1: [cv("f4"), cv("f5")], dir2: [] },
  ];
  const side = (curve: string, face: string) => ({ curve: cv(curve), support: { kind: "face" as const, name: face }, continuity: "curvature" as const });
  const k = await build(...strips, { type: "blend", side1: side("f2", "f3:bnd"), side2: side("f4", "f6:bnd") },
    { type: "knit", sheets: ["f3", "f6", "f7"], tolerance: 0.01 });
  const ck = continuity(k.ctx.sheets.get("f8")!);
  assert.equal(ck.edges.length, 2);
  for (const e of ck.edges) assert.ok(e.cls >= 2, JSON.stringify(e));

  // pentes de curvatura de uma circunferência r = 20: curvatura 1/20 em todas as cerdas
  const circ = new SketchBuilder();
  circ.circle(0, 0, 20);
  const cr = await build(circ.build(), { type: "surfaceExtrude", sketch: "f1", end: { type: "blind", depth: 10 } });
  const { scene } = sceneOf(cr.ctx);
  const cb = combs(scene, []);
  near(cb.maxK, 1 / 20, 1e-6);
  assert.ok(cb.edges >= 2 && cb.quills.length > 0);
  near(cb.scale * cb.maxK, 0.15 * Math.hypot(40, 40, 10), 1e-6);
});

// ---------------------------------------------------------------------------
// Fase 4.3: forma livre (polos NURBS)
// ---------------------------------------------------------------------------

test("forma livre: patch plano, polo central deslocado, rede no relatório e conversão de face", async () => {
  const { bbox } = await import("../src/kernel/occ.ts");
  const patch = (moves: { i: number; j: number; d: Vec3 }[], width = 100): NewFeature =>
    ({ type: "freeform", source: { kind: "patch", plane: { kind: "std", name: "XY" }, width, height: 100, nu: 5, nv: 5 }, moves });
  const r0 = await build(patch([]));
  near(area(r0.ctx.sheets.get("f1")!.shape), 10000, 1e-6);
  const net0 = r0.status.f1.net!;
  assert.equal(net0.nu * net0.nv, 25);
  nearV(net0.poles.slice(12 * 3, 12 * 3 + 3) as Vec3, [0, 0, 0]);

  const r = await build(patch([{ i: 2, j: 2, d: [0, 0, 20] }]));
  const net = r.status.f1.net!;
  nearV(net.poles.slice(12 * 3, 12 * 3 + 3) as Vec3, [0, 0, 20]);
  // cúbica clamped com nós (0,0,0,0,½,1,1,1,1): N₂(½) = ½ → altura no centro = 20·½·½ = 5
  assert.ok(distance(vertexAt([0, 0, 5]), r.ctx.sheets.get("f1")!.shape) < 1e-6);
  assert.ok(bbox(r.ctx.sheets.get("f1")!.shape).max[2] <= 5 + 1e-6);
  assert.ok(area(r.ctx.sheets.get("f1")!.shape) > 10000);
  // paramétrico: com outra largura o deslocamento mantém-se no mesmo polo
  const r2 = await build(patch([{ i: 2, j: 2, d: [0, 0, 20] }], 200));
  assert.ok(distance(vertexAt([0, 0, 5]), r2.ctx.sheets.get("f1")!.shape) < 1e-6);
  near(bbox(r2.ctx.sheets.get("f1")!.shape).max[0], 100, 1e-6);
  // polo inexistente → aviso
  const r3 = await build(patch([{ i: 7, j: 0, d: [0, 0, 1] }]));
  assert.equal(r3.status.f1.state, "warning");

  // converter a face de topo de um bloco (cópia; o sólido fica igual)
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 100, 60);
  const blk = await build(s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } });
  const topFace = blk.ctx.body!.faces.find((x) => x.name.includes(":end"))!;
  const c = await build(s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    { type: "freeform", source: { kind: "face", face: { kind: "face", name: topFace.name }, nu: 4, nv: 4 }, moves: [{ i: 1, j: 1, d: [0, 0, 5] }] });
  near(area(c.ctx.sheets.get("f3")!.shape) > 6000 ? 1 : 0, 1);
  assert.equal(c.ctx.body!.faces.length, 6);
  assert.ok(c.status.f3.net!.nu >= 4); // a interpolação cúbica da grelha 4 × 4 dá n + 2 polos
});
