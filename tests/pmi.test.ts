// PMI (Fase 5): tabelas ISO 286 contra valores publicados, ajustamentos, regras ISO 1101/5459 e
// pesquisa/exportação de atributos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type PmiItem, attributesCSV, checkPmi, fit, fitDeviation, itValue, nextDatumLabel, pmiText, searchAttributes } from "../src/doc/pmi.ts";

const um = (x: { upper: number; lower: number }) => [Math.round(x.upper * 1000), Math.round(x.lower * 1000)];

test("ISO 286: graus IT e classes de tolerância (valores da ISO 286-2)", () => {
  assert.equal(itValue(7, 25), 21);
  assert.equal(itValue(6, 25), 13);
  assert.equal(itValue(7, 30), 21, "30 mm está no escalão 18–30 (até inclusive)");
  assert.equal(itValue(7, 30.01), 25);
  assert.equal(itValue(11, 500), 400);
  assert.deepEqual(um(fitDeviation("H7", 25)), [21, 0]);
  assert.deepEqual(um(fitDeviation("g6", 25)), [-7, -20]);
  assert.deepEqual(um(fitDeviation("h6", 25)), [0, -13]);
  assert.deepEqual(um(fitDeviation("k6", 25)), [15, 2]);
  assert.deepEqual(um(fitDeviation("p6", 25)), [35, 22]);
  assert.deepEqual(um(fitDeviation("f7", 40)), [-25, -50]);
  assert.deepEqual(um(fitDeviation("H8", 50)), [39, 0]);
  assert.deepEqual(um(fitDeviation("G7", 10)), [20, 5]);
  assert.deepEqual(fitDeviation("js6", 25), { upper: 0.0065, lower: -0.0065 }, "js: ±IT/2 (±6,5 µm)");
  assert.deepEqual(um(fitDeviation("k8", 25)), [33, 0], "k fora de IT4–IT7: ei = 0");
  assert.throws(() => fitDeviation("H7", 600), /fora do intervalo/);
  assert.throws(() => fitDeviation("Z7", 25), /não tabelado/);
  assert.throws(() => fitDeviation("H", 25), /inválida/);
});

test("ISO 286: ajustamentos com folga, incerto e com aperto (Ø25)", () => {
  const a = fit("H7", "g6", 25);
  assert.equal(a.type, "clearance");
  assert.equal(Math.round(a.maxClearance * 1000), 41);
  assert.equal(Math.round(a.minClearance * 1000), 7);
  assert.equal(fit("H7", "k6", 25).type, "transition");
  const p = fit("H7", "p6", 25);
  assert.equal(p.type, "interference");
  assert.equal(Math.round(p.minClearance * 1000), -35);
});

const kinds = (m: Record<string, string>) => (r: { name: string }) => m[r.name] ?? null;
const f = (name: string) => ({ kind: "face" as const, name });

test("ISO 1101/5459: regras dos quadros de tolerância e das referências", () => {
  const K = kinds({ top: "plane", side: "plane", hole: "cylinder", free: "bspline" });
  const ok = (i: PmiItem, d = ["A", "B"]) => assert.deepEqual(checkPmi(i, d, K), [], JSON.stringify(i));
  const bad = (i: PmiItem, re: RegExp, d = ["A", "B"]) => assert.ok(checkPmi(i, d, K).some((e) => re.test(e)), `${JSON.stringify(i)} → ${checkPmi(i, d, K)}`);
  ok({ kind: "datum", id: "p1", label: "A", face: f("top") });
  bad({ kind: "datum", id: "p1", label: "I", face: f("top") }, /I, O e Q/);
  bad({ kind: "datum", id: "p1", label: "a", face: f("top") }, /maiúsculas/);
  ok({ kind: "gdt", id: "p2", characteristic: "flatness", faces: [f("top")], value: 0.05, datums: [] });
  bad({ kind: "gdt", id: "p2", characteristic: "flatness", faces: [f("top")], value: 0.05, datums: ["A"] }, /sem referências/);
  bad({ kind: "gdt", id: "p2", characteristic: "flatness", faces: [f("hole")], value: 0.05, datums: [] }, /faces planas/);
  bad({ kind: "gdt", id: "p2", characteristic: "perpendicularity", faces: [f("side")], value: 0.05, datums: [] }, /pelo menos uma referência/);
  ok({ kind: "gdt", id: "p2", characteristic: "position", faces: [f("hole")], value: 0.1, diameter: true, modifier: "M", datums: ["A", "B"] });
  bad({ kind: "gdt", id: "p2", characteristic: "position", faces: [f("hole")], value: 0.1, datums: ["C"] }, /"C" não definida/);
  bad({ kind: "gdt", id: "p2", characteristic: "flatness", faces: [f("top")], value: 0.1, diameter: true, datums: [] }, /zona cilíndrica/);
  bad({ kind: "gdt", id: "p2", characteristic: "position", faces: [f("top")], value: 0.1, modifier: "M", datums: ["A"] }, /elemento de dimensão/);
  bad({ kind: "gdt", id: "p2", characteristic: "cylindricity", faces: [f("top")], value: 0.1, datums: [] }, /revolução/);
  bad({ kind: "gdt", id: "p2", characteristic: "position", faces: [f("hole")], value: 0, datums: ["A"] }, /positivo/);
  ok({ kind: "dimension", id: "p3", type: "diameter", faces: [f("hole")], tol: { kind: "fit", code: "H7" } });
  bad({ kind: "dimension", id: "p3", type: "diameter", faces: [f("top")] }, /face de revolução/);
  ok({ kind: "dimension", id: "p3", type: "distance", faces: [f("top"), f("side")], tol: { kind: "deviation", upper: 0.1, lower: -0.1 } });
  bad({ kind: "dimension", id: "p3", type: "distance", faces: [f("top"), f("side")], tol: { kind: "deviation", upper: -0.1, lower: 0.1 } }, /maior que o inferior/);
  bad({ kind: "dimension", id: "p3", type: "distance", faces: [f("ghost")] }, /inexistente/);
  assert.equal(nextDatumLabel(["A", "B", "C", "D", "E", "F", "G", "H"]), "J");
});

