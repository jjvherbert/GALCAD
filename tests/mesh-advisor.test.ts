// Avaliador de malha (C9a): cada geometria-tipo dá a sugestão certa, aceitar melhora a métrica
// (e a sugestão desaparece), e o patch aplica-se/funde-se como um só passo de desfazer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import type { CadDocument } from "../src/doc/types.ts";
import { type FemStudy, type SimMesh, SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";
import { adviseMesh, biasFor } from "../src/kernel/mesh-advisor.ts";
import { suggestSweepCuts } from "../src/kernel/sweep-cuts.ts";
import { applyPatch, groupByBlock, mergePatches, type Suggestion } from "../src/sim/mesh-advice.ts";
import { ADVISOR_LIMITS } from "../src/sim/quality.ts";

before(initKernel);

const fem = (mesh: SimMesh): FemStudy => ({ ...newFemStudy("s1", 1), material: { ...SIM_MATERIALS[0] }, mesh, loads: [] });

/** Polígono fechado (sem cotas) extrudido `depth`. */
async function prism(pts: [number, number][], depth: number, holes: [number, number, number][] = []) {
  const s = new SketchBuilder();
  const ids = pts.map(([x, y]) => s.point(x, y));
  ids.forEach((p, i) => s.line(p, ids[(i + 1) % ids.length]));
  for (const [x, y, r] of holes) s.circle(x, y, r);
  let doc: CadDocument = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth } }).doc;
  const r = await new Engine().rebuild(doc);
  return r.ctx;
}

const box = (w: number, h: number, d: number, holes: [number, number, number][] = []) => prism([[0, 0], [w, 0], [w, h], [0, h]], d, holes);
const only = (a: { suggestions: Suggestion[] }, rule: Suggestion["rule"]) => a.suggestions.filter((s) => s.rule === rule);

test("biasFor: o 1.º elemento fica com o tamanho pedido", () => {
  const L = 50, n = 10, h0 = 0.5, b = biasFor(L, n, h0);
  const q = b ** (1 / (n - 1)), first = (L * (q - 1)) / (q ** n - 1);
  assert.ok(Math.abs(first - h0) < 1e-3 * h0, `${first}`);
  assert.equal(biasFor(L, n, L / n), 1);
});

test("placa fina: pede camadas pela espessura; aceitar resolve", async () => {
  const ctx = await box(100, 100, 2);
  const s = fem({ size: 5, order: 1, curvature: 0 });
  const a = adviseMesh(ctx, s);
  const [t] = only(a, "thin");
  assert.ok(t, JSON.stringify(a));
  assert.equal(t.patch.set?.layers, ADVISOR_LIMITS.thickness[1].value);
  assert.ok(t.why.includes(ADVISOR_LIMITS.thickness[1].source), t.why);
  assert.ok(t.metric && t.metric.before < ADVISOR_LIMITS.thickness[1].value && t.metric.after! >= ADVISOR_LIMITS.thickness[1].value);
  const b = adviseMesh(ctx, { ...s, mesh: applyPatch(s.mesh, t.patch) });
  assert.deepEqual(only(b, "thin"), []);
  // quadrático: o limite é 2
  assert.equal(only(adviseMesh(ctx, fem({ size: 5, order: 2, curvature: 0 })), "thin")[0]?.patch.set?.layers, ADVISOR_LIMITS.thickness[2].value);
});

test("furo com arco grosseiro: curvatura (tetraedros) ou seed por contagem (hexaedros)", async () => {
  const ctx = await box(100, 100, 10, [[50, 50, 20]]);
  const s = fem({ size: 20, order: 2, curvature: 0 });
  const [c] = only(adviseMesh(ctx, s), "arc");
  assert.ok(c);
  assert.equal(c.patch.set?.curvature, ADVISOR_LIMITS.curvatureSuggest.value);
  assert.ok(c.metric!.before > ADVISOR_LIMITS.arcMaxDeg.value && c.metric!.after! <= ADVISOR_LIMITS.arcMaxDeg.value, JSON.stringify(c.metric));
  assert.deepEqual(only(adviseMesh(ctx, { ...s, mesh: applyPatch(s.mesh, c.patch) }), "arc"), []);
  // com seeds manuais (ou hexaedros) a curvatura automática não chega: seed por contagem
  const h = fem({ size: 20, order: 2, curvature: 0, element: "hex", hexMethod: "subdivision" });
  const [k] = only(adviseMesh(ctx, h), "arc");
  assert.ok(k?.patch.addSeeds?.length, JSON.stringify(k));
  const n = Number(k.patch.addSeeds![0].value);
  assert.ok(360 / n <= ADVISOR_LIMITS.arcTargetDeg.value + 1e-9);
  assert.deepEqual(only(adviseMesh(ctx, { ...h, mesh: applyPatch(h.mesh, k.patch) }), "arc"), []);
});

