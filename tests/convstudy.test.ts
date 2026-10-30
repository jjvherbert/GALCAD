// Estudo de convergência configurado no estudo: o relatório traz todas as malhas com todas as grandezas
// (para tabelas e gráficos de qualquer uma), e as tabelas, os gráficos e o relatório extraem-se em
// CSV, XLSX, SVG e HTML. Verificação real com o CalculiX (consola de Timoshenko) e testes puros.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import type { TopoRef } from "../src/doc/types.ts";
import { DEFAULT_CONVERGENCE, type FemStudy, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import { type ConvergenceReport, convergenceReport } from "../src/sim/convergence.ts";
import { chartSvg, convergenceChart, errorChart, errorTable, fmt, gciTable, levelsTable, metricList, normalizedChart, plannedSizes, reportHtml, toCsvText } from "../src/sim/convreport.ts";
import { toXLSXSheets } from "../src/io/table.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);
const T = tools();
const hasFem = !!(T.gmsh && T.calculix);
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);

/** Relatório sintético: f(h) = 1 + 0,8·h² (convergência de 2.ª ordem para 1) em 5 malhas. */
function synthetic(): ConvergenceReport {
  const sizes = [4, 2.96, 2.19, 1.62, 1.2];
  const levels = sizes.map((h, i) => ({ level: 2 - i, size: h, cells: Math.round(2000 * (4 / h) ** 3), seconds: 1 + i, metrics: [
    { key: "probe1", label: "Ponta", unit: "mm", value: 1 + 0.8 * h * h },
    { key: "umax", label: "Deslocamento máx.", unit: "mm", value: 1.1 + 0.5 * h * h },
  ] }));
  const fine = levels.slice(-3).reverse();
  const r = convergenceReport(1.35, fine.map((l) => ({ cells: l.cells, size: l.size, metrics: l.metrics })));
  return { ...r, levels, setup: { mode: "sweep", ratio: 1.35, levels: 2, metric: "probe1" } };
}

test("tabelas: malhas com todas as grandezas, GCI por grandeza e erro vs. extrapolado", () => {
  const r = synthetic();
  const lv = levelsTable(r);
  assert.deepEqual(lv.header.slice(0, 4), ["Nível", "Tamanho (mm)", "Elementos", "Tempo (s)"]);
  assert.equal(lv.header.length, 6); // + Ponta e Deslocamento máx.
  assert.equal(lv.rows.length, 5);
  assert.equal(lv.rows[2][0], "0 (pedida)");
  assert.equal(lv.rows[0][0], "+2");
  assert.equal(lv.rows[4][0], "-2");
  const g = gciTable(r);
  assert.equal(g.rows.length, 2);
  // ordem aparente 2 e extrapolado 1 (a solução exata do caso sintético)
  assert.ok(g.rows.every((row) => Math.abs(Number(row[5].replace(",", ".")) - 2) < 0.05), JSON.stringify(g.rows.map((x) => x[5])));
  near(Number(g.rows[0][6].replace(",", ".")), 1, 0.001);
  assert.ok(g.rows.every((row) => row[11] === "monotónica"));
  const et = errorTable(r);
  assert.equal(et.rows.length, 5);
  assert.ok(Number(et.rows[0][2].replace(",", ".")) > Number(et.rows[4][2].replace(",", "."))); // o erro desce ao refinar
  assert.deepEqual(metricList(r).map((m) => m.key), ["probe1", "umax"]);
});