test("PMI: textos dos quadros, cotas e estados de superfície", () => {
  assert.equal(pmiText({ kind: "gdt", id: "x", characteristic: "position", faces: [], value: 0.1, diameter: true, modifier: "M", datums: ["A", "B"] }), "|⌖|⌀0,1Ⓜ|A|B|");
  assert.equal(pmiText({ kind: "dimension", id: "x", type: "diameter", faces: [], tol: { kind: "fit", code: "H7" } }, 25), "⌀25 H7 (+0,021/0)");
  assert.equal(pmiText({ kind: "dimension", id: "x", type: "distance", faces: [], tol: { kind: "deviation", upper: 0.1, lower: -0.1 } }, 40), "40 ±0,1");
  assert.equal(pmiText({ kind: "dimension", id: "x", type: "distance", faces: [], tol: { kind: "deviation", upper: 0, lower: -0.2 } }, 40), "40 0/-0,2");
  assert.equal(pmiText({ kind: "roughness", id: "x", faces: [], ra: 1.6, process: "remove" }), "▽ Ra 1,6");
  assert.equal(pmiText({ kind: "datum", id: "x", label: "A", face: f("top") }), "[A]");
});

test("atributos: pesquisa sem acentos e CSV", () => {
  const docs = [
    { id: "p1", name: "Suporte", attributes: [{ target: { kind: "body" as const }, key: "Processo", value: "Maquinação CNC" }, { target: { kind: "face" as const, ref: f("f3:end") }, key: "Tratamento", value: "Anodização" }] },
    { id: "p2", name: "Tampa", attributes: [{ target: { kind: "feature" as const, feature: "f4" }, key: "Fornecedor", value: "Fundição Lda; lote 7" }] },
  ];
  assert.equal(searchAttributes(docs, "maquinacao").length, 1);
  assert.equal(searchAttributes(docs, "ANODIZ")[0].target, "Face f3:end");
  assert.equal(searchAttributes(docs, "").length, 3);
  assert.equal(searchAttributes(docs, "tampa")[0].key, "Fornecedor");
  const csv = attributesCSV(searchAttributes(docs, ""));
  assert.ok(csv.startsWith("﻿Documento;Alvo;Atributo;Valor\n"));
  assert.match(csv, /Tampa;Feature f4;Fornecedor;"Fundição Lda; lote 7"/);
});

// --- núcleo: valores medidos e validação contra a geometria real ------------------------------
import { before } from "node:test";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument, parseDocument, serialize } from "../src/doc/io.ts";
import { pmiStates } from "../src/kernel/pmi.ts";
import type { CadDocument } from "../src/doc/types.ts";

before(initKernel);

/** Bloco 60 × 40 × 20 com um furo passante Ø10 no centro. */
async function plate() {
  const s = new SketchBuilder();
  s.rect(0, 0, 60, 40, 60, 40);
  let doc: CadDocument = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }).doc;
  const h = new SketchBuilder();
  h.circle(30, 20, 5);
  doc = addFeature(doc, h.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" }, end2: { type: "throughAll" } }).doc;
  const r = await new Engine().rebuild(doc);
  const find = (pred: (p: ReturnType<typeof faceProps>) => boolean) => f(r.ctx.body!.faces.find((x) => pred(faceProps(x.face)))!.name);
  return {
    doc, ctx: r.ctx,
    top: find((p) => p.type === "plane" && Math.abs(p.center[2] - 20) < 1e-6),
    bottom: find((p) => p.type === "plane" && Math.abs(p.center[2]) < 1e-6),
    side: find((p) => p.type === "plane" && Math.abs(p.center[0]) < 1e-6),
    hole: find((p) => p.type === "cylinder"),
  };
}

