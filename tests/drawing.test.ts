// Desenhos: vistas por HLR, projeções no 1.º/3.º diedro, corte, pormenor, auxiliar, centros e cotas do modelo.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { projectedFrame, stdFrame } from "../src/kernel/drawing.ts";
import { addFeature } from "../src/doc/io.ts";
import { type CadProject, type DrawingDoc, newDrawing, newPart } from "../src/doc/project.ts";
import { curvePoints } from "../src/drawing/geom2d.ts";
import type { Vec3 } from "../src/doc/types.ts";

before(initKernel);
const near = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

/** Bloco 100×60×20 com furo passante ⌀20 no centro. */
function project(): CadProject {
  const pr: CadProject = { format: "cadp-project", version: 1, name: "T", parts: [], assemblies: [], drawings: [] };
  let p = newPart(pr, "Bloco");
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 100, 60);
  p = { ...p, ...addFeature(p, s.build()).doc };
  p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }).doc };
  const h = new SketchBuilder({ kind: "face", ref: { kind: "face", name: "f2:end:l5" } });
  const c = h.circle(50, 30, 10);
  h.constrain("diameter", [c], 20);
  p = { ...p, ...addFeature(p, h.build()).doc };
  p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" } }).doc };
  pr.parts.push(p);
  return pr;
}

function drawing(pr: CadProject, views: DrawingDoc["views"]): CadProject {
  const d = newDrawing(pr);
  d.views = views;
  return { ...pr, drawings: [d] };
}

const triArea = (t: number[]) => { let a = 0; for (let i = 0; i < t.length; i += 6) a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2; return a; };

test("referenciais: vistas padrão direitas e projeções nos dois diedros", () => {
  for (const v of ["front", "back", "top", "bottom", "left", "right", "iso"] as const) {
    const f = stdFrame(v);
    const c = [f.x[1] * f.y[2] - f.x[2] * f.y[1], f.x[2] * f.y[0] - f.x[0] * f.y[2], f.x[0] * f.y[1] - f.x[1] * f.y[0]];
    c.forEach((x, i) => near(x, f.z[i], 1e-9));
  }
  const front = stdFrame("front");
  // 1.º diedro: por baixo da frente fica a vista de cima; 3.º diedro: por cima
  assert.deepEqual(projectedFrame(front, "below", "first").z.map((x) => Math.round(x) + 0), [0, 0, 1]);
  assert.deepEqual(projectedFrame(front, "above", "third").z.map((x) => Math.round(x) + 0), [0, 0, 1]);
  // 1.º diedro: à direita fica a vista da esquerda
  assert.deepEqual(projectedFrame(front, "right", "first").z.map((x) => Math.round(x) + 0), [-1, 0, 0]);
  assert.deepEqual(projectedFrame(front, "right", "third").z.map((x) => Math.round(x) + 0), [1, 0, 0]);
});

test("vistas de frente e de cima: contorno, linhas ocultas do furo, marca e linha de centro, cotas do modelo", async () => {
  const pr = drawing(project(), [
    { id: "v1", name: "Frente", kind: "model", source: { kind: "part", id: "p1" }, orientation: "front", at: [100, 150] },
    { id: "v2", name: "Cima", kind: "projected", parent: "v1", side: "below", at: [100, 60] },
  ]);
  const r = await new KernelService().drawing(pr, pr.drawings[0].id);
  const f = r.views.v1, t = r.views.v2;
  assert.ok(f.ok && t.ok, f.error ?? t.error ?? "");
  assert.deepEqual(f.bbox.map((x) => Math.round(x * 1e4) / 1e4), [0, 0, 100, 20]);
  assert.deepEqual(t.bbox.map((x) => Math.round(x * 1e4) / 1e4), [0, 0, 100, 60]);
  // o furo vê-se de frente como duas linhas ocultas verticais em x = 40 e x = 60
  const hidV = f.hidden.filter((c) => c.k === "l" && Math.abs(c.a[0] - c.b[0]) < 1e-6).map((c) => (c.k === "l" ? Math.round(c.a[0]) : 0)).sort();
  assert.deepEqual([...new Set(hidV)], [40, 60]);
  // as arestas de trás do prisma coincidem com as da frente: não aparecem como ocultas
  assert.ok(!f.hidden.some((c) => c.k === "l" && Math.abs(c.a[1] - c.b[1]) < 1e-6 && Math.abs(c.a[0] - c.b[0]) > 50));
  assert.ok(t.visible.some((c) => c.k === "c" && Math.abs(c.r - 10) < 1e-6));
  assert.equal(t.centerMarks.length, 1);
  near(t.centerMarks[0].c[0], 50); near(t.centerMarks[0].c[1], 30);
  assert.ok(f.centerLines.some(([a, b]) => Math.abs(a[0] - 50) < 1e-6 && Math.abs(b[0] - 50) < 1e-6));
  // cotas: 100 e 60 do retângulo e ⌀20 do furo, todas paralelas à vista de cima
  const vals = t.modelDims.map((d) => `${d.type}:${Math.round(d.value * 1000) / 1000}`).sort();
  assert.deepEqual(vals, ["aligned:100", "aligned:60", "diameter:20"]);
  assert.equal(f.modelDims.length, 0);
  // âncoras: as arestas do modelo projetadas
  assert.ok(Object.keys(t.edges).length >= 12);
});