test("exportações: CSV com BOM e vírgula decimal, XLSX com várias folhas, SVG e relatório HTML", () => {
  const r = synthetic();
  const csv = toCsvText(levelsTable(r));
  assert.ok(csv.startsWith("﻿Nível;Tamanho (mm);Elementos;Tempo (s);Ponta (mm);Deslocamento máx. (mm)\r\n"));
  assert.match(csv, /\r\n0 \(pedida\);2,19;/);
  assert.equal(fmt(0.000123456), "0,000123456");
  assert.equal(fmt(Number.NaN), "");
  const xlsx = toXLSXSheets([{ name: "Malhas", ...levelsTable(r) }, { name: "GCI", ...gciTable(r) }]);
  const text = Buffer.from(xlsx).toString("latin1");
  assert.equal(text.slice(0, 2), "PK");
  assert.ok(text.includes("xl/worksheets/sheet1.xml") && text.includes("xl/worksheets/sheet2.xml") && text.includes('name="GCI"'));
  const c1 = convergenceChart(r, "probe1");
  assert.match(c1, /^<svg /);
  assert.ok(c1.includes("<polyline") && /extrapolado 0,9998/.test(c1) && c1.includes("GCI"));
  assert.ok(normalizedChart(r).includes("convergido") && errorChart(r).includes("erro (%"));
  assert.match(chartSvg({ title: "vazio", xLabel: "x", yLabel: "y", series: [] }), /Sem dados/);
  const html = reportHtml({ title: "Convergência — teste", study: "S1", solver: "CalculiX", date: "hoje", report: r });
  assert.ok(html.startsWith("<!doctype html>") && html.includes("<table>") && html.includes("<svg") && html.includes("não é certificação"));
  assert.ok((html.match(/<table>/g) ?? []).length >= 3);
});

test("planeamento: tamanhos previstos por modo (razão r, níveis) e custo relativo ∝ h⁻³", () => {
  const sweep = plannedSizes(4, { mode: "sweep", ratio: 1.5, levels: 2 });
  assert.deepEqual(sweep.map((p) => p.level), [2, 1, 0, -1, -2]);
  near(sweep[0].size, 9, 1e-9);
  near(sweep[4].size, 4 / 2.25, 1e-9);
  near(sweep[4].relCells, 1.5 ** 6, 1e-9);
  assert.deepEqual(plannedSizes(4, { mode: "three", ratio: 2, levels: 0 }).map((p) => p.size), [16, 8, 4]);
  assert.deepEqual(plannedSizes(4, { mode: "auto", ratio: 2, levels: 3 }).map((p) => p.size), [4, 2, 1]);
  assert.equal(DEFAULT_CONVERGENCE.enabled, false);
});

test("CalculiX: o relatório traz todas as malhas e grandezas, e a extrapolação concorda com Timoshenko", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 10, 100, 10);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => ({ kind: "face", name: r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[axis]) - 1) < 1e-9 && Math.abs(p.center[axis] - v) < 1e-6; })!.name });
  const study: FemStudy = {
    ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 5, order: 2, curvature: 0, element: "hex", integration: "reduced" },
    loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -100] }],
    probes: [{ name: "Ponta", quantity: "uz", at: { kind: "faces", faces: [face(0, 100)] } }],
  };
  const sim = studyCase(r.ctx, study);
  const dir = mkdtempSync(join(tmpdir(), "cad-cv-"));
  for (const [p, data] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  const res = await runCase(dir, () => {}, false, { convergence: { ratio: 1.5, sweep: 1, metric: "probe1" } });
  assert.ok(res.ok && res.convergence, JSON.stringify(res.warnings));
  const rep = res.convergence!;
  assert.equal(rep.levels!.length, 3);
  assert.deepEqual(rep.levels!.map((l) => l.level), [1, 0, -1]);
  assert.ok(rep.levels!.every((l) => l.cells > 0 && l.seconds > 0 && l.metrics.some((m) => m.key === "probe1") && l.metrics.some((m) => m.key === "umax")));
  assert.ok(rep.levels![0].cells < rep.levels![2].cells); // da mais grossa para a mais fina
  assert.deepEqual(rep.setup, { mode: "sweep", ratio: 1.5, levels: 1, metric: "probe1" });
  // tabelas com todas as grandezas, e a extrapolação de Richardson da sonda perto de Timoshenko (0,192 mm)
  assert.ok(levelsTable(rep).header.some((h) => /Ponta/.test(h)) && levelsTable(rep).header.some((h) => /Deslocamento/.test(h)));
  const ext = rep.rows.find((x) => x.key === "probe1")!.gci.extrapolated;
  near(Math.abs(ext), 0.192, 0.05);
});
