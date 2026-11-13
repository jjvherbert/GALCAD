// Laminado em casca (F4, fatia 3): *SHELL SECTION COMPOSITE com uma orientação por camada (S6) e a
// leitura do .frd com OUTPUT=2D (nós expandidos por camada; com uma só camada, a leitura de casca).
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculixDeck } from "../src/sim/calculix.ts";
import { shellFrdBlocks, type FrdBlock } from "../src/sim/calculix-result.ts";
import { parseMsh } from "../src/sim/msh.ts";
import { type FemCase } from "../src/sim/case.ts";
import { type OrthoPly } from "../src/sim/laminate.ts";
import { SIM_MATERIALS } from "../src/doc/study.ts";

const steel = SIM_MATERIALS.find((x) => /S235/.test(x.name))!;

// placa 10×10 em z = 0 com dois tri6; aresta x = 0 (line3 4–1–9) no grupo FIX
function plateMsh(order: 1 | 2 = 2): string {
  const nodes = order === 2 ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 4];
  const xyz = ["0 0 0", "10 0 0", "10 10 0", "0 10 0", "5 0 0", "10 5 0", "5 5 0", "5 10 0", "0 5 0"].slice(0, nodes.length);
  const edge = order === 2 ? ["1 1 8 1", "1 4 1 9"] : ["1 1 1 1", "1 4 1"];
  const tris = order === 2 ? ["2 1 9 2", "1 1 2 3 5 6 7", "2 1 3 4 7 8 9"] : ["2 1 2 2", "1 1 2 3", "2 1 3 4"];
  return [
    "$MeshFormat", "4.1 0 8", "$EndMeshFormat",
    "$PhysicalNames", "3", '1 1 "FIX"', '2 2 "SHELL"', '2 3 "P"', "$EndPhysicalNames",
    "$Entities", "0 1 1 0",
    "1 0 0 0 0 10 0 1 1 0",
    "1 0 0 0 10 10 0 2 2 3 0",
    "$EndEntities",
    "$Nodes", `1 ${nodes.length} 1 ${nodes.length}`, `2 1 0 ${nodes.length}`, ...nodes.map(String), ...xyz, "$EndNodes",
    "$Elements", "2 4 1 4", ...edge, ...tris, "$EndElements",
  ].join("\n");
}

const ply = (theta: number, t = 0.5): OrthoPly => ({ e1: 40000, e2: 10000, g12: 4000, nu12: 0.3, t, theta, label: `UD ${theta}°` });

function lamCase(plies: OrthoPly[] = [ply(0), ply(90)]): FemCase {
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: "calculix", title: "Placa laminada", analysis: "static", modes: 4,
    material: { ...steel, density: 1600 }, groups: { P: [1] }, edgeGroups: { FIX: [1] },
    faces: [{ tag: 1, name: "F1", center: [5, 5, 0], area: 100, normal: [0, 0, 1] }],
    loads: [{ kind: "fixed", group: "FIX" }, { kind: "pressure", group: "P", p: 0.01 }],
    mesh: { size: 5, minSize: 0.1, curvature: 0, order: 2, local: [] },
    bbox: { min: [0, 0, 0], max: [10, 10, 0] }, hypotheses: [],
    shell: { thickness: plies.reduce((s, p) => s + p.t, 0), plies },
  } as FemCase;
}

test("laminado: um material e uma orientação por camada e *SHELL SECTION COMPOSITE", () => {
  const { inp } = calculixDeck(lamCase(), parseMsh(plateMsh()));
  const ls = inp.split("\n");
  assert.match(inp, /TYPE=S6/);
  const m1 = ls.indexOf("*MATERIAL, NAME=MAT_P1");
  assert.ok(m1 >= 0 && ls.includes("*MATERIAL, NAME=MAT_P2"));
  const e = ls.indexOf("*ELASTIC, TYPE=ENGINEERING CONSTANTS", m1);
  assert.deepEqual(ls[e + 1].split(", ").map(Number), [40000, 10000, 10000, 0.3, 0.3, 0.3, 4000, 4000]);
  const [g23, temp] = ls[e + 2].split(", ").map(Number);
  assert.ok(Math.abs(g23 - 10000 / 2.6) < 1e-3 && temp === 0);
  const o2 = ls.indexOf("*ORIENTATION, NAME=OR_P2, SYSTEM=RECTANGULAR");
  assert.deepEqual(ls[o2 + 1].split(", ").map(Number), [1, 0, 0, 0, 1, 0]);
  assert.equal(ls[o2 + 2], "3, 90");
  const s = ls.indexOf("*SHELL SECTION, ELSET=EALL, COMPOSITE");
  assert.deepEqual(ls.slice(s + 1, s + 3), ["0.5, , MAT_P1, OR_P1", "0.5, , MAT_P2, OR_P2"]);
  assert.ok(!inp.includes("MATERIAL=MAT\n"));
  assert.ok(ls.includes("*NODE FILE, OUTPUT=2D") && ls.includes("*EL FILE, OUTPUT=2D"));
});

