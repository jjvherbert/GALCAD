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
import { seedFractions, seedPreview } from "../src/kernel/sim-fem.ts";
import { namedEdges } from "../src/kernel/naming.ts";
import type { FemCase } from "../src/sim/case.ts";
import { elementsOf, parseMsh, solidBlocks } from "../src/sim/msh.ts";
import { faceIntegrals, lineIntegrals } from "../src/sim/elements.ts";
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

test("integrais das linhas: cargas nodais consistentes do seg2 e do seg3", () => {
  const s2 = lineIntegrals(1, [[0, 0, 0], [3, 4, 0]]);
  near(s2.length, 5, 1e-12);
  s2.nodal.forEach((x) => near(x, 2.5, 1e-12));
  // seg3 reto (nós de canto e depois o do meio): ∫Nᵢ ds = L/6, L/6, 2L/3
  const s3 = lineIntegrals(8, [[0, 0, 0], [0, 0, 6], [0, 0, 3]]);
  near(s3.length, 6, 1e-12);
  [1, 1, 4].forEach((x, i) => near(s3.nodal[i], x, 1e-9));
  near(s3.nodal.reduce((a, b) => a + b, 0), s3.length, 1e-12);
  assert.throws(() => lineIntegrals(26, [[0, 0, 0], [1, 0, 0]]), /sem funções de forma/);
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

test("seed junto a um vértice: pequenos na ponta mais próxima do ponto, seja qual for o sentido da aresta", async () => {
  const { doc, face, edge } = await bar();
  const r = await new Engine().rebuild(doc);
  const edges = [edge(0, [0, 0]), edge(0, [10, 0]), edge(0, [0, 10]), edge(0, [10, 10])];
  for (const [x, biasPoint] of [[100, [100, 0, 0]], [0, [0, 10, 10]]] as const) {
    const p = seedPreview(r.ctx, fem({ mesh: { size: 5, order: 1, seeds: [{ edges, mode: "count", value: 20, bias: 5, biasAt: "vertex", biasPoint: [...biasPoint] }] }, loads: [{ kind: "fixed", faces: [face(0, 0)] }] }));
    assert.deepEqual(p.warnings, []);
    const user = p.edges.filter((e) => e.kind === "user");
    assert.equal(user.length, 4);
    for (const e of user) {
      const dx = Array.from({ length: 20 }, (_, i) => ({ at: (e.points[3 * i] + e.points[3 * i + 3]) / 2, d: Math.abs(e.points[3 * i + 3] - e.points[3 * i]) }));
      const small = dx.reduce((a, b) => (b.d < a.d ? b : a));
      assert.ok(Math.abs(small.at - x) < 5, `menor elemento em x=${small.at}, esperado junto a ${x}`);
      near(Math.max(...dx.map((v) => v.d)) / small.d, 5, 1e-3);
    }
  }
});

test("pré-visualização das seeds: nós por aresta sem Gmsh (seed, propagadas, automáticas e distribuição)", async () => {
  const { doc, face, edge } = await bar();
  const r = await new Engine().rebuild(doc);
  const p = seedPreview(r.ctx, fem({ mesh: { size: 5, order: 1, element: "hex", seeds: [{ edges: [edge(0, [0, 0])], mode: "count", value: 40, bias: 4, biasAt: "start" }] }, loads: [{ kind: "fixed", faces: [face(0, 0)] }] }));
  assert.deepEqual(p.warnings, []);
  assert.equal(p.edges.length, 12);
  const along = p.edges.filter((e) => Math.abs(e.points[0] - e.points[e.points.length - 3]) > 50);
  assert.deepEqual(along.map((e) => e.n), [40, 40, 40, 40]);
  assert.deepEqual(along.map((e) => e.kind).sort(), ["propagated", "propagated", "propagated", "user"]);
  for (const e of along) {
    assert.equal(e.points.length, 41 * 3);
    // pontas nos vértices (x = 0 e x = 100) e razão maior/menor elemento = bias
    assert.deepEqual([e.points[0], e.points[120]].map((x) => Math.round(x)).sort((a, b) => a - b), [0, 100]);
    const dx = Array.from({ length: 40 }, (_, i) => Math.abs(e.points[3 * i + 3] - e.points[3 * i]));
    near(Math.max(...dx) / Math.min(...dx), 4, 1e-3);
  }
  assert.ok(p.edges.filter((e) => !along.includes(e)).every((e) => e.n === 2 && e.points.length === 9));
  // sem seeds e malha livre: tudo automático, n = comprimento / tamanho
  const q = seedPreview(r.ctx, fem({ mesh: { size: 5, order: 1 }, loads: [] }));
  assert.ok(q.edges.every((e) => e.kind === "auto"));
  assert.deepEqual([...new Set(q.edges.map((e) => e.n))].sort((a, b) => a - b), [2, 20]);
  // seed inválida não rebenta: vira aviso
  const w = seedPreview(r.ctx, fem({ mesh: { size: 5, order: 1, seeds: [{ edges: [], mode: "count", value: 4 }] }, loads: [] }));
  assert.ok(w.warnings.length > 0);
  assert.equal(w.edges.length, 12);
});

test("frações dos nós: uniforme, progressão e bump simétrico", () => {
  assert.deepEqual(seedFractions(4), [0, 0.25, 0.5, 0.75, 1]);
  const g = seedFractions(3, { progression: 2 });
  [0, 1 / 7, 3 / 7, 1].forEach((x, i) => near(g[i], x, 1e-9));
  const b = seedFractions(10, { bump: 0.25 });
  for (let i = 0; i <= 10; i++) near(b[i] + b[10 - i], 1, 1e-6);
  assert.ok(b[1] - b[0] < b[6] - b[5]);
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

test("face mapeada triangular: as 3 arestas com o mesmo n.º de elementos e o Gmsh malha-a", async () => {
  const s = new SketchBuilder();
  const [a, b, c] = [s.point(0, 0), s.point(40, 0), s.point(0, 30)];
  s.line(a, b); s.line(b, c); s.line(c, a);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const top = r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[2]) - 1) < 1e-9 && Math.abs(p.center[2] - 10) < 1e-6; })!;
  const e0 = namedEdges(r.ctx.body!).find((x) => { const p = edgeProps(x.edge); return Math.abs(p.mid[2] - 10) < 1e-6 && Math.abs(p.mid[1]) < 1e-6; })!;
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [{ kind: "face", name: top.name }] }];
  const t = await solve(doc, fem({ mesh: { size: 5, order: 1, curvature: 0, mapped: [{ kind: "face", name: top.name }], seeds: [{ edges: [{ kind: "edge", name: e0.name }], mode: "count", value: 6 }] }, loads }));
  const onTop = t.c.mesh.curves!.filter((x) => Math.abs(x.box.min[2] - 10) < 1e-6 && Math.abs(x.box.max[2] - 10) < 1e-6);
  assert.equal(onTop.length, 3);
  assert.deepEqual(onTop.map((x) => x.n), [6, 6, 6]);
  assert.equal(t.c.mesh.surfaces!.length, 1);
  assert.ok(t.c.hypotheses.some((h) => h.includes("1 face(s) mapeada(s) triangular(es)")));
  if (!T.gmsh) return;
  const h = await previewMesh(t.dir);
  assert.ok(h.quality!.elements > 0);
  near(h.quality!.volume, 6000, 1e-6);
});

