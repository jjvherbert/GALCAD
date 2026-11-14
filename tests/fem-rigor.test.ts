// F3 fatia 1: fator de segurança por corpo com o material de cada corpo, guardas do GCI e condutividade
// térmica obrigatória (sem valores por defeito escondidos).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FS_FIELD_CAP, femResultFrom, type FrdBlock } from "../src/sim/calculix-result.ts";
import { femView } from "../src/sim/result.ts";
import { calculixDeck } from "../src/sim/calculix.ts";
import { gci } from "../src/sim/convergence.ts";
import { checkStudy } from "../src/sim/modelcheck.ts";
import { parseMsh } from "../src/sim/msh.ts";
import type { FemCase } from "../src/sim/case.ts";
import { SIM_MATERIALS, newFemStudy } from "../src/doc/study.ts";

// dois tetraedros separados: volume 1 → corpo B1 (nós 1–4), volume 2 → corpo B2 (nós 5–8)
const MSH = `$MeshFormat
4.1 0 8
$EndMeshFormat
$PhysicalNames
2
3 1 "B1"
3 2 "B2"
$EndPhysicalNames
$Entities
0 0 0 2
1 0 0 0 1 1 1 1 1 0
2 2 0 0 3 1 1 1 2 0
$EndEntities
$Nodes
2 8 1 8
3 1 0 4
1
2
3
4
0 0 0
1 0 0
0 1 0
0 0 1
3 2 0 4
5
6
7
8
2 0 0
3 0 0
2 1 0
2 0 1
$EndNodes
$Elements
2 2 1 2
3 1 4 1
1 1 2 3 4
3 2 4 1
2 5 6 7 8
$EndElements
`;