test("laminado: eixo de referência dado e casca isotrópica sem OUTPUT=2D", () => {
  const c = lamCase();
  c.shell!.axis = [0, 1, 0];
  const ls = calculixDeck(c, parseMsh(plateMsh())).inp.split("\n");
  const o = ls.indexOf("*ORIENTATION, NAME=OR_P1, SYSTEM=RECTANGULAR");
  assert.deepEqual(ls[o + 1].split(", ").map(Number).map((x) => x + 0), [0, 1, 0, -1, 0, 0]);
  const iso = lamCase();
  delete iso.shell!.plies;
  const inp = calculixDeck(iso, parseMsh(plateMsh())).inp;
  assert.ok(inp.includes("*SHELL SECTION, ELSET=EALL, MATERIAL=MAT") && !inp.includes("OUTPUT=2D"));
});

test("laminado: uma só camada — COMPOSITE sem OUTPUT=2D e leitura normal de casca", () => {
  const ls = calculixDeck(lamCase([ply(0, 1)]), parseMsh(plateMsh())).inp.split("\n");
  const s = ls.indexOf("*SHELL SECTION, ELSET=EALL, COMPOSITE");
  assert.equal(ls[s + 1], "1, , MAT_P1, OR_P1");
  assert.ok(!ls.some((l) => l.includes("OUTPUT=2D")));
  // como o ccx: 3 nós expandidos por nó da malha a seguir ao maior (nk + 3(t-1) + 1…3), sem o do meio
  // nos nós intermédios (t > 4)
  const m = parseMsh(plateMsh()), nk = 9;
  const disp = new Map<number, number[]>(), stress = new Map<number, number[]>();
  for (let t = 1; t <= 9; t++)
    for (let k = 0; k < 3; k++) {
      if (t > 4 && k === 1) continue;
      disp.set(nk + 3 * (t - 1) + 1 + k, [0, 0, t]);
      stress.set(nk + 3 * (t - 1) + 1 + k, [k === 2 ? 10 * t : 1, 0, 0, 0, 0, 0]);
    }
  const blocks: FrdBlock[] = [
    { name: "DISP", value: 1, components: ["D1", "D2", "D3"], data: disp },
    { name: "STRESS", value: 1, components: ["SXX", "SYY", "SZZ", "SXY", "SYZ", "SZX"], data: stress },
  ];
  const nodes = new Map<number, [number, number, number]>();
  for (let t = 1; t <= 9; t++) {
    const p = m.nodes.get(t)!;
    nodes.set(nk + 3 * (t - 1) + 1, [p[0], p[1], p[2] - 0.5]);
    if (t <= 4) nodes.set(nk + 3 * (t - 1) + 2, [p[0], p[1], p[2]]);
    nodes.set(nk + 3 * (t - 1) + 3, [p[0], p[1], p[2] + 0.5]);
  }
  const [d, st] = shellFrdBlocks(m, { nodes, blocks }, 1);
  assert.deepEqual(d.data.get(7), [0, 0, 7]);
  for (let t = 1; t <= 9; t++) assert.equal(st.data.get(t)![0], 10 * t);
  assert.equal(d.data.size, 9);
});

test("laminado: erros com malha linear e análise não estática", () => {
  const c = lamCase();
  c.mesh.order = 1;
  assert.throws(() => calculixDeck(c, parseMsh(plateMsh(1))), /requer malha de ordem 2/);
  const f = lamCase();
  f.analysis = "modal";
  assert.throws(() => calculixDeck(f, parseMsh(plateMsh())), /só análise estática/);
});

test("laminado: .frd com OUTPUT=2D — deslocamentos nos nós da malha, tensões no nível com maior von Mises", () => {
  const m = parseMsh(plateMsh());
  const nk = 9, B = 3 + 3 * 2;
  const disp = new Map<number, number[]>(), stress = new Map<number, number[]>();
  for (let t = 1; t <= 9; t++) {
    disp.set(t, [0, 0, t]);
    const corner = t <= 4, ids = corner ? [4, 5, 6, 7, 8, 9] : [4, 6, 7, 9];
    // canto: últimos 3n do bloco; intermédio: base e topo de cada camada (o topo da camada 2 é o máximo)
    for (const k of ids) stress.set(nk + B * (t - 1) + k, [k === 9 ? 100 * t : k, 0, 0, 0, 0, 0]);
  }
  const blocks: FrdBlock[] = [
    { name: "DISP", value: 1, components: ["D1", "D2", "D3"], data: disp },
    { name: "STRESS", value: 1, components: ["SXX", "SYY", "SZZ", "SXY", "SYZ", "SZX"], data: stress },
  ];
  const [d, s] = shellFrdBlocks(m, { nodes: new Map(), blocks }, 2);
  assert.deepEqual(d.data.get(7), [0, 0, 7]);
  assert.equal(s.data.size, 9);
  for (let t = 1; t <= 9; t++) assert.equal(s.data.get(t)![0], 100 * t);
  disp.delete(4);
  assert.throws(() => shellFrdBlocks(m, { nodes: new Map(), blocks }, 2), /o nó 4 da malha não aparece/);
});