test("camadas na espessura: chapa fina com ≥ 3 elementos nas arestas de 2 mm (tetraedros e hexaedros)", async () => {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 50, 100, 50);
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 2 } }).doc;
  const r = await new Engine().rebuild(doc);
  const left = r.ctx.body!.faces.find((x) => { const p = faceProps(x.face); return p.normal && Math.abs(Math.abs(p.normal[0]) - 1) < 1e-9 && Math.abs(p.center[0]) < 1e-6; })!;
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [{ kind: "face", name: left.name }] }];
  const thick = (c: { box: { min: number[]; max: number[] } }) => Math.abs(c.box.max[2] - c.box.min[2] - 2) < 1e-6 && Math.abs(c.box.max[0] - c.box.min[0]) < 1e-6;
  const tet = await solve(doc, fem({ mesh: { size: 10, order: 1, curvature: 0, layers: 3 }, loads }));
  const tc = tet.c.mesh.curves!.filter(thick);
  assert.equal(tc.length, 4);
  assert.ok(tc.every((x) => x.n === 3 && !x.user));
  assert.equal(tet.c.mesh.curves!.length, 4, "só as arestas da espessura");
  assert.ok(tet.c.hypotheses.some((h) => h.includes("4 aresta(s) na espessura com ≥ 3 elementos")));
  const hex = await solve(doc, fem({ mesh: { size: 10, order: 1, curvature: 0, layers: 3, element: "hex" }, loads }));
  assert.deepEqual(hex.c.mesh.curves!.filter(thick).map((x) => x.n), [3, 3, 3, 3]);
  // sem camadas: 1 elemento na espessura (tamanho 10 > 2 mm)
  const none = await solve(doc, fem({ mesh: { size: 10, order: 1, curvature: 0, element: "hex" }, loads }));
  assert.deepEqual(none.c.mesh.curves!.filter(thick).map((x) => x.n), [1, 1, 1, 1]);
  if (!T.gmsh) return;
  const h = await previewMesh(tet.dir);
  near(h.quality!.volume, 10000, 1e-6);
});