test("PMI no núcleo: cotas medidas no modelo, ancoragem e erros de geometria", async () => {
  const P = await plate();
  const items: PmiItem[] = [
    { kind: "datum", id: "d1", label: "A", face: P.bottom },
    { kind: "dimension", id: "m1", type: "distance", faces: [P.top, P.bottom], tol: { kind: "deviation", upper: 0.1, lower: -0.1 } },
    { kind: "dimension", id: "m2", type: "diameter", faces: [P.hole], tol: { kind: "fit", code: "H7" } },
    { kind: "dimension", id: "m3", type: "angle", faces: [P.top, P.side] },
    { kind: "gdt", id: "g1", characteristic: "flatness", faces: [P.top], value: 0.02, datums: [] },
    { kind: "gdt", id: "g2", characteristic: "position", faces: [P.hole], value: 0.1, diameter: true, modifier: "M", datums: ["A"] },
    { kind: "gdt", id: "g3", characteristic: "flatness", faces: [P.hole], value: 0.02, datums: [] },
    { kind: "dimension", id: "m4", type: "distance", faces: [P.top, P.side] },
    { kind: "gdt", id: "g4", characteristic: "parallelism", faces: [P.top], value: 0.05, datums: ["B"] },
  ];
  const st = Object.fromEntries(pmiStates(P.ctx, items).map((x) => [x.id, x]));
  assert.ok(Math.abs(st.m1.nominal! - 20) < 1e-9);
  assert.equal(st.m1.text, "20 ±0,1");
  assert.ok(Math.abs(st.m2.nominal! - 10) < 1e-9);
  assert.equal(st.m2.text, "⌀10 H7 (+0,015/0)");
  assert.ok(Math.abs(st.m3.nominal! - 90) < 1e-9);
  for (const k of ["d1", "m1", "m2", "m3", "g1", "g2"]) assert.deepEqual(st[k].errors, [], `${k}: ${st[k].errors}`);
  assert.ok(Math.abs(st.g1.anchor[2] - 20) < 1e-9 && Math.abs(st.g1.normal[2] - 1) < 1e-9, "âncora no topo, normal para fora");
  assert.ok(Math.abs(Math.hypot(st.g2.anchor[0] - 30, st.g2.anchor[1] - 20) - 5) < 1e-6, "âncora na superfície do furo");
  assert.ok(st.g3.errors.some((e) => /faces planas/.test(e)));
  assert.ok(st.m4.errors.some((e) => /não são paralelas/.test(e)));
  assert.ok(st.g4.errors.some((e) => /"B" não definida/.test(e)));
  // os PMI viajam no ficheiro da peça
  const back = parseDocument(serialize({ ...P.doc, pmi: items, modelViews: [{ id: "v1", name: "Furo", dir: [0, 0, 1], up: [0, 1, 0], items: ["m2", "g2"] }], attributes: [{ target: { kind: "body" }, key: "Processo", value: "CNC" }] }));
  assert.equal(back.pmi!.length, items.length);
  assert.equal(back.modelViews![0].items.length, 2);
  assert.equal(back.attributes![0].value, "CNC");
});

// --- STEP AP242 com PMI semântico, lido de volta pelo leitor GD&T do OpenCASCADE (OCP) -------------
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelService } from "../src/kernel/service.ts";
import { addSemanticPmi, text as stepText } from "../src/kernel/step-pmi.ts";

const hasOCP = spawnSync("python3", ["-c", "import OCP"]).status === 0;

