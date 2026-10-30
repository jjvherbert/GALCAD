// Malha manual: hexaedros estruturados (transfinitos) e por subdivisão, seeds com distribuição,
// faces mapeadas, elementos C3D8I/C3D20R no CalculiX e HEXA8/HEXA20 no code_aster, verificados
// contra a consola de Timoshenko (como os tetraedros em sim.test.ts).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { edgeProps, explore, faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import type { CadDocument, TopoRef } from "../src/doc/types.ts";
import { type FemStudy, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { studyCase } from "../src/kernel/sim.ts";
import { namedEdges } from "../src/kernel/naming.ts";
import type { FemCase } from "../src/sim/case.ts";
import { elementsOf, parseMsh, solidBlocks } from "../src/sim/msh.ts";
import { faceIntegrals } from "../src/sim/elements.ts";
import { isMonotonic } from "../src/sim/convergence.ts";
import { previewMesh, runCase, tools } from "../tools/cad-runner.ts";

before(initKernel);
const T = tools();
const hasFem = !!(T.gmsh && T.calculix);
const hasAster = !!(T.gmsh && T.code_aster);
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≉ ${b} (±${tol * 100}%)`);

/** Barra 100 × 10 × 10 mm ao longo de X; faces por eixo/coordenada e arestas paralelas a um eixo. */
async function bar() {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 10, 100, 10);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[axis]) - 1) < 1e-9 && Math.abs(p.center[axis] - v) < 1e-6; })!;
    return { kind: "face", name: f.name };
  };
  /** Arestas paralelas ao eixo `axis` que passam por (a, b) nos outros dois eixos. */
  const edge = (axis: 0 | 1 | 2, at: [number, number]): TopoRef => {
    const [i, j] = [0, 1, 2].filter((k) => k !== axis);
    const e = namedEdges(r.ctx.body!).find((x) => { const p = edgeProps(x.edge); return Math.abs(p.mid[i] - at[0]) < 1e-6 && Math.abs(p.mid[j] - at[1]) < 1e-6 && Math.abs(p.end[axis] - p.start[axis]) > 1; })!;
    return { kind: "edge", name: e.name };
  };
  return { doc, face, edge };
}

async function solve(doc: CadDocument, study: FemStudy) {
  const r = await new Engine().rebuild(doc);
  const sim = studyCase(r.ctx, study);
  const dir = mkdtempSync(join(tmpdir(), "cad-mesh-"));
  for (const [p, data] of Object.entries(sim.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); }
  return { sim, dir, c: sim.case as FemCase, run: () => runCase(dir) };
}

const fem = (patch: Partial<FemStudy>): FemStudy => ({ ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh: { size: 2.5, order: 2, curvature: 0 }, ...patch });
const E = 210000, nu = 0.3, I = (10 * 10 ** 3) / 12, A = 100, L = 100, F = 100, G = E / (2 * (1 + nu));
const delta = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * A);

/** Flecha média na ponta (x = 100) e reação vertical. */
function tip(r: Awaited<ReturnType<typeof runCase>>) {
  const f = r.fem!;
  const w = f.positions.reduce<number[]>((acc, _, i) => (i % 3 === 0 && Math.abs(f.positions[i] - 100) < 1e-6 ? [...acc, f.displacements[0].values[i + 2]] : acc), []);
  return { w: -w.reduce((a, b) => a + b, 0) / w.length, R: f.reactions[0]?.[2] };
}

test("integrais das faces: cargas nodais consistentes do quad8 e do trapézio", () => {
  const q = faceIntegrals(16, [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0], [1, 0, 0], [2, 0.5, 0], [1, 1, 0], [0, 0.5, 0]]);
  near(q.area, 2, 1e-12);
  q.nodal.slice(0, 4).forEach((x) => near(x / q.area, -1 / 12, 1e-9));
  q.nodal.slice(4).forEach((x) => near(x / q.area, 1 / 3, 1e-9));
  // trapézio bilinear: ∫Nᵢ dA exato = (2/3, 2/3, 7/12, 7/12)
  const t = faceIntegrals(3, [[0, 0, 0], [3, 0, 0], [2, 1, 0], [0, 1, 0]]);
  [2 / 3, 2 / 3, 7 / 12, 7 / 12].forEach((x, i) => near(t.nodal[i], x, 1e-9));
});

test("plano da malha: classes de arestas opostas, seeds e distribuição", async () => {
  const { doc, face, edge } = await bar();
  const { c, sim } = await solve(doc, fem({ mesh: { size: 5, order: 1, element: "hex", seeds: [{ edges: [edge(0, [0, 0])], mode: "count", value: 40, bias: 4, biasAt: "start" }] }, loads: [{ kind: "fixed", faces: [face(0, 0)] }] }));
  assert.equal(c.mesh.element, "hex");
  assert.equal(c.mesh.hexMethod, "structured");
  assert.deepEqual(c.mesh.volumes, [1]);
  assert.equal(c.mesh.surfaces!.length, 6);
  const curves = c.mesh.curves!;
  assert.equal(curves.length, 12);
  // as 4 arestas ao longo de X: 40 elementos (a seed propaga-se às opostas); as outras 8: 10/5 = 2
  const along = curves.filter((x) => Math.abs(x.box.max[0] - x.box.min[0]) > 50);
  assert.deepEqual(along.map((x) => x.n), [40, 40, 40, 40]);
  assert.ok(curves.filter((x) => !along.includes(x)).every((x) => x.n === 2));
  // razão maior/menor 4 em 40 elementos: r^39 = 4 (ou 1/r se a aresta corre ao contrário)
  for (const x of along) near(Math.max(x.progression!, 1 / x.progression!) ** 39, 4, 1e-9);
  assert.equal(along.filter((x) => x.user).length, 1);
  const geo = String(sim.files["mesh.geo"]);
  assert.match(geo, /Transfinite Curve\{\d+\} = 41 Using Progression/);
  assert.match(geo, /Transfinite Volume\{1\};/);
  assert.match(geo, /Recombine Surface\{/);
  assert.ok(c.hypotheses.some((h) => /hexaedros estruturados/.test(h) && /C3D8I/.test(h)));
});

test("Gmsh: hexaedros estruturados com seeds (contagem, distribuição e numeração das arestas)", { skip: !hasFem && "Gmsh/CalculiX não instalados" }, async () => {
  const { doc, face, edge } = await bar();
  const { dir } = await solve(doc, fem({ mesh: { size: 5, order: 1, element: "hex", seeds: [{ edges: [edge(0, [0, 0])], mode: "count", value: 20, bias: 3, biasAt: "ends" }] }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }] }));
  const r = await runCase(dir);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  const m = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
  const els = [...elementsOf(solidBlocks(m))];
  assert.ok(els.every((e) => e.type === 5));
  assert.equal(els.length, 20 * 2 * 2);
  // bump: elementos menores nas duas pontas ao longo de X
  const xs = [...new Set([...m.nodes.values()].map((p) => Math.round(p[0] * 1e6) / 1e6))].sort((a, b) => a - b);
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  assert.equal(h.length, 20);
  assert.ok(h[0] < h[10] / 2 && h[19] < h[10] / 2, h.map((x) => x.toFixed(2)).join(" "));
});

test("CalculiX: consola em hexaedros C3D8I e C3D20R (Timoshenko), reação e pressão em quadriláteros", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }];
  // C3D8I: modos incompatíveis — sem bloqueio por corte mesmo com 2 elementos na espessura
  const h8 = await (await solve(doc, fem({ mesh: { size: 5, order: 1, element: "hex" }, loads }))).run();
  assert.ok(h8.ok, JSON.stringify(h8));
  assert.ok(h8.summary.some(([k, v]) => k === "Malha" && /hexaedros de 8 nós/.test(v)));
  const t8 = tip(h8);
  near(t8.w, delta, 0.03);
  near(t8.R, F, 1e-3);
  // C3D8 com integração completa: bloqueio por corte (flecha bem menor) — o que o C3D8I evita
  const full = tip(await (await solve(doc, fem({ mesh: { size: 5, order: 1, element: "hex", integration: "full" }, loads }))).run());
  assert.ok(full.w < 0.92 * delta && Math.abs(t8.w - delta) < Math.abs(full.w - delta), `C3D8 ${full.w} vs C3D8I ${t8.w} vs ${delta}`);
  // C3D20R (20 nós, integração reduzida)
  const h20 = await (await solve(doc, fem({ mesh: { size: 5, order: 2, element: "hex" }, loads }))).run();
  assert.ok(h20.summary.some(([k, v]) => k === "Malha" && /hexaedros de 20 nós/.test(v)));
  const t20 = tip(h20);
  near(t20.w, delta, 0.03);
  near(t20.R, F, 1e-3);
  // pressão de 1 MPa no topo (100 × 10 mm²) sobre quad8 → reação de 1000 N
  const p = await (await solve(doc, fem({ mesh: { size: 5, order: 2, element: "hex" }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "pressure", faces: [face(2, 10)], p: 1 }] }))).run();
  near(p.fem!.reactions[0][2], 1000, 1e-4);
  assert.deepEqual(p.warnings, []);
});

test("CalculiX: hexaedros por subdivisão numa placa com furo (não é um bloco)", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 600000 }, async () => {
  // placa 100 × 10 × 10 com um furo de Ø4 a meio vão (atravessa em Z): não é um hexaedro topológico
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 10, 100, 10);
  s.circle(50, 5, 2);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r0 = await new Engine().rebuild(doc);
  const at = (axis: number, v: number): TopoRef => ({ kind: "face", name: r0.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[axis]) - 1) < 1e-9 && Math.abs(p.center[axis] - v) < 1e-6; })!.name });
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [at(0, 0)] }, { kind: "force", faces: [at(0, 100)], f: [0, 0, -F] }];
  assert.ok(explore(r0.ctx.body!.shape, "face").length > 6);
  // estruturado: recusado com uma mensagem clara; automático: subdivisão com aviso
  await assert.rejects(async () => solve(doc, fem({ mesh: { size: 2.5, order: 2, curvature: 0, element: "hex", hexMethod: "structured" }, loads })), /não é um bloco hexaédrico/);
  const st = await solve(doc, fem({ mesh: { size: 2.5, order: 2, curvature: 0, element: "hex", hexMethod: "auto" }, loads }));
  assert.equal(st.c.mesh.hexMethod, "subdivision");
  assert.ok(st.sim.warnings.some((w) => /subdivisão/.test(w)));
  assert.match(String(st.sim.files["mesh.geo"]), /Mesh.SubdivisionAlgorithm = 2;/);
  const r = await st.run();
  assert.ok(r.ok, JSON.stringify(r));
  const m = parseMsh(readFileSync(join(st.dir, "mesh.msh"), "utf8"));
  assert.ok([...elementsOf(solidBlocks(m))].every((e) => e.type === 17));
  // o furo vertical (Ø4 numa largura de 10 mm, a meio vão) reduz um pouco a rigidez à flexão
  const t = tip(r);
  assert.ok(t.w > delta && t.w < 1.1 * delta, `${t.w} vs ${delta}`);
  near(t.R, F, 1e-3);
});

test("code_aster: consola em HEXA20 (estruturados)", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const r = await (await solve(doc, fem({ solver: "code_aster", mesh: { size: 5, order: 2, element: "hex" }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }] }))).run();
  assert.ok(r.ok, JSON.stringify(r));
  const t = tip(r);
  near(t.w, delta, 0.03);
  near(t.R, F, 1e-3);
});

test("code_aster: HEXA8 com integração reduzida (3D_SI)", { skip: !hasAster && "Gmsh/code_aster não instalados", timeout: 900000 }, async () => {
  const { doc, face } = await bar();
  const st = await solve(doc, fem({ solver: "code_aster", mesh: { size: 2.5, order: 1, curvature: 0, element: "hex", integration: "reduced" }, loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }] }));
  const r = await st.run();
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(readFileSync(join(st.dir, "job.comm"), "utf8"), /MODELISATION='3D_SI'/);
  // elementos lineares com 4 camadas na espessura: ~5 % abaixo de Timoshenko (converge ao refinar)
  near(tip(r).w, delta, 0.07);
});

test("pré-visualização da malha: qualidade, volume, arestas dos elementos e tetraedros com seed", { skip: !T.gmsh && "Gmsh não instalado" }, async () => {
  const { doc, face, edge } = await bar();
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(0, 0)] }];
  const h = await previewMesh((await solve(doc, fem({ mesh: { size: 5, order: 2, curvature: 0, element: "hex" }, loads }))).dir);
  const q = h.quality!;
  assert.equal(q.elements, 80);
  assert.deepEqual(q.types, { hex20: 80 });
  near(q.volume, 10000, 1e-9);
  assert.ok(q.ok);
  const sj = q.metrics.find((x) => x.key === "sj")!;
  near(sj.min, 1, 1e-9);
  near(q.metrics.find((x) => x.key === "ar")!.max, 1, 1e-9); // cubos de 5 mm
  assert.equal(q.metrics.find((x) => x.key === "warp")!.max, 0);
  const layer = h.view!.layers[0];
  // 2·(20·2) + 2·(20·2) + 2·(2·2) = 168 faces exteriores, 4 arestas cada
  assert.equal(layer.edges!.length, 168 * 4 * 2);
  assert.deepEqual(h.view!.fields.map((f) => f.name), ["Jacobiano escalado", "Razão de aspeto"]);
  assert.deepEqual(h.warnings, []);
  // tetraedros com uma seed de 30 elementos na aresta longa: a discretização dessa aresta é imposta
  const t = await solve(doc, fem({ mesh: { size: 5, order: 1, curvature: 0, seeds: [{ edges: [edge(0, [0, 0])], mode: "count", value: 30 }] }, loads }));
  assert.equal(t.c.mesh.curves!.length, 1);
  const tp = await previewMesh(t.dir);
  const m = parseMsh(readFileSync(join(t.dir, "mesh.msh"), "utf8"));
  const onEdge = [...m.nodes.values()].filter((p) => Math.abs(p[1]) < 1e-9 && Math.abs(p[2]) < 1e-9);
  assert.equal(onEdge.length, 31);
  assert.ok(tp.quality!.metrics.some((x) => x.key === "shape"));
  assert.ok(tp.quality!.ok);
});

test("convergência ±3 níveis num ponto: 7 malhas, monotonia, extrapolação e erro da malha pedida", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 900000 }, async () => {
  assert.ok(isMonotonic([1, 1.5, 1.7, 1.75]) && isMonotonic([3, 2, 2, 1.9]) && !isMonotonic([1, 2, 1.5]));
  const { doc, face } = await bar();
  const { dir } = await solve(doc, fem({
    mesh: { size: 5, order: 2, curvature: 0, element: "hex" },
    loads: [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }],
    probes: [{ name: "Ponta", quantity: "uz", at: { kind: "point", point: [100, 5, 5] } }],
  }));
  const r = await runCase(dir, () => {}, false, { convergence: { ratio: 1.3, sweep: 3 } });
  const sw = r.convergence!.sweep!;
  assert.equal(sw.metric, "probe1");
  assert.deepEqual(sw.steps.map((x) => x.level), [3, 2, 1, 0, -1, -2, -3]);
  // tamanhos h·1,3^k e elementos a crescer do grosso para o fino
  sw.steps.forEach((x) => near(x.size, 5 * 1.3 ** x.level, 1e-9));
  assert.ok(sw.steps.every((x, i) => i === 0 || x.cells >= sw.steps[i - 1].cells));
  // a flecha na ponta converge (C3D20R) para Timoshenko; a malha pedida fica a < 1 % do extrapolado
  const row = r.convergence!.rows.find((x) => x.key === "probe1")!;
  near(-row.gci.extrapolated, delta, 0.02);
  assert.ok(sw.baseError! < 0.01, String(sw.baseError));
  assert.equal(r.convergence!.meshes.length, 3);
  assert.ok(r.summary.some(([k]) => /Sonda: Ponta/.test(k)));
});