test("partições: perfil em L dividido em 3 blocos dá hexaedros estruturados, com cargas nas sub-faces", async () => {
  const s = new SketchBuilder();
  const p = [[0, 0], [100, 0], [100, 20], [20, 20], [20, 60], [0, 60]].map(([x, y]) => s.point(x, y));
  p.forEach((a, i) => s.line(a, p[(i + 1) % p.length]));
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = r.ctx.body!.faces.find((x) => { const q = faceProps(x.face); return q.normal && Math.abs(Math.abs(q.normal[axis]) - 1) < 1e-9 && Math.abs(q.center[axis] - v) < 1e-6; })!;
    return { kind: "face", name: f.name };
  };
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(1, 60)] }, { kind: "force", faces: [face(0, 100)], f: [0, -100, 0] }];
  // sem partições o L não é um bloco: subdivisão
  const plain = await solve(doc, fem({ mesh: { size: 5, order: 1, curvature: 0, element: "hex" }, loads }));
  assert.equal(plain.c.mesh.hexMethod, "subdivision");
  const cut = await solve(doc, fem({ mesh: { size: 5, order: 1, curvature: 0, element: "hex", partitions: [{ axis: "x", at: 20 }, { axis: "y", at: 20 }], local: [{ faces: [face(2, 10)], size: 4 }] }, loads }));
  const m = cut.c.mesh;
  assert.equal(m.hexMethod, "structured");
  assert.deepEqual(m.volumes, [1, 2, 3]);
  assert.equal(cut.c.faces.filter((f) => f.name.startsWith("corte ")).length, 2);
  // a face de topo (z = 10) foi dividida em 3 sub-faces; as das cargas ficam inteiras
  const g = cut.c.groups;
  const vals = Object.values(g);
  assert.equal(g.R1.length, 3, JSON.stringify(g));
  assert.equal(vals.filter((t) => t.length === 1).length, 2, JSON.stringify(g));
  assert.ok(cut.c.hypotheses.some((h) => h.includes("dividem o sólido em 3 blocos")));
  // plano fora do sólido
  assert.throws(() => studyCase(r.ctx, fem({ mesh: { size: 5, order: 1, partitions: [{ axis: "x", at: 200 }] }, loads })), /não atravessa o sólido/);
  if (!T.gmsh) return;
  const h = await previewMesh(cut.dir);
  near(h.quality!.volume, (100 * 20 + 20 * 40) * 10, 1e-6);
});