const steel = SIM_MATERIALS.find((x) => /S235/.test(x.name))!;
const alu = SIM_MATERIALS.find((x) => /5083/.test(x.name))!;
const box = { min: [0, 0, 0] as [number, number, number], max: [3, 1, 1] as [number, number, number] };
const base: FemCase = {
  format: "cadp-sim-case", version: 1, physics: "fem", solver: "calculix", title: "Dois corpos", analysis: "static", modes: 4,
  material: { ...steel }, groups: {}, faces: [], loads: [],
  mesh: { size: 1, minSize: 0.1, curvature: 0, order: 1, local: [] }, bbox: box, hypotheses: [],
  bodies: [
    { group: "B1", path: "p1", name: "Chapa", material: { ...steel }, bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
    { group: "B2", path: "p2", name: "Perfil", material: { ...alu }, bbox: { min: [2, 0, 0], max: [3, 1, 1] } },
  ],
};
const nodes = [1, 2, 3, 4, 5, 6, 7, 8];
const blocks: FrdBlock[] = [
  { name: "DISP", value: 1, components: ["D1", "D2", "D3"], data: new Map(nodes.map((n) => [n, [0, 0, 0]])) },
  { name: "VMIS", value: 1, components: ["VM"], data: new Map(nodes.map((n) => [n, [n === 2 ? 150 : n === 7 ? 100 : 10]])) },
];
const dat = { frequencies: [], buckling: [], reactions: [], reactionHistory: [] } as unknown as Parameters<typeof femResultFrom>[3];
const row = (r: ReturnType<typeof femResultFrom>, label: string) => r.summary.find(([k]) => k === label)?.[1];

test("FS por corpo: cada corpo com a sua cedência; governa o menor (alumínio a 100 MPa, não o aço a 150)", () => {
  const r = femResultFrom(base, parseMsh(MSH), blocks, dat);
  assert.equal(r.metrics.find((x) => x.key === "vmmax")!.value, 150);
  const fs = r.metrics.find((x) => x.key === "fsmin")!.value;
  assert.ok(Math.abs(fs - alu.yield! / 100) < 1e-12, `${fs}`);
  assert.match(row(r, "Fator de segurança mín. (cedência)")!, /^1\.25 — Perfil \(Alumínio/);
  assert.match(row(r, "Fator de segurança — Chapa")!, /^1\.57 \(σ von Mises máx\. 150\.00 MPa; cedência 235 MPa/);
  assert.match(row(r, "Fator de segurança — Perfil")!, /^1\.25 /);
});

test("FS por corpo: corpo sem cedência fica identificado e não governa", () => {
  const c = { ...base, bodies: [base.bodies![0], { ...base.bodies![1], material: { ...alu, yield: undefined } }] };
  const r = femResultFrom(c, parseMsh(MSH), blocks, dat);
  assert.ok(Math.abs(r.metrics.find((x) => x.key === "fsmin")!.value - 235 / 150) < 1e-12);
  assert.match(row(r, "Fator de segurança — Perfil")!, /^sem tensão de cedência/);
});

test("FS de peça única: material do estudo sobre todos os nós, sem linhas por corpo", () => {
  // os dois volumes no grupo SOLID (peça única)
  const one = MSH.replace(`2\n3 1 "B1"\n3 2 "B2"`, `1\n3 1 "SOLID"`).replace("2 2 0 0 3 1 1 1 2 0", "2 2 0 0 3 1 1 1 1 0");
  const r = femResultFrom({ ...base, bodies: undefined, material: { ...alu } }, parseMsh(one), blocks, dat);
  assert.equal(row(r, "Fator de segurança mín. (cedência)"), (alu.yield! / 150).toFixed(2));
  assert.ok(!r.summary.some(([k]) => k.startsWith("Fator de segurança —")));
});

test("FS sem tensões: «não aplicável» em vez de cedência/1e-12; corpo sem tensão não governa", () => {
  const zero = (pick: (n: number) => number): FrdBlock[] => [blocks[0], { ...blocks[1], data: new Map(nodes.map((n) => [n, [pick(n)]])) }];
  const r = femResultFrom(base, parseMsh(MSH), zero(() => 0), dat);
  assert.ok(!r.metrics.some((x) => x.key === "fsmin"));
  assert.match(row(r, "Fator de segurança mín. (cedência)")!, /^não aplicável: tensões nulas/);
  const one = femResultFrom(base, parseMsh(MSH), zero((n) => (n === 2 ? 150 : 0)), dat);
  assert.ok(Math.abs(one.metrics.find((x) => x.key === "fsmin")!.value - 235 / 150) < 1e-12);
  assert.equal(row(one, "Fator de segurança — Perfil"), "não aplicável: sem tensões no corpo");
});

test("GCI: entradas inválidas dão comportamento «invalid» com NaN em vez de um GCI enganador", () => {
  const n: [number, number, number] = [8000, 2370, 702];
  for (const [nn, f, why] of [
    [[702, 2370, 8000], [1, 1.1, 1.2], /refinadas por ordem/],
    [[8000, 8000, 702], [1, 1.1, 1.2], /refinadas por ordem/],
    [n, [1, NaN, 1.2], /não finitos/],
    [[0, 2370, 702], [1, 1.1, 1.2], /não finitos/],
    [n, [0, 0.1, 0.3], /Valor nulo na malha fina/],
    [n, [1, 1.1, 1.1], /Ordem aparente indefinida/],
  ] as [[number, number, number], [number, number, number], RegExp][]) {
    const g = gci(nn, f);
    assert.equal(g.behaviour, "invalid", `${nn} ${f}`);
    assert.ok(Number.isNaN(g.gciFine) && Number.isNaN(g.p) && Number.isNaN(g.extrapolated));
    assert.ok(g.notes.some((x) => why.test(x)), g.notes.join(" | "));
  }
  // valor nulo nas duas malhas finas continua a ser «convergida»
  assert.equal(gci(n, [0, 0, 0.3]).behaviour, "converged");
});

test("Térmico: falta de k é erro na verificação e no deck (sem os 50 W/(m·K) por defeito)", () => {
  const s = { ...newFemStudy("s1", 1), analysis: "thermal" as const };
  s.material = { ...steel, k: undefined };
  assert.ok(checkStudy(s).some((i) => i.level === "erro" && /condutividade térmica k do material Aço S235JR/.test(i.text)));
  s.material = { ...steel };
  assert.ok(!checkStudy(s).some((i) => /condutividade/.test(i.text)));
  s.bodyMaterials = { p2: { ...alu, k: 0 } };
  assert.ok(!checkStudy(s).some((i) => /condutividade/.test(i.text)), "materiais de corpos só contam em montagem");
  assert.ok(checkStudy(s, true).some((i) => i.level === "erro" && /k do material Alumínio/.test(i.text)));
  const c: FemCase = { ...base, analysis: "thermal", bodies: [base.bodies![0], { ...base.bodies![1], material: { ...alu, k: undefined } }] };
  assert.throws(() => calculixDeck(c, parseMsh(MSH)), /material Alumínio EN AW-5083 H111 não tem condutividade térmica k/);
});

test("Plasticidade multilinear: *PLASTIC com os pontos (σ, εp) da curva; o corpo bilinear continua com 2 pontos", () => {
  const curve = { ...steel, tangent: undefined, plasticCurve: [[235, 0], [270, 0.01], [320, 0.05]] as [number, number][] };
  const nl = { geometry: false, plasticity: true, increments: 8 };
  const c: FemCase = { ...base, nonlinear: nl, bodies: [{ ...base.bodies![0], material: curve }, base.bodies![1]] };
  const inp = calculixDeck(c, parseMsh(MSH)).inp;
  const plastic = (name: string) => inp.match(new RegExp(`\\*MATERIAL, NAME=${name}\\n[^]*?\\*PLASTIC\\n((?:[^*\\n][^\\n]*\\n)+)`))?.[1].trimEnd().split("\n");
  assert.deepEqual(plastic("MAT_B1"), ["235, 0", "270, 0.01", "320, 0.05"]);
  // alumínio bilinear: σy e σy + Hp a εp = 1
  const al = plastic("MAT_B2")!;
  assert.equal(al.length, 2);
  assert.equal(al[0], `${alu.yield}, 0.`);
  // sem plasticidade, nenhuma curva entra no deck
  assert.ok(!/\*PLASTIC/.test(calculixDeck({ ...c, nonlinear: undefined }, parseMsh(MSH)).inp));
});

test("FS como campo: cedência/σvm por nó, cada corpo com a sua cedência, teto em FS_FIELD_CAP e escala invertida", () => {
  const r = femResultFrom(base, parseMsh(MSH), blocks, dat);
  const f = r.fields.find((x) => x.name === "Fator de segurança (cedência)")!;
  assert.ok(f && f.reverse, "campo com escala invertida");
  assert.ok(Math.abs(Math.min(...f.values) - alu.yield! / 100) < 1e-12, "mínimo = alumínio a 100 MPa");
  assert.ok(f.values.some((x) => Math.abs(x - 235 / 150) < 1e-12), "aço a 150 MPa");
  assert.equal(Math.max(...f.values), FS_FIELD_CAP);
  assert.equal(femView(r).fields.find((x) => x.name === f.name)?.reverse, true);
});

test("FS como campo: ausente com plasticidade ou sem cedência em nenhum material", () => {
  const plast = femResultFrom({ ...base, nonlinear: { plasticity: true } } as FemCase, parseMsh(MSH), blocks, dat);
  assert.ok(!plast.fields.some((x) => x.name.startsWith("Fator de segurança")));
  const noY = (m: typeof steel) => ({ ...m, yield: undefined });
  const c = { ...base, bodies: base.bodies!.map((b) => ({ ...b, material: noY(b.material) })) };
  assert.ok(!femResultFrom(c, parseMsh(MSH), blocks, dat).fields.some((x) => x.name.startsWith("Fator de segurança")));
});
