// Análise integrada Galkeel: os módulos da galkeel-calculadora carregados tal como estão, a geometria
// dos painéis medida no modelo, a análise por painel (mesmos números que a calculadora), o relatório
// e o envelope de resultados da galkeel-app.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import { panelGeometry, eigenSym3, minAreaRect } from "../src/kernel/panels.ts";
import { galkeelCalc } from "../src/galkeel/calc.ts";
import { type Laminate, type VesselRecord, EDITION, analysePanel, autoTarget, femCheck, galkeelPayloads, scantlingReport } from "../src/galkeel/scantling.ts";

before(initKernel);
const dir = new URL("../vendor/galkeel-calculadora/assets/", import.meta.url);
const src = (f: string) => readFileSync(new URL(f, dir), "utf8");
const calc = galkeelCalc({ pressure: src("iso12215-5-pressure.js"), frp: src("iso12215-5-frp-scantling.js"), version: execFileSync("git", ["-C", new URL("../vendor/galkeel-calculadora", import.meta.url).pathname, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() });
// a mesma calculadora carregada por outra via (node:vm, contexto isolado): o carregador não pode mudar nada
const viaVm = (f: string) => { const m = { exports: {} as Record<string, never> }; vm.runInNewContext(src(f), { module: m, exports: m.exports, Math }); return m.exports as Record<string, (...a: unknown[]) => never>; };
const refP = viaVm("iso12215-5-pressure.js");
const refF = viaVm("iso12215-5-frp-scantling.js");

const vessel: VesselRecord = { craft: "motor", category: "C", LH: 7.5, LWL: 6.5, Bc: 2.2, beta04: 18, V: 30, mLDC: 2200, xAft: 0, forward: 1, zWL: 0, Zside: 0.9 };
const lam: Laminate = { layup: "mat_roving_wr_cp", psi: 0.33, k5: 1, name: "CSM/WR" };

test("calculadora: carregada sem cópia, com as mesmas funções que o require do Node", () => {
  assert.equal(typeof calc.pressure.calculateMotorCraftPressures, "function");
  assert.ok(/^[0-9a-f]{7,}$/.test(calc.version));
  const i = { LWL: 6.5, Bc: 2.2, beta04: 18, V: 30, mLDC: 2200, category: "C", componentType: "panel", x: 3, sandwich: false, b: 400, l: 600, target: "bottom" };
  assert.equal(JSON.stringify(calc.pressure.calculateMotorCraftPressures(i)), JSON.stringify(refP.calculateMotorCraftPressures(i)));
  assert.equal(JSON.stringify(calc.frp.calculateFrpSingleSkinThickness({ b: 400, l: 600, c: 0, P: 50, sigma_uf: 150 })), JSON.stringify(refF.calculateFrpSingleSkinThickness({ b: 400, l: 600, c: 0, P: 50, sigma_uf: 150 })));
});

test("geometria: valores próprios, retângulo de área mínima", () => {
  const e = eigenSym3([[4, 0, 0], [0, 1, 0], [0, 0, 9]]);
  assert.deepEqual(e.values, [1, 4, 9]);
  const r = minAreaRect([[0, 0], [3, 4], [-4, 3], [-1, 7]]); // quadrado 5×5 rodado
  assert.ok(Math.abs(r.w - 5) < 1e-4 && Math.abs(r.h - 5) < 1e-4, JSON.stringify(r));
});

async function build(sketch: SketchBuilder, depth: number) {
  let doc = newDocument();
  doc = addFeature(doc, sketch.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth } }).doc;
  return (await new Engine().rebuild(doc)).ctx;
}