test("corte, pormenor e vista auxiliar", async () => {
  const pr = drawing(project(), [
    { id: "v1", name: "Cima", kind: "model", source: { kind: "part", id: "p1" }, orientation: "top", at: [100, 100] },
    { id: "s", name: "Corte A-A", kind: "section", parent: "v1", a: [-10, 30], b: [110, 30], label: "A", at: [100, 200] },
    { id: "d", name: "Pormenor B", kind: "detail", parent: "v1", center: [50, 30], radius: 15, label: "B", at: [250, 100] },
    { id: "x", name: "Auxiliar", kind: "auxiliary", parent: "v1", edge: "{f2:end:l5&f2:side:l5}", at: [250, 200] },
  ]);
  const r = await new KernelService().drawing(pr, pr.drawings[0].id);
  const s = r.views.s;
  assert.ok(s.ok, s.error ?? "");
  // secção por y = 30: 100×20 menos o furo 20×20
  near(triArea(s.hatch), 100 * 20 - 20 * 20, 1e-3);
  near(s.bbox[2] - s.bbox[0], 100, 1e-4);
  const d = r.views.d;
  assert.ok(d.ok && d.scale === 2, d.error ?? "");
  assert.ok(d.visible.some((c) => c.k === "c"), "o furo fica dentro do pormenor");
  assert.ok(d.visible.every((c) => curvePoints(c).every((p) => Math.hypot(p[0] - 50, p[1] - 30) <= 15 + 1e-6)));
  const x = r.views.x;
  assert.ok(x.ok, x.error ?? "");
  near(x.bbox[2] - x.bbox[0], 100, 1e-4);
  near(x.bbox[3] - x.bbox[1], 20, 1e-4);
});

