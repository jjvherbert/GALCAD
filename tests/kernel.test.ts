import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine, type RebuildResult } from "../src/kernel/rebuild.ts";
import { volume } from "../src/kernel/occ.ts";
import { namedEdges } from "../src/kernel/naming.ts";
import { addFeature, newDocument, updateFeature, type NewFeature } from "../src/doc/io.ts";
import type { CadDocument, Feature, SketchFeature } from "../src/doc/types.ts";

before(initKernel);

const vol = (r: RebuildResult) => (r.ctx.body ? volume(r.ctx.body.shape).volume : 0);
const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const errors = (r: RebuildResult) => Object.entries(r.status).filter(([, s]) => s.state === "error").map(([id, s]) => `${id}: ${s.error}`);

function doc(...features: NewFeature[]): { doc: CadDocument; ids: string[] } {
  let d = newDocument();
  const ids: string[] = [];
  for (const f of features) { const r = addFeature(d, f); d = r.doc; ids.push(r.id); }
  return { doc: d, ids };
}

/** Bloco 100×60×20 com o esboço no XY. */
function block(w: number | string = 100) {
  const s = new SketchBuilder();
  const r = s.rect(0, 0, w, 60, 90, 50);
  return { sketch: s.build(), lines: r.lines };
}

test("extrusão: volume, nomes das faces e cache", async () => {
  const b = block();
  const { doc: d } = doc(b.sketch, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } });
  const e = new Engine();
  const r = await e.rebuild(d);
  assert.deepEqual(errors(r), []);
  near(vol(r), 100 * 60 * 20);
  const names = r.ctx.body!.faces.map((f) => f.name).sort();
  assert.deepEqual(names, ["f2:end:l5", "f2:side:l5", "f2:side:l6", "f2:side:l7", "f2:side:l8", "f2:start:l5"]);
  assert.equal(r.ctx.sketches.get("f1")!.solve.dof, 0);
  const again = await e.rebuild(d);
  assert.equal(again.reused, 2);
});

test("corte, filete e estabilidade dos nomes ao editar a cota", async () => {
  const b = block("W");
  const top = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  const c = top.circle(50, 30, 10);
  top.constrain("radius", [c], 8);
  const { doc: d0 } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    top.build(),
    { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" } },
    { type: "fillet", refs: [{ kind: "edge", name: "{f2:end:l5&f2:side:l5}" }, { kind: "face", name: "f2:side:l6" }], radius: 3 },
  );
  const d = { ...d0, variables: [{ name: "W", expr: "100" }] };
  const e = new Engine();
  const r1 = await e.rebuild(d);
  assert.deepEqual(errors(r1), []);
  const v1 = vol(r1);
  assert.ok(v1 < 100 * 60 * 20 - Math.PI * 64 * 20 + 1);
  assert.ok(r1.ctx.body!.faces.some((f) => f.name.startsWith("f5:fil{")));
  assert.ok(r1.ctx.body!.faces.some((f) => f.name === "f4:side:c2"));

  // mudar a largura por variável: as mesmas arestas continuam a ser encontradas pelo nome
  const r2 = await e.rebuild({ ...d, variables: [{ name: "W", expr: "140" }] });
  assert.deepEqual(errors(r2), []);
  assert.ok(vol(r2) > v1);
  assert.deepEqual(r2.status.f5.warnings, []);
  assert.equal(r2.reused, 0);
});

test("referências sobrevivem a uma face dividida a montante", async () => {
  const b = block();
  // ranhura que divide a face lateral l5 (y = 0) em duas
  const slot = new SketchBuilder({ kind: "std", name: "XZ" });
  slot.rect(40, 10, 20, 30, 20, 30);
  const { doc: d } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    slot.build(),
    { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" }, end2: { type: "throughAll" } },
    { type: "fillet", refs: [{ kind: "edge", name: "{f2:end:l5&f2:side:l5}" }], radius: 2 },
  );
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  // a aresta foi dividida pelo corte: o filete aplica-se às duas partes
  assert.equal(r.ctx.body!.faces.filter((f) => f.name.startsWith("f5:fil")).length, 2);
});