test("painéis: placa plana 600 × 400 e painel cilíndrico com flecha conhecida", async () => {
  const s = new SketchBuilder();
  s.rect(0, 0, 600, 400, 600, 400);
  const ctx = await build(s, 6);
  const top = ctx.body!.faces.find((f) => { const p = faceProps(f.face); return p.type === "plane" && Math.abs(p.center[2] - 6) < 1e-9; })!;
  const [g] = panelGeometry(ctx, [top.name]);
  assert.ok(Math.abs(g.b - 400) < 1e-6 && Math.abs(g.l - 600) < 1e-6 && g.crown === 0, JSON.stringify(g));
  assert.ok(Math.abs(g.normal[2] - 1) < 1e-9 && Math.abs(g.area - 240000) < 1e-3);
  // segmento circular R = 1000, corda 400 → flecha 1000 − √(1000² − 200²) = 20,204 mm; extrusão 600
  const R = 1000, yc = -Math.sqrt(R * R - 200 * 200);
  const c = new SketchBuilder();
  const a0 = Math.atan2(-yc, 200), a1 = Math.atan2(-yc, -200);
  const arc = c.arc(200, yc, R, a0, a1);
  c.line(arc.e, arc.s);
  const ctx2 = await build(c, 600);
  const cyl = ctx2.body!.faces.find((f) => faceProps(f.face).type === "cylinder")!;
  const [h] = panelGeometry(ctx2, [cyl.name]);
  const sag = R + yc;
  assert.ok(Math.abs(h.crown - sag) < 0.05 * sag, `flecha ${h.crown} vs ${sag}`);
  assert.ok(Math.abs(h.b - 400) < 2 && Math.abs(h.l - 600) < 1, `${h.b} × ${h.l}`);
  assert.ok(h.normal[1] > 0.99, "normal para fora (para cima da corda)");
});