test("STEP AP242: PMI semântico ligado às faces (texto) e lido pelo leitor do OCCT", async () => {
  const P = await plate();
  const pmi: PmiItem[] = [
    { kind: "datum", id: "d1", label: "A", face: P.bottom },
    { kind: "datum", id: "d2", label: "B", face: P.side },
    { kind: "dimension", id: "m1", type: "distance", faces: [P.top, P.bottom], tol: { kind: "deviation", upper: 0.1, lower: -0.2 } },
    { kind: "dimension", id: "m2", type: "diameter", faces: [P.hole], tol: { kind: "fit", code: "H7" } },
    { kind: "dimension", id: "m3", type: "angle", faces: [P.top, P.side] },
    { kind: "gdt", id: "g1", characteristic: "flatness", faces: [P.top], value: 0.02, datums: [] },
    { kind: "gdt", id: "g2", characteristic: "position", faces: [P.hole], value: 0.1, diameter: true, modifier: "M", datums: ["A", "B"] },
    { kind: "gdt", id: "g3", characteristic: "perpendicularity", faces: [P.side], value: 0.05, datums: ["A"] },
    { kind: "roughness", id: "r1", faces: [P.top], ra: 1.6, process: "remove" },
    { kind: "note", id: "n1", faces: [P.hole], text: "Rebarbar arestas — 0,2×45°" },
  ];
  const svc = new KernelService();
  await svc.rebuild({ ...P.doc, pmi, attributes: [{ target: { kind: "body" }, key: "Processo", value: "Maquinação" }, { target: { kind: "face", ref: P.top }, key: "Tratamento", value: "Anodização" }] });
  const step = new TextDecoder().decode((await svc.export("step242", "p")).data);
  assert.match(step, /AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF/);
  assert.match(step, /ADVANCED_FACE\('PMI#\d+'/);
  assert.match(step, /DATUM\('A','',#\d+,\.F\.,'A'\)/);
  assert.match(step, /DIMENSIONAL_SIZE\(#\d+,'diameter'\)/);
  assert.match(step, /LIMITS_AND_FITS\('H','hole','7','ISO 286'\)/);
  assert.match(step, /LENGTH_MEASURE_WITH_UNIT\(LENGTH_MEASURE\(-0\.2\),#\d+\)/, "afastamento inferior com sinal (WR1 de tolerance_value: superior ≥ inferior)");
  assert.match(step, /ANGULAR_LOCATION\('angular location',\$,#\d+,#\d+,\.EQUAL\.\)/);
  assert.match(step, /\( GEOMETRIC_TOLERANCE\('g2','',#\d+,#\d+\) GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE\(\(#\d+\)\) GEOMETRIC_TOLERANCE_WITH_MODIFIERS\(\(\.MAXIMUM_MATERIAL_REQUIREMENT\.\)\) POSITION_TOLERANCE\(\) \)/);
  assert.match(step, /TOLERANCE_ZONE_FORM\('cylindrical or circular'\)/);
  assert.match(step, /DESCRIPTIVE_REPRESENTATION_ITEM\('Processo','Maquina\\X2\\00E7\\X0\\\\X2\\00E3\\X0\\o'\)/);
  assert.match(step, /DESCRIPTIVE_REPRESENTATION_ITEM\('surface texture Ra','1\.6 um'\)/);
  assert.ok(!/[^\x00-\x7f]/.test(step), "ficheiro ISO 10303-21 em ASCII");
  if (!hasOCP) return;
  const dir = mkdtempSync(join(tmpdir(), "cad-pmi-"));
  writeFileSync(join(dir, "p.step"), step);
  const r = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "../tools/read-step-pmi.py"), join(dir, "p.step")], { encoding: "utf8" }));
  const dims = r.dimensions.map((d: { type: string; value: number; faces: string[] }) => [d.type, +d.value.toFixed(6), d.faces.join("+")]);
  assert.deepEqual(dims.sort(), [["Angular", 90, "plane+plane"], ["Diameter", 10, "cylinder"], ["LinearDistance", 20, "plane+plane"]].sort());
  assert.equal(r.dimensions.find((d: { type: string }) => d.type === "Diameter").fit, true);
  const dist = r.dimensions.find((d: { type: string }) => d.type === "LinearDistance");
  assert.equal(dist.upper, 0.1);
  assert.equal(Math.abs(dist.lower), 0.2, "o OCCT 8.0 lê o inferior sem sinal");
  const tols = Object.fromEntries(r.tolerances.map((t: { type: string }) => [t.type, t]));
  assert.deepEqual([tols.Flatness.value, tols.Flatness.datums, tols.Flatness.faces], [0.02, [], ["plane"]]);
  assert.deepEqual([tols.Position.value, tols.Position.zone, tols.Position.material, tols.Position.datums, tols.Position.faces], [0.1, "Diameter", "M", ["A", "B"], ["cylinder"]]);
  assert.deepEqual(tols.Perpendicularity.datums, ["A"]);
  assert.ok(r.datums.some((d: { name: string; faces: string[] }) => d.name === "B" && d.faces[0] === "plane"));
});

test("STEP: texto ISO 10303-21 e erros do pós-processador", () => {
  assert.equal(stepText("O'Neil — Ø"), "'O''Neil \\X2\\2014\\X0\\ \\X2\\00D8\\X0\\'");
  assert.throws(() => addSemanticPmi("ISO-10303-21;\nDATA;\n#1 = PRODUCT('a','a','',());\nENDSEC;\n", []), /B-rep/);
});