test("revolução: anel com volume de Pappus", async () => {
  const s = new SketchBuilder({ kind: "std", name: "XZ" });
  s.rect(30, 0, 10, 20, 10, 20);
  const axis = s.line(s.point(0, 0, { fixed: true }), s.point(0, 50, { fixed: true }), true);
  const { doc: d } = doc(s.build(), { type: "revolve", sketch: "f1", axis: { kind: "sketchLine", sketch: "f1", entity: axis }, op: "add", angle: 360 });
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  near(vol(r), 2 * Math.PI * 35 * 10 * 20);
  const half = await new Engine().rebuild(updateFeature(d, "f2", { angle: 90, midplane: true } as Partial<Feature>));
  near(vol(half), (2 * Math.PI * 35 * 10 * 20) / 4);
});

test("furos: roscado cego e de passagem com rebaixo", async () => {
  const b = block();
  const top = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  top.point(20, 20); top.point(80, 20);
  const top2 = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  top2.point(50, 45);
  const { doc: d } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    top.build(),
    { type: "hole", sketch: "f3", kind: "tapped", size: "M6", end: { type: "blind", depth: 12 }, threadDepth: 10 },
    top2.build(),
    { type: "hole", sketch: "f5", kind: "clearance", size: "M8", fit: "normal", head: "counterbore", end: { type: "throughAll" } },
  );
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  const drill = 2 * (Math.PI * 2.5 ** 2 * 12 + (Math.PI * 2.5 ** 2 * (2.5 / Math.tan((59 * Math.PI) / 180))) / 3);
  const cb = Math.PI * 4.5 ** 2 * (20 - 8.6) + Math.PI * 7.5 ** 2 * 8.6;
  near(vol(r), 100 * 60 * 20 - drill - cb, 1e-4);
  assert.ok(r.status.f4.info!.rows.some(([k, v]) => k === "Rosca (cosmética)" && v.startsWith("M6")));
  assert.ok(r.ctx.body!.faces.some((f) => f.name === "f6:p1:cbfloor"));
});

test("casca e inclinação", async () => {
  const b = block();
  const { doc: d } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    { type: "shell", faces: [{ kind: "face", name: "f2:end:l5" }], thickness: 2 },
  );
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  near(vol(r), 100 * 60 * 20 - 96 * 56 * 18);
  const { doc: d2 } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    { type: "draft", faces: [{ kind: "face", name: "f2:side:l5" }, { kind: "face", name: "f2:side:l7" }], neutral: { kind: "std", name: "XY" }, angle: 5 },
  );
  const r2 = await new Engine().rebuild(d2);
  assert.deepEqual(errors(r2), []);
  const cut = 2 * (0.5 * 20 * 20 * Math.tan((5 * Math.PI) / 180)) * 100;
  near(vol(r2), 100 * 60 * 20 - cut, 1e-3);
});

test("padrões linear e circular, e espelho", async () => {
  const b = block();
  const top = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  top.circle(15, 15, 5);
  const { doc: d } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    top.build(),
    { type: "extrude", sketch: "f3", op: "cut", end: { type: "blind", depth: 5 } },
    { type: "linearPattern", features: ["f4"], direction: { kind: "std", name: "X" }, count: 4, spacing: 20, direction2: { kind: "std", name: "Y" }, count2: 2, spacing2: 30 },
    { type: "plane", base: { kind: "std", name: "YZ" }, offset: 50 },
    { type: "mirror", features: ["f4"], plane: { kind: "datum", feature: "f6" } },
  );
  const r = await new Engine().rebuild({ ...d, rollback: 5 });
  assert.deepEqual(errors(r), []);
  near(vol(r), 100 * 60 * 20 - 8 * Math.PI * 25 * 5);
  // espelho do corte original no plano x = 50: mais um furo em x = 85
  const r2 = await new Engine().rebuild(d);
  assert.deepEqual(errors(r2), []);
  near(vol(r2), 100 * 60 * 20 - 9 * Math.PI * 25 * 5);

  const disc = new SketchBuilder();
  disc.circle(0, 0, 50);
  const holes = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:c2" } });
  holes.circle(35, 0, 4);
  const { doc: d3 } = doc(
    disc.build(),
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } },
    holes.build(),
    { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" } },
    { type: "circularPattern", features: ["f4"], axis: { kind: "std", name: "Z" }, count: 6, angle: 360 },
  );
  const r3 = await new Engine().rebuild(d3);
  assert.deepEqual(errors(r3), []);
  near(vol(r3), Math.PI * 2500 * 10 - 6 * Math.PI * 16 * 10);
});