test("análise por painel: zona, posição, pressão e espessuras iguais às da calculadora; FEM e relatório", () => {
  assert.equal(autoTarget([0, 0, -1], -0.2), "bottom");
  assert.equal(autoTarget([0, 1, 0], 0.3), "side");
  assert.equal(autoTarget([0, 0, 1], 0.9), "deck");
  const geom = { name: "f9:x", type: "plane", area: 240000, center: [3000, 0, -200] as [number, number, number], normal: [0, 0, -1] as [number, number, number], planeNormal: [0, 0, -1] as [number, number, number], ub: [0, 1, 0] as [number, number, number], ul: [1, 0, 0] as [number, number, number], b: 400, l: 600, crown: 0, bbox: { min: [2700, -200, -200] as [number, number, number], max: [3300, 200, -200] as [number, number, number] } };
  const r = analysePanel(calc, vessel, lam, { face: "f9:x", label: "Fundo AV", target: "auto", thickness: 7 }, geom);
  assert.equal(r.target, "bottom");
  assert.ok(Math.abs(r.geometry.x - 3) < 1e-12 && Math.abs(r.geometry.h + 0.2) < 1e-12);
  const P = (refP.calculateMotorCraftPressures({ LWL: 6.5, Bc: 2.2, beta04: 18, V: 30, mLDC: 2200, category: "C", componentType: "panel", x: 3, sandwich: false, b: 400, l: 600, target: "bottom", h: -0.2, Z: 0.9 }) as { results: { bottomPressure: number } }).results.bottomPressure;
  assert.equal(r.pressureKPa, P);
  const sig = (refF.glassMechanicalProperties(0.33, "mat_roving_wr_cp") as { sigma_uf: number }).sigma_uf;
  assert.equal(r.requiredThicknessMm, (refF.calculateFrpSingleSkinThickness({ b: 400, l: 600, c: 0, P, sigma_uf: sig }) as { thicknessMm: number }).thicknessMm);
  const wmin = (refF.calculateFrpMinimumHullThickness({ location: "bottom", LWL: 6.5, V: 30, mLDC: 2200, k5: 1, isSailingCraft: false }) as { w_MIN: number }).w_MIN;
  assert.ok(Math.abs(r.minimumThicknessMm - wmin * (refF.glassThicknessPerMass(0.33) as number)) < 1e-12);
  assert.equal(r.governingThicknessMm, Math.max(r.requiredThicknessMm, r.minimumThicknessMm));
  assert.ok(Math.abs(r.ratio! - 7 / r.governingThicknessMm) < 1e-12);
  assert.ok(r.warnings.some((w) => /entre apoios/.test(w)));
  const f = femCheck(r, 2 * r.sigmaD, "probe1");
  assert.ok(Math.abs(f.fem!.utilisation - 2) < 1e-12 && f.warnings.some((w) => /acima de σd/.test(w)));
  // envelope da galkeel-app e relatório
  const [msg] = galkeelPayloads([f], vessel, lam, { model: "Casco 7,5", calcVersion: calc.version, tool: "CAD protótipo", date: "2026-10-27" });
  assert.equal(msg.type, "galkeel:calculator-result");
  assert.equal(msg.calculator, "iso12215-5-frp");
  assert.equal(msg.payload.assessment.verdict, "undetermined");
  assert.equal(msg.payload.results.pressureKPa, P);
  assert.equal(msg.payload.edition, EDITION);
  assert.ok(Array.isArray(msg.payload.warnings) && typeof msg.payload.inputs === "object");
  const html = scantlingReport([f], vessel, lam, { model: "Casco 7,5", calcVersion: calc.version, tool: "CAD protótipo", date: "2026-10-27" });
  assert.match(html, /veredito indeterminado/);
  assert.match(html, /ISO 12215-5:2008 \(edição retirada/);
  assert.match(html, /Fundo AV/);
  assert.match(html, new RegExp(calc.version));
  assert.ok(!/<script/i.test(html));
  // vela: o mesmo caminho com a função de vela
  const s = analysePanel(calc, { ...vessel, craft: "sail", category: "B" }, lam, { face: "f9:x", target: "bottom" }, geom);
  assert.ok(s.pressureKPa > 0 && /PBS/.test(s.pressureRule));
});

// --- verificação FEM com a pressão de projeto: placa encastrada contra Roark ------------------------
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { studyCase } from "../src/kernel/sim.ts";
import { SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { femStudyForPanels } from "../src/galkeel/scantling.ts";
import { runCase, tools } from "../tools/cad-runner.ts";

const T = tools();
test("análise integrada com FEM: painel 600 × 400 × 7 encastrado sob a pressão ISO contra Roark", { skip: !(T.gmsh && T.calculix) && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  // placa de fundo (z de −207 a −200, abaixo da LA), x de 2700 a 3300 mm a partir da ré da LWL
  const s = new SketchBuilder();
  s.rect(2700, -200, 600, 400, 600, 400);
  let doc = newDocument("Painel de fundo");
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 7 } }).doc;
  const r0 = await new Engine().rebuild(doc);
  const faces = r0.ctx.body!.faces.map((f) => ({ name: f.name, p: faceProps(f.face) }));
  const bottom = faces.find((f) => f.p.type === "plane" && f.p.normal![2] < -0.99)!;
  const sides = faces.filter((f) => f.p.type === "plane" && Math.abs(f.p.normal![2]) < 1e-6);
  assert.equal(sides.length, 4);
  const zb = bottom.p.center[2];
  const [g] = panelGeometry(r0.ctx, [bottom.name]);
  const res = analysePanel(calc, { ...vessel, zWL: zb + 200 }, { ...lam }, { face: bottom.name, label: "Fundo", target: "auto", b: 400, l: 600, thickness: 7 }, g);
  assert.equal(res.target, "bottom");
  // material isotrópico equivalente do laminado (E do Anexo C)
  const props = refF.glassMechanicalProperties(lam.psi, lam.layup) as { E: number };
  const base = { ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0], name: "PRFV (E do Anexo C)", E: props.E, nu: 0.3, density: 1.5 }, mesh: { size: 7, order: 2 as const, curvature: 0 },
    loads: [{ kind: "fixed" as const, faces: sides.map((f) => ({ kind: "face" as const, name: f.name })) }] };
  const st = femStudyForPanels(base, [res]);
  assert.deepEqual(st.loads.map((l) => l.kind), ["fixed", "pressure"]);
  const sim = studyCase(r0.ctx, st);
  const dir = mkdtempSync(join(tmpdir(), "cad-galkeel-"));
  for (const [p, d] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }
  const run = await runCase(dir);
  const sigma = run.metrics.find((m) => m.key === "probe1")!.value;
  // Roark (Tabela 11.4, bordos encastrados, a/b = 1,5): σx = β·q·b²/t², β = 0,4542 (meio do lado maior);
  // no bordo encastrado σy = ν·σx, por isso von Mises = σx·√(1 − ν + ν²)
  const q = res.pressureKPa / 1000, roark = ((0.4542 * q * 400 ** 2) / 7 ** 2) * Math.sqrt(1 - 0.3 + 0.09);
  assert.ok(Math.abs(sigma - roark) < 0.03 * roark, `FEM ${sigma} MPa vs Roark ${roark} MPa`);
  const f = femCheck(res, sigma, "probe1");
  assert.ok(Math.abs(f.fem!.utilisation - sigma / res.sigmaD) < 1e-12);
});