test("partições: plano inclinado x + y = 50 corta o perfil em L em 3 blocos", async () => {
  const s = new SketchBuilder();
  const p = [[0, 0], [100, 0], [100, 20], [20, 20], [20, 60], [0, 60]].map(([x, y]) => s.point(x, y));
  p.forEach((a, i) => s.line(a, p[(i + 1) % p.length]));
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc;
  const r = await new Engine().rebuild(doc);
  const face = (axis: 0 | 1 | 2, v: number): TopoRef => {
    const f = r.ctx.body!.faces.find((x) => { const q = faceProps(x.face); return q.normal && Math.abs(Math.abs(q.normal[axis]) - 1) < 1e-9 && Math.abs(q.center[axis] - v) < 1e-6; })!;
    return { kind: "face", name: f.name };
  };
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(1, 60)] }, { kind: "force", faces: [face(0, 100)], f: [0, -100, 0] }];
  // n̂ = (1,1,0)/√2 e d = 50/√2: o plano x + y = 50 atravessa os dois braços do L (a normal não precisa de ser unitária)
  const cut = await solve(doc, fem({ mesh: { size: 5, order: 1, curvature: 0, partitions: [{ axis: "n", normal: [2, 2, 0], at: "50 / sqrt(2)" }] }, loads }));
  // os blocos (pentágonos/trapézios extrudidos) não são hexaédricos: só a malha tetraédrica fica conforme
  assert.equal(cut.c.faces.filter((f) => f.name.startsWith("corte ")).length, 2);
  assert.ok(cut.c.hypotheses.some((h) => h.includes("dividem o sólido em 3 blocos")), JSON.stringify(cut.c.hypotheses));
  // as cargas continuam numa só face cada (o corte não lhes toca)
  assert.equal(Object.values(cut.c.groups).filter((t) => t.length === 1).length, 2, JSON.stringify(cut.c.groups));
  assert.throws(() => studyCase(r.ctx, fem({ mesh: { size: 5, order: 1, partitions: [{ axis: "n", normal: [0, 0, 0], at: 1 }] }, loads })), /normal do plano não pode ser nula/);
  assert.throws(() => studyCase(r.ctx, fem({ mesh: { size: 5, order: 1, partitions: [{ axis: "n", normal: [1, 1, 0], at: 200 }] }, loads })), /não atravessa o sólido/);
  if (!T.gmsh) return;
  const h = await previewMesh(cut.dir);
  near(h.quality!.volume, (100 * 20 + 20 * 40) * 10, 1e-6);
});

test("CalculiX: malha editada à mão — nó movido e elemento apagado chegam ao solver", { skip: !hasFem && "Gmsh/CalculiX não instalados", timeout: 600000 }, async () => {
  const { doc, face } = await bar();
  const loads: FemStudy["loads"] = [{ kind: "fixed", faces: [face(0, 0)] }, { kind: "force", faces: [face(0, 100)], f: [0, 0, -F] }];
  const s0 = await solve(doc, fem({ mesh: { size: 5, order: 1, element: "hex" }, loads }));
  const base = await s0.run();
  assert.ok(base.ok, JSON.stringify(base));
  // apaga o hexaedro de 5 mm com centro em (52.5, 2.5, 7.5) e puxa o canto (50, 0, 10) 1 mm para fora
  const edits = [{ kind: "delete" as const, at: [52.5, 2.5, 7.5] as [number, number, number] }, { kind: "move" as const, at: [50, 0, 10] as [number, number, number], to: [50, -1, 10] as [number, number, number] }];
  const s = await solve(doc, fem({ mesh: { size: 5, order: 1, element: "hex", edits }, loads }));
  assert.ok(s.c.hypotheses.some((h) => /Malha editada à mão/.test(h)));
  const r = await s.run();
  assert.ok(r.ok, JSON.stringify(r));
  // n.º de hexaedros escritos no deck: linhas de dados dos cartões *ELEMENT, TYPE=C3D8…
  const hexes = (dir: string) => {
    let on = false, n = 0;
    for (const l of readFileSync(join(dir, "job.inp"), "utf8").split(/\r?\n/)) {
      if (l.startsWith("*")) on = /^\*ELEMENT\b.*TYPE\s*=\s*C3D8/i.test(l);
      else if (on && /^\s*\d+\s*,/.test(l)) n++;
    }
    return n;
  };
  const n0 = hexes(s0.dir);
  assert.ok(n0 > 0, "o deck de base tem de ter hexaedros");
  assert.equal(hexes(s.dir), n0 - 1, "o elemento apagado não pode chegar ao CalculiX");
  const f = r.fem!;
  let moved = false;
  for (let i = 0; i < f.positions.length; i += 3) if (Math.hypot(f.positions[i] - 50, f.positions[i + 1] + 1, f.positions[i + 2] - 10) < 1e-6) moved = true;
  assert.ok(moved, "o nó movido tem de estar na posição nova nos resultados");
  // um furo de 1/80 do volume a meio vão amolece a consola, mas pouco; a reação continua a equilibrar a carga
  const w0 = tip(base).w, w1 = tip(r).w;
  assert.ok(w1 > w0 && w1 < 1.05 * w0, `${w1} vs ${w0}`);
  near(tip(r).R, F, 1e-3);
});