test("loft, varrimento e nervura", async () => {
  const s1 = new SketchBuilder();
  s1.rect(-20, -20, 40, 40, 40, 40);
  const s2 = new SketchBuilder({ kind: "datum", feature: "f2" });
  s2.circle(0, 0, 10);
  const { doc: d } = doc(
    s1.build(),
    { type: "plane", base: { kind: "std", name: "XY" }, offset: 30 },
    s2.build(),
    { type: "loft", sections: ["f1", "f3"], op: "add", ruled: true },
  );
  const r = await new Engine().rebuild(d);
  assert.deepEqual(errors(r), []);
  assert.ok(vol(r) > Math.PI * 100 * 30 && vol(r) < 1600 * 30);

  const profile = new SketchBuilder({ kind: "std", name: "XZ" });
  profile.circle(0, 0, 3);
  const path = new SketchBuilder();
  const a = path.point(0, 0), b = path.point(0, 50);
  path.line(a, b);
  const { doc: d2 } = doc(profile.build(), path.build(), { type: "sweep", profile: "f1", path: "f2", op: "add" });
  const r2 = await new Engine().rebuild(d2);
  assert.deepEqual(errors(r2), []);
  near(vol(r2), Math.PI * 9 * 50, 1e-3);

  // nervura num L: base 100×10 e parede vertical 10×60, nervura diagonal no plano XZ a meio
  const L = new SketchBuilder({ kind: "std", name: "XZ" });
  const p = [L.point(0, 0), L.point(100, 0), L.point(100, 10), L.point(10, 10), L.point(10, 60), L.point(0, 60)];
  p.forEach((x, i) => L.line(x, p[(i + 1) % p.length]));
  const R = new SketchBuilder({ kind: "datum", feature: "f3" });
  R.line(R.point(10, 40), R.point(70, 10));
  const { doc: d3 } = doc(
    L.build(),
    { type: "extrude", sketch: "f1", op: "add", end: { type: "midplane", depth: 40 } },
    { type: "plane", base: { kind: "std", name: "XZ" }, offset: 0 },
    R.build(),
    { type: "rib", sketch: "f4", thickness: 4 },
  );
  const r3 = await new Engine().rebuild(d3);
  assert.deepEqual(errors(r3), []);
  near(vol(r3), (100 * 10 + 10 * 50) * 40 + 0.5 * 60 * 30 * 4, 1e-3);
});

test("rollback, supressão e erros não bloqueiam as features seguintes", async () => {
  const b = block();
  const { doc: d } = doc(
    b.sketch,
    { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } },
    { type: "fillet", refs: [{ kind: "edge", name: "{inexistente}" }], radius: 2 },
    { type: "chamfer", refs: [{ kind: "edge", name: "{f2:end:l5&f2:side:l5}" }], distance: 2 },
  );
  const r = await new Engine().rebuild(d);
  assert.equal(r.status.f3.state, "error");
  assert.equal(r.status.f4.state, "ok");
  near(vol(r), 100 * 60 * 20 - 0.5 * 2 * 2 * 100);
  const sup = await new Engine().rebuild(updateFeature(d, "f4", { suppressed: true }));
  near(vol(sup), 100 * 60 * 20);
  const rb = await new Engine().rebuild({ ...d, rollback: 1 });
  assert.equal(rb.ctx.body, null);
  assert.equal(rb.status.f2.state, "rolledBack");
});

test("nomes de arestas únicos", async () => {
  const b = block();
  const { doc: d } = doc(b.sketch, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } });
  const r = await new Engine().rebuild(d);
  const es = namedEdges(r.ctx.body!);
  assert.equal(es.length, 12);
  assert.equal(new Set(es.map((e) => e.name)).size, 12);
});

export type { SketchFeature };