test("aresta minúscula: sem topologia virtual, seed local com bias para a aresta", async () => {
  // chanfro de 0,42 mm num canto (tamanho 5 → < 10 %)
  const ctx = await prism([[0, 0], [50, 0], [50, 9.7], [49.7, 10], [0, 10]], 10);
  const s = fem({ size: 5, order: 2, curvature: 0 });
  const [t] = only(adviseMesh(ctx, s), "tiny");
  assert.ok(t);
  assert.match(t.why, /topologia virtual/i);
  const seed = t.patch.addSeeds![0];
  assert.equal(seed.biasAt, "vertex");
  assert.ok(Number(seed.bias) > 1 && seed.biasPoint);
  assert.ok(t.metric!.after! < t.metric!.before, JSON.stringify(t.metric));
  const b = adviseMesh(ctx, { ...s, mesh: applyPatch(s.mesh, t.patch) });
  assert.deepEqual(only(b, "tiny").filter((x) => x.id === t.id), []);
});

test("L com hexaedros: propõe partição em blocos; aceitar elimina a sugestão", async () => {
  const ctx = await prism([[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]], 10);
  const s = fem({ size: 5, order: 1, curvature: 0, element: "hex", hexMethod: "auto" });
  const [h] = only(adviseMesh(ctx, s), "hex");
  assert.ok(h?.patch.addPartitions?.length, JSON.stringify(h));
  assert.ok(h.preview.planes?.length);
  const b = adviseMesh(ctx, { ...s, mesh: applyPatch(s.mesh, h.patch) });
  assert.deepEqual(only(b, "hex"), []);
});

test("placa com furo em hexaedros: cortes pelo eixo do furo tornam tudo blocos", async () => {
  const ctx = await box(100, 100, 10, [[50, 50, 20]]);
  const s = fem({ size: 5, order: 1, curvature: 0, element: "hex", hexMethod: "auto" });
  const sc = suggestSweepCuts(ctx, s);
  assert.ok(sc, "sem cortes");
  assert.ok(sc.cuts.some((c) => c.kind === "axis"), JSON.stringify(sc.cuts.map((c) => c.key)));
  assert.equal(sc.after.blocks, sc.after.solids, JSON.stringify(sc.after));
  assert.ok(sc.before.blocks < sc.before.solids);
  const [h] = only(adviseMesh(ctx, s), "hex");
  assert.ok(h?.patch.addPartitions?.length, JSON.stringify(h));
  assert.equal(h.preview.planes?.length, h.patch.addPartitions!.length);
  assert.match(h.why, /eixos dos furos/);
  const b = adviseMesh(ctx, { ...s, mesh: applyPatch(s.mesh, h.patch) });
  assert.deepEqual(only(b, "hex"), []);
});

test("caixa simples em hexaedros: já é bloco, sem cortes nem sugestão", async () => {
  const ctx = await box(40, 20, 10);
  const s = fem({ size: 5, order: 1, curvature: 0, element: "hex", hexMethod: "auto" });
  assert.equal(suggestSweepCuts(ctx, s), null);
  assert.deepEqual(only(adviseMesh(ctx, s), "hex"), []);
});

test("Jacobiano negativo: refinamento local na face mais próxima; gradiente fica em nota", async () => {
  const ctx = await box(100, 10, 10);
  const s = fem({ size: 5, order: 2, curvature: 0 });
  const a = adviseMesh(ctx, s, [{ element: 7, sj: -0.2, ar: 3, center: [100, 5, 5] }, { element: 9, sj: 0.8, ar: 2, center: [0, 5, 5] }]);
  const [j] = only(a, "jacobian");
  assert.ok(j?.patch.addLocal?.length);
  assert.equal(j.patch.addLocal![0].faces.length, 1);
  assert.ok(Number(j.patch.addLocal![0].size) < 5);
  assert.ok(a.notes.some((n) => /gradiente/i.test(n)));
  assert.deepEqual(only(adviseMesh(ctx, s), "jacobian"), []);
});

test("mergePatches (Aceitar todas = um passo) e agrupamento por bloco", () => {
  const m = mergePatches([{ set: { layers: 2 } }, { set: { layers: 4, curvature: 24 }, addSeeds: [{ edges: [], mode: "count", value: 3 }] }, { addLocal: [{ faces: [], size: 1 }] }]);
  assert.deepEqual(m.set, { layers: 4, curvature: 24 });
  assert.equal(m.addSeeds?.length, 1);
  assert.equal(m.addLocal?.length, 1);
  const base: SimMesh = { size: 5, order: 2, seeds: [{ edges: [], mode: "size", value: 1 }] };
  const out = applyPatch(base, m);
  assert.equal(out.seeds?.length, 2);
  assert.equal(base.seeds?.length, 1, "o original não muda (desfazer)");
  const mk = (id: string, block: string): Suggestion => ({ id, rule: "thin", region: { block, label: "" }, patch: {}, preview: { tags: [] }, why: "" });
  assert.deepEqual(groupByBlock([mk("a", "Bloco 1"), mk("b", "Bloco 2"), mk("c", "Bloco 1")]).map((g) => [g.block, g.items.map((i) => i.id)]), [["Bloco 1", ["a", "c"]], ["Bloco 2", ["b"]]]);
});
