// Cascas S3/S6 (F4, fatia 2): deck do CalculiX, leitura do .frd de casca, qualidade e pré-visualização.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculixDeck } from "../src/sim/calculix.ts";
import { exteriorSurface, shellFrdBlocks, type FrdBlock } from "../src/sim/calculix-result.ts";
import { parseMsh } from "../src/sim/msh.ts";
import { meshQuality, triangleQuality } from "../src/sim/quality.ts";
import { meshPreview } from "../src/sim/meshview.ts";
import { type FemCase, type V3 } from "../src/sim/case.ts";
import { SIM_MATERIALS } from "../src/doc/study.ts";
import { runFem } from "../tools/cad-runner-fem.ts";

const steel = SIM_MATERIALS.find((x) => /S235/.test(x.name))!;

// placa 10×10 em z = 0: dois tri3 (ou um quad4), aresta x = 0 no grupo FIX
function plateMsh(quad = false): string {
  const elems = quad ? ["2 1 3 1", "2 1 2 3 4"] : ["2 1 2 2", "2 1 2 3", "3 1 3 4"];
  return [
    "$MeshFormat", "4.1 0 8", "$EndMeshFormat",
    "$PhysicalNames", "3", '1 1 "FIX"', '2 2 "SHELL"', '2 3 "P"', "$EndPhysicalNames",
    "$Entities", "0 1 1 0",
    "1 0 0 0 0 10 0 1 1 0",
    "1 0 0 0 10 10 0 2 2 3 0",
    "$EndEntities",
    "$Nodes", "1 4 1 4", "2 1 0 4", "1", "2", "3", "4", "0 0 0", "10 0 0", "10 10 0", "0 10 0", "$EndNodes",
    "$Elements", `2 ${quad ? 2 : 3} 1 ${quad ? 2 : 3}`, "1 1 1 1", "4 4 1", ...elems, "$EndElements",
  ].join("\n");
}

function plateCase(normal: V3 = [0, 0, 1]): FemCase {
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: "calculix", title: "Placa", analysis: "static", modes: 4,
    material: { ...steel }, groups: { P: [1] }, edgeGroups: { FIX: [1] },
    faces: [{ tag: 1, name: "F1", center: [5, 5, 0], area: 100, normal }],
    loads: [{ kind: "fixed", group: "FIX" }, { kind: "pressure", group: "P", p: 0.1 }],
    mesh: { size: 1, minSize: 0.1, curvature: 0, order: 1, local: [] },
    bbox: { min: [0, 0, 0], max: [10, 10, 0] }, hypotheses: [], shell: { thickness: 2 },
  } as FemCase;
}

const elemLines = (inp: string) => {
  const ls = inp.split("\n"), i = ls.findIndex((l) => l.startsWith("*ELEMENT"));
  return { header: ls[i], rows: ls.slice(i + 1, i + 3) };
};

test("casca: deck com S3, *SHELL SECTION, encastramento em 6 GL e pressão", () => {
  const { inp } = calculixDeck(plateCase(), parseMsh(plateMsh()));
  const { header, rows } = elemLines(inp);
  assert.match(header, /TYPE=S3/);
  assert.deepEqual(rows, ["1, 1, 2, 3", "2, 1, 3, 4"]);
  const ls = inp.split("\n"), s = ls.findIndex((l) => l.startsWith("*SHELL SECTION"));
  assert.ok(s >= 0);
  assert.equal(Number(ls[s + 1]), 2);
  assert.ok(ls.includes("N_FIX, 1, 6"));
  assert.match(inp, /\*DLOAD\n(\d+, P, -0\.1\n){2}/);
});

test("casca: a normal da face inverte a ordem dos nós", () => {
  const { rows } = elemLines(calculixDeck(plateCase([0, 0, -1]), parseMsh(plateMsh())).inp);
  assert.deepEqual(rows, ["1, 1, 3, 2", "2, 1, 4, 3"]);
});

test("casca: quadriláteros e análise térmica dão erro", () => {
  assert.throws(() => calculixDeck(plateCase(), parseMsh(plateMsh(true))), /quadriláteros/);
  assert.throws(() => calculixDeck({ ...plateCase(), analysis: "thermal" }, parseMsh(plateMsh())), /Casca: só um corpo/);
});

test("casca: .frd com base/meio/topo — tensões da face pior, deslocamentos do meio", () => {
  const m = parseMsh(plateMsh());
  const nodes = new Map<number, [number, number, number]>();
  for (const [t, p] of m.nodes) [-1, 0, 1].forEach((z, k) => nodes.set(3 * t - 2 + k, [p[0], p[1], z]));
  const disp = new Map<number, number[]>(), stress = new Map<number, number[]>();
  for (const t of m.nodes.keys()) {
    disp.set(3 * t - 1, [0, 0, t]);
    stress.set(3 * t - 2, [10, 0, 0, 0, 0, 0]);
    stress.set(3 * t - 1, [0, 0, 0, 0, 0, 0]);
    stress.set(3 * t, [-30, 0, 0, 0, 0, 0]);
  }
  const blocks: FrdBlock[] = [
    { name: "DISP", value: 1, components: ["D1", "D2", "D3"], data: disp },
    { name: "STRESS", value: 1, components: ["SXX", "SYY", "SZZ", "SXY", "SYZ", "SZX"], data: stress },
  ];
  const [d, s] = shellFrdBlocks(m, { nodes, blocks });
  assert.deepEqual([...d.data.keys()].sort(), [1, 2, 3, 4]);
  assert.deepEqual(d.data.get(3), [0, 0, 3]);
  assert.equal(s.data.get(2)![0], -30);
  nodes.delete(3 * 4 - 1);
  for (let k = 3 * 4 - 2; k <= 3 * 4; k++) nodes.delete(k);
  assert.throws(() => shellFrdBlocks(m, { nodes, blocks }), /o nó 4 da malha não aparece/);
});

test("casca: superfície, qualidade e pré-visualização", () => {
  const m = parseMsh(plateMsh());
  assert.equal(exteriorSurface(m, undefined, true).faces.length, 2);
  const q = triangleQuality([[0, 0, 0], [1, 0, 0], [0.5, Math.sqrt(3) / 2, 0]]);
  assert.ok(Math.abs(q.sj - 1) < 1e-9 && Math.abs(q.minAngle - 60) < 1e-9 && Math.abs(q.ar - 1) < 1e-9);
  assert.equal(meshQuality(m, undefined, true).types.tri3, 2);
  assert.ok(meshPreview(plateCase(), m).summary.some(([, v]) => /espessura/.test(v)));
});

test("casca: não com o OpenRadioss", async () => {
  await assert.rejects(runFem({ ...plateCase(), solver: "openradioss" }, ".", () => {}, false), /Cascas/);
});