test("vista de montagem: arestas com o componente", async () => {
  const pr = project();
  pr.assemblies.push({ id: "a1", name: "M", components: [
    { id: "c1", name: "Bloco<1>", ref: { kind: "part", id: "p1" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "Bloco<2>", ref: { kind: "part", id: "p1" }, placement: { t: [0, 0, 20], r: [0, 0, 0] } },
  ], mates: [] });
  const pd = drawing(pr, [{ id: "v1", name: "Frente", kind: "model", source: { kind: "assembly", id: "a1" }, orientation: "front", at: [100, 100] }]);
  const r = await new KernelService().drawing(pd, pd.drawings[0].id);
  const v = r.views.v1;
  assert.ok(v.ok, v.error ?? "");
  near(v.bbox[3] - v.bbox[1], 40);
  const names = Object.keys(v.edges);
  assert.ok(names.some((n) => n.startsWith("c2|")) && v.edgeComponent?.[names.find((n) => n.startsWith("c2|"))!] === "c2");
  near(r.sources.a1.volume, 2 * (100 * 60 * 20 - Math.PI * 100 * 20), 1);
  const _unused: Vec3 = [0, 0, 0]; void _unused;
});

// --- folha, exportações e BOM (puros) ------------------------------------------------
import { renderDrawing, fmtNum } from "../src/drawing/render.ts";
import { toSVG } from "../src/drawing/svg.ts";
import { toPDF } from "../src/drawing/pdf.ts";
import { toDXF } from "../src/drawing/dxf.ts";
import { computeBom, bomCell } from "../src/assembly/bom.ts";
import { toCSV, toXLSX } from "../src/io/table.ts";
import { hatchTriangles, clipPolylineCircle, dropCoincident } from "../src/drawing/geom2d.ts";

test("geometria 2D: tracejado, recorte por círculo, ocultas coincidentes", () => {
  // quadrado 10×10 em dois triângulos, tracejado a 45° com passo 1: comprimento total ≈ área/passo
  const segs = hatchTriangles([0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10], 1);
  const len = segs.reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
  near(len, 100, 2);
  const parts = clipPolylineCircle([[-10, 0], [10, 0]], [0, 0], 5);
  assert.equal(parts.length, 1);
  near(parts[0][0][0], -5); near(parts[0].at(-1)![0], 5);
  assert.equal(dropCoincident([{ k: "l", a: [0, 0], b: [10, 0] }, { k: "l", a: [0, 1], b: [10, 1] }], [{ k: "l", a: [-1, 0], b: [11, 0] }], 1e-6).length, 1);
  assert.equal(fmtNum(12.5), "12,5"); assert.equal(fmtNum(20), "20"); assert.equal(fmtNum(0.125, 2), "0,13");
});

test("folha: legenda, vistas alinhadas, cotas do modelo, anotações; SVG, PDF e DXF", async () => {
  const base = drawing(project(), [
    { id: "v1", name: "Frente", kind: "model", source: { kind: "part", id: "p1" }, orientation: "front", at: [120, 200], hidden: true },
    { id: "v2", name: "Cima", kind: "projected", parent: "v1", side: "below", at: [130, 110] },
    { id: "v3", name: "Esquerda", kind: "projected", parent: "v1", side: "right", at: [260, 190] },
  ]);
  base.parts[0].properties = { number: "GK-100", description: "Bloco furado", material: "Aço S235JR", density: 7.85 };
  const d = base.drawings[0];
  d.title = { ...d.title, author: "JH", company: "Galkeel" };
  d.annotations = [
    { kind: "dim", id: "a1", type: "horizontal", a: { view: "v2", edge: "{f2:side:l5&f2:start:l5}", at: "start" }, b: { view: "v2", edge: "{f2:side:l5&f2:start:l5}", at: "end" }, offset: -10 },
    { kind: "dim", id: "a2", type: "diameter", a: { view: "v2", edge: "{f2:end:l5&f4:side:c2}", at: "center" }, offset: 8 },
    { kind: "dim", id: "a3", type: "aligned", a: { view: "v2", point: [0, 0] }, b: { view: "v2", point: [0, 0] }, offset: 8, model: { feature: "f1", constraint: "k13", view: "v2" } },
    { kind: "note", id: "a4", at: [40, 60], text: "Arestas vivas quebradas 0,5 × 45°\nTratamento: zincado" },
    { kind: "gdt", id: "a5", at: [200, 60], leader: { view: "v1", edge: "{f2:end:l5&f2:side:l5}", at: "mid" }, char: "flatness", tol: "0,05", datums: [] },
    { kind: "datum", id: "a6", at: [60, 160], anchor: { view: "v1", edge: "{f2:side:l5&f2:start:l5}", at: "mid" }, letter: "A" },
    { kind: "surface", id: "a7", at: [100, 230], process: "removal", value: "Ra 3,2" },
    { kind: "weld", id: "a8", at: [220, 120], anchor: { view: "v1", point: [100, 20] }, symbol: "fillet", size: "a5", allAround: true },
  ];
  const svc = new KernelService();
  const res = await svc.drawing(base, d.id);
  const L = renderDrawing(d, base, res);
  assert.deepEqual([L.w, L.h], [420, 297]);
  assert.deepEqual(L.warnings, []);
  const texts = L.prims.filter((p) => p.t === "text").map((p) => (p.t === "text" ? p.text : ""));
  for (const t of ["Bloco furado", "GK-100", "Aço S235JR", "ISO 2768-mK", "Galkeel", "1.º diedro", "100", "⌀20", "Ra 3,2", "a5", "A", "0,05"]) assert.ok(texts.includes(t), `falta o texto "${t}"`);
  // a vista de cima (1.º diedro, por baixo) fica alinhada na vertical com a de frente; a lateral na horizontal
  near(L.views.v2.at[0], L.views.v1.at[0]); near(L.views.v3.at[1], L.views.v1.at[1]);
  // massa na legenda: (100·60·20 − π·10²·20) mm³ × 7,85 g/cm³
  const kg = ((100 * 60 * 20 - Math.PI * 100 * 20) / 1000) * 7.85 / 1000;
  assert.ok(texts.includes(`${fmtNum(kg, 3)} kg`), texts.filter((t) => t.includes("kg")).join());
  assert.ok(L.prims.some((p) => p.layer === "hidden"), "linhas ocultas na vista de frente");
  assert.ok(L.prims.some((p) => p.layer === "center"), "linhas de centro");

  const svg = toSVG(L, "T");
  assert.match(svg, /^<\?xml/);
  assert.ok(svg.includes('viewBox="0 0 420 297"') && svg.includes("Bloco furado"));
  const pdf = new TextDecoder("latin1").decode(toPDF(L, "T"));
  assert.ok(pdf.startsWith("%PDF-1.4") && pdf.includes("/Helvetica") && pdf.trimEnd().endsWith("%%EOF"));
  const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
  assert.equal(pdf.slice(xref, xref + 4), "xref", "a tabela xref está no sítio declarado");
  assert.ok(pdf.includes("(A\\347o S235JR)"), "ç em WinAnsi");
  const dxf = new TextDecoder("latin1").decode(toDXF(L));
  assert.ok(dxf.includes("AC1009") && dxf.includes("HIDDEN") && dxf.includes("%%c20") && dxf.trimEnd().endsWith("EOF"));
});

test("BOM: nível de topo, só peças e indentada; CSV e XLSX", () => {
  const pr = project();
  pr.parts.push({ ...newPart(pr, "Parafuso"), properties: { number: "ISO 4017 M6×20", description: "Parafuso sextavado", material: "Aço 8.8" } });
  pr.assemblies.push({ id: "a1", name: "Sub", properties: { number: "SUB-1" }, components: [
    { id: "c1", name: "B<1>", ref: { kind: "part", id: "p1" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "P<1>", ref: { kind: "part", id: "p2" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c3", name: "P<2>", ref: { kind: "part", id: "p2" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
  ], mates: [] });
  pr.assemblies.push({ id: "a2", name: "Topo", components: [
    { id: "c1", name: "Sub<1>", ref: { kind: "assembly", id: "a1" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "Sub<2>", ref: { kind: "assembly", id: "a1" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c3", name: "P<3>", ref: { kind: "part", id: "p2" }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
  ], mates: [] });
  const vol = { p1: 1000, p2: 100 };
  const top = computeBom(pr, "a2", "top", vol);
  assert.deepEqual(top.map((r) => [r.item, r.number, r.qty]), [["1", "SUB-1", 2], ["2", "ISO 4017 M6×20", 1]]);
  const parts = computeBom(pr, "a2", "parts", vol);
  assert.deepEqual(parts.map((r) => [r.number, r.qty]), [["Bloco", 2], ["ISO 4017 M6×20", 5]]);
  const ind = computeBom(pr, "a2", "indented", vol);
  assert.deepEqual(ind.map((r) => r.item), ["1", "1.1", "1.2", "2"]);
  near(top[0].unitMass!, 1 * 7.85 + 2 * 0.1 * 7.85, 1e-9);
  assert.equal(bomCell(top[0], "totalMass"), "0,019");
  const csv = toCSV(["Item", "Qtd."], top.map((r) => [r.item, String(r.qty)]));
  assert.ok(csv.startsWith("﻿Item;Qtd.\r\n1;2"));
  const x = toXLSX("BOM", ["Item"], [["1"]]);
  assert.equal(String.fromCharCode(x[0], x[1]), "PK");
});
