// Adaptador code_aster: malha ASTER, comandos e leitura das tabelas (sem o solver — o code_aster não
// está instalado nesta máquina; a verificação numérica fica por fazer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { asterCase, asterMesh, asterNode, asterResult, parseAsterTable } from "../src/sim/aster.ts";
import { calculixDeck, springWeights } from "../src/sim/calculix.ts";
import { parseMsh } from "../src/sim/msh.ts";
import type { FemCase } from "../src/sim/case.ts";
import { SIM_MATERIALS } from "../src/doc/study.ts";

// um tetraedro unitário: faces x = 0 (TOP no exemplo) e volume
const MSH = `$MeshFormat
4.1 0 8
$EndMeshFormat
$PhysicalNames
3
2 1 "L1_FIXED"
2 3 "L2_FORCE"
3 2 "SOLID"
$EndPhysicalNames
$Entities
0 0 2 1
5 0 0 0 0 1 1 1 1 0
6 0 0 0 1 1 0 1 3 0
1 0 0 0 1 1 1 1 2 0
$EndEntities
$Nodes
1 4 1 4
3 1 0 4
1
2
3
4
0 0 0
1 0 0
0 1 0
0 0 1
$EndNodes
$Elements
3 3 1 4
2 5 2 1
1 1 3 4
2 6 2 1
2 1 2 3
3 1 4 1
3 1 2 3 4
$EndElements
`;

const base: FemCase = {
  format: "cadp-sim-case", version: 1, physics: "fem", solver: "code_aster", title: "Teste — tetraedro", analysis: "static", modes: 4,
  material: { ...SIM_MATERIALS[0] }, groups: { L1_FIXED: [5], L2_FORCE: [6] }, faces: [],
  loads: [{ kind: "fixed", group: "L1_FIXED" }, { kind: "force", group: "L2_FORCE", f: [0, 0, -10] }],
  mesh: { size: 1, minSize: 0.1, curvature: 0, order: 1, local: [] }, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, hypotheses: ["Hipótese de teste"],
};

test("code_aster: malha ASTER com nós, TETRA4, TRIA3 e grupos com os nomes do caso", () => {
  const { mail, nodeOrder, areas } = asterMesh(base, parseMsh(MSH));
  assert.deepEqual(nodeOrder, [1, 2, 3, 4]);
  assert.match(mail, /^TITRE\n Teste _ tetraedro\nFINSF/);
  assert.match(mail, /COOR_3D\nN1 0\. 0\. 0\.\nN2 1\. 0\. 0\./);
  assert.match(mail, /TETRA4\nM1 N1 N2 N3 N4\nFINSF/);
  assert.match(mail, /TRIA3\nF1 N1 N3 N4\nF2 N1 N2 N3\nFINSF/);
  assert.match(mail, /GROUP_MA\nL2_FORCE\nF2\nFINSF/);
  assert.match(mail, /GROUP_NO\nL1_FIXED\nN1 N3 N4\nFINSF/);
  assert.ok(mail.trimEnd().endsWith("FIN"));
  assert.equal(areas.L2_FORCE, 0.5);
});

test("code_aster: comandos da estática linear, não linear e modal", () => {
  const m = parseMsh(MSH);
  const lin = asterCase(base, m).files["job.comm"];
  assert.match(lin, /LIRE_MAILLAGE\(FORMAT='ASTER', UNITE=20\)/);
  assert.match(lin, /DDL_IMPO=\(_F\(GROUP_NO='L1_FIXED', DX=0\., DY=0\., DZ=0\.\),\)/);
  // força total 10 N em 0,5 mm² → 20 N/mm²
  assert.match(lin, /FORCE_FACE=\(_F\(GROUP_MA='L2_FORCE', FX=0\., FY=0\., FZ=-20\.\),\)/);
  assert.match(lin, /MECA_STATIQUE/);
  assert.match(lin, /RESULTANTE=\('DX', 'DY', 'DZ'\)/);
  assert.ok(!/[^\x00-\x7f]/.test(lin), "comandos em ASCII");
  const nl = asterCase({ ...base, nonlinear: { geometry: true, plasticity: true, increments: 8 } }, m).files["job.comm"];
  assert.match(nl, /ECRO_LINE=_F\(D_SIGM_EPSI=2100\., SY=235\.\)/);
  assert.match(nl, /RELATION='VMIS_ISOT_LINE', DEFORMATION='GDEF_LOG'/);
  assert.match(nl, /NOMBRE=8/);
  assert.match(nl, /_F\(CHARGE=CH, FONC_MULT=RAMPE\)/);
  assert.match(nl, /VARI_INTERNE=\('VARI_NOEU',\)/);
  assert.match(asterCase({ ...base, nonlinear: { geometry: true, plasticity: false, increments: 4 } }, m).files["job.comm"], /RELATION='ELAS', DEFORMATION='GREEN_LAGRANGE'/);
  const modal = asterCase({ ...base, analysis: "modal" }, m);
  assert.match(modal.files["job.comm"], /CALC_MODES\(MATR_RIGI=K, MATR_MASS=M, OPTION='PLUS_PETITE', CALC_FREQ=_F\(NMAX_FREQ=4\)\)/);
  assert.ok(!/CH = AFFE_CHAR_MECA/.test(modal.files["job.comm"]));
  assert.match(modal.files["job.export"], /F mail mesh\.mail D 20/);
  assert.throws(() => asterCase({ ...base, analysis: "thermal" }, m), /não suportada/);
  const pr = asterCase({ ...base, loads: [{ kind: "fixed", group: "L1_FIXED" }, { kind: "pressure", group: "L2_FORCE", p: 2 }] }, m).files["job.comm"];
  assert.match(pr, /MODI_MAILLAGE\(reuse=MA, MAILLAGE=MA, ORIE_PEAU=_F\(GROUP_MA_PEAU=\('L2_FORCE',\)\)\)/);
  assert.match(pr, /PRES_REP=\(_F\(GROUP_MA='L2_FORCE', PRES=2\.\),\)/);
});

test("code_aster: plasticidade multilinear → curva de tração σ–ε total (VMIS_ISOT_TRAC)", () => {
  const m = parseMsh(MSH);
  const curve = { ...SIM_MATERIALS[0], tangent: undefined, yield: 235, plasticCurve: [[235, 0], [270, 0.01], [320, 0.05]] as [number, number][] };
  const nl = { geometry: false, plasticity: true, increments: 8 };
  const one = asterCase({ ...base, material: curve, nonlinear: nl }, m).files["job.comm"];
  const vale = (s: string) => s.match(/^TR = DEFI_FONCTION\(NOM_PARA='EPSI', VALE=\(([^)]*)\), PROL_DROITE='(\w+)'\)$/m);
  const tr = vale(one);
  assert.ok(tr, one);
  // ε = εp + σ/E nos pontos dados; plástico perfeito depois do último
  const v = tr[1].split(", ").map(Number);
  [[235, 0], [270, 0.01], [320, 0.05]].forEach(([s, ep], i) => {
    assert.ok(Math.abs(v[2 * i] - (ep + s / 210000)) < 1e-8, `ε do ponto ${i + 1}`);
    assert.equal(v[2 * i + 1], s);
  });
  assert.equal(tr[2], "CONSTANT");
  assert.match(one, /MAT = DEFI_MATERIAU\(ELAS=_F\([^)]*\), TRACTION=_F\(SIGM=TR\)\)/);
  assert.match(one, /RELATION='VMIS_ISOT_TRAC'/);
  assert.ok(!/ECRO_LINE/.test(one));
  assert.ok(!/[^\x00-\x7f]/.test(one), "comandos em ASCII");
  // montagem mista: o corpo bilinear passa a 2 pontos com a mesma inclinação Et, prolongada linearmente
  const box = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  const mixed = asterCase({ ...base, nonlinear: nl, bodies: [
    { group: "SOLID", path: "a", name: "A", material: curve, bbox: box },
    { group: "SOLID", path: "b", name: "B", material: { ...SIM_MATERIALS[0] }, bbox: box },
  ] }, m).files["job.comm"];
  const t2 = mixed.match(/^TR2 = DEFI_FONCTION\(NOM_PARA='EPSI', VALE=\(([^)]*)\), PROL_DROITE='(\w+)'\)$/m);
  assert.ok(t2 && /^TR1 = DEFI_FONCTION.*'CONSTANT'\)$/m.test(mixed), mixed);
  const [e1, s1, e2, s2] = t2[1].split(", ").map(Number);
  assert.equal(t2[2], "LINEAIRE");
  assert.equal(s1, 235);
  assert.ok(Math.abs(e1 - 235 / 210000) < 1e-8);
  // inclinação da curva total = Et = 2100 MPa
  assert.ok(Math.abs((s2 - s1) / (e2 - e1) - 2100) < 1e-3);
  assert.match(mixed, /MAT2 = DEFI_MATERIAU\(ELAS=_F\([^)]*\), TRACTION=_F\(SIGM=TR2\)\)/);
  // sem curvas, continua o encruamento linear
  assert.match(asterCase({ ...base, nonlinear: nl }, m).files["job.comm"], /RELATION='VMIS_ISOT_LINE'/);
});

test("code_aster: tabelas IMPR_TABLE → resultado com deslocamentos, von Mises e reações", () => {
  const u = "#\n#ASTER 17.0 CONCEPT TU CALCULE LE ...\n INTITULE NOM_CHAM NUME_ORDRE INST NOEUD DX DY DZ\n U DEPL 1 1.0 N1 0.0 0.0 0.0\n U DEPL 1 1.0 N2 0.0 0.0 -0.5\n U DEPL 1 1.0 N3 0.0 0.0 0.0\n U DEPL 1 1.0 N4 0.0 0.0 0.0\n";
  assert.equal(parseAsterTable(u).length, 4);
  assert.equal(asterNode("N7", [1, 2]), 7);
  assert.equal(asterNode("2", [5, 9]), 9);
  const vm = " INTITULE NUME_ORDRE NOEUD VMIS\n VM 1 N1 10.\n VM 1 N2 20.\n VM 1 N3 5.\n VM 1 N4 1.\n";
  const reac = " INTITULE NUME_ORDRE INST DX DY DZ\n R 1 1.0 0.0 0.0 10.0\n";
  const r = asterResult(base, parseMsh(MSH), { u, vm, reac }, [1, 2, 3, 4]);
  assert.equal(r.metrics.find((x) => x.key === "umax")!.value, 0.5);
  assert.equal(r.metrics.find((x) => x.key === "vmmax")!.value, 20);
  assert.deepEqual(r.reactions[0], [0, 0, 10]);
  assert.ok(r.hypotheses.some((h) => /code_aster 18\.1/.test(h)));
  const f = asterResult({ ...base, analysis: "modal" }, parseMsh(MSH), { u: u.replace(/ 1 1\.0 /g, " 1 0.0 "), freq: " NUME_ORDRE FREQ\n 1 123.4\n 2 456.7\n" }, [1, 2, 3, 4]);
  assert.deepEqual(f.frequencies, [123.4, 456.7]);
});

// o mesmo tetraedro com uma curva (aresta N1–N2, SEG2) no grupo L3_EDGE
const MSH_EDGE = MSH
  .replace('$PhysicalNames\n3\n', '$PhysicalNames\n4\n1 4 "L3_EDGE"\n')
  .replace("$Entities\n0 0 2 1\n", "$Entities\n0 1 2 1\n7 0 0 0 1 0 0 1 4 0\n")
  .replace("$Elements\n3 3 1 4\n", "$Elements\n4 4 1 4\n1 7 1 1\n4 1 2\n");

test("code_aster: condições numa aresta → GROUP_NO, FORCE_NODALE consistente e DDL_IMPO", () => {
  const m = parseMsh(MSH_EDGE);
  const c: FemCase = { ...base, edgeGroups: { L3_EDGE: [7] }, edgeLength: { L3_EDGE: 1 }, loads: [{ kind: "fixed", group: "L1_FIXED" }, { kind: "force", group: "L3_EDGE", f: [0, 0, -10] }] };
  const { mail, edgeNodes, warnings } = asterMesh(c, m);
  assert.deepEqual(warnings, []);
  assert.match(mail, /GROUP_NO\nL3_EDGE\nN1 N2\nFINSF/);
  assert.match(mail, /GROUP_NO\nE1_1\nN1\nFINSF/);
  assert.match(mail, /GROUP_NO\nE1_2\nN2\nFINSF/);
  // SEG2: metade da força em cada nó; as frações somam 1
  assert.deepEqual(edgeNodes.L3_EDGE.map((x) => x.w), [0.5, 0.5]);
  const comm = asterCase(c, m).files["job.comm"];
  assert.match(comm, /FORCE_NODALE=\(_F\(GROUP_NO='E1_1', FX=0\., FY=0\., FZ=-5\.\), _F\(GROUP_NO='E1_2', FX=0\., FY=0\., FZ=-5\.\),\)/);
  assert.ok(!/[^\x00-\x7f]/.test(comm));
  // apoio na aresta: graus impostos no grupo de nós
  const fx = asterCase({ ...c, loads: [{ kind: "fixed", group: "L3_EDGE" }, { kind: "force", group: "L2_FORCE", f: [0, 0, -10] }] }, m);
  assert.match(fx.files["job.comm"], /_F\(GROUP_NO='L3_EDGE', DX=0\., DY=0\., DZ=0\.\)/);
  assert.ok(!/FORCE_NODALE/.test(fx.files["job.comm"]));
  // grupo sem linhas na malha: aviso e a força não é aplicada
  const none = asterCase({ ...c, edgeGroups: { L4_NONE: [99] }, loads: [{ kind: "fixed", group: "L1_FIXED" }, { kind: "force", group: "L4_NONE", f: [0, 0, -10] }] }, m);
  assert.ok(none.warnings.includes("O grupo L4_NONE não tem linhas na malha"), none.warnings.join("; "));
  assert.ok(none.warnings.includes("Força no grupo L4_NONE sem comprimento"), none.warnings.join("; "));
  assert.ok(!/FORCE_NODALE/.test(none.files["job.comm"]));
});

test("Molas à terra: pesos nodais normalizados, só os positivos", () => {
  const w = springWeights([{ n: [3, 1, 2], nodal: [1, 1, 2] }, { n: [2, 4], nodal: [2, -1] }]);
  assert.deepEqual([...w.keys()], [1, 2, 3]);
  assert.deepEqual([...w.values()], [1 / 6, 4 / 6, 1 / 6]);
  assert.equal(springWeights([{ n: [1, 2], nodal: [-1, 0] }]).size, 0);
  assert.equal(springWeights([]).size, 0);
});

const springCase: FemCase = { ...base, loads: [{ kind: "fixed", group: "L1_FIXED" }, { kind: "spring", group: "L2_FORCE", k: [30, 0, 0] }] };

test("CalculiX: molas à terra → SPRING1 por nó e direção com k·w; as nulas não entram", () => {
  const { inp, warnings } = calculixDeck({ ...springCase, solver: "calculix" }, parseMsh(MSH));
  // TRIA3 N1 N2 N3: um terço da rigidez em cada nó, só em X
  assert.match(inp, /\*ELEMENT, TYPE=SPRING1, ELSET=SP2X1\n\d+, 1\n\d+, 2\n\d+, 3\n\*SPRING, ELSET=SP2X1\n1\n10\n/);
  assert.ok(!/ELSET=SP2Y|ELSET=SP2Z/.test(inp));
  assert.ok(!warnings.some((x) => /Mola/.test(x)), warnings.join("; "));
  const th = calculixDeck({ ...springCase, solver: "calculix", analysis: "thermal", loads: [{ kind: "spring", group: "L2_FORCE", k: [30, 0, 0] }] }, parseMsh(MSH));
  assert.ok(th.warnings.includes("Mola L2_FORCE: ignorada na análise térmica"), th.warnings.join("; "));
  assert.ok(!/SPRING1/.test(th.inp));
});

test("code_aster: molas à terra → POI1 em DIS_T com K_T_D_N e massa nula", () => {
  const m = parseMsh(MSH);
  const { mail, springs } = asterMesh(springCase, m);
  assert.match(mail, /POI1\n/);
  assert.match(mail, /GROUP_MA\nK2_1\n/);
  assert.deepEqual(springs.map((s) => s.k), [[10, 0, 0]]);
  const comm = asterCase(springCase, m).files["job.comm"];
  assert.match(comm, /MODELISATION='DIS_T'/);
  assert.match(comm, /CARA='K_T_D_N', VALE=\(10\., 0\., 0\.\)/);
  assert.match(comm, /CARA='M_T_D_N', VALE=0\./);
  assert.match(comm, /CARA_ELEM=CARA/);
  assert.ok(!/[^\x00-\x7f]/.test(comm));
  // só molas, sem apoios: aceite
  assert.doesNotThrow(() => asterCase({ ...springCase, loads: [{ kind: "spring", group: "L2_FORCE", k: [30, 30, 30] }, { kind: "force", group: "L2_FORCE", f: [0, 0, -10] }] }, m));
  assert.throws(() => asterCase({ ...springCase, nonlinear: { geometry: true, plasticity: false, increments: 4 } }, m), /molas só estão/);
});

const massCase: FemCase = { ...base, loads: [{ kind: "fixed", group: "L1_FIXED" }, { kind: "mass", group: "L2_FORCE", m: 0.03 }] };
const gravity = { kind: "gravity" as const, g: [0, 0, -9810] as [number, number, number] };

test("CalculiX: massa pontual → MASS por nó com m·w (fora do EALL) e peso em forças nodais", () => {
  const { inp } = calculixDeck({ ...massCase, solver: "calculix" }, parseMsh(MSH));
  assert.match(inp, /\*ELEMENT, TYPE=MASS, ELSET=MS2_1\n\d+, 1\n\d+, 2\n\d+, 3\n\*MASS, ELSET=MS2_1\n0\.01\n/);
  assert.ok(!/CLOAD/.test(inp));
  // com gravidade: GRAV no EALL e m·wᵢ·g nos nós da massa
  const g = calculixDeck({ ...massCase, solver: "calculix", loads: [...massCase.loads, gravity] }, parseMsh(MSH)).inp;
  assert.match(g, /EALL, GRAV, 9810, 0, 0, -1\n/);
  assert.match(g, /\*CLOAD\n1, 3, -98\.1\n2, 3, -98\.1\n3, 3, -98\.1\n/);
  const th = calculixDeck({ ...massCase, solver: "calculix", analysis: "thermal", loads: [{ kind: "mass", group: "L2_FORCE", m: 0.03 }] }, parseMsh(MSH));
  assert.ok(th.warnings.includes("Massa L2_FORCE: ignorada na análise térmica"), JSON.stringify(th.warnings));
  assert.ok(!/TYPE=MASS/.test(th.inp));
});

test("code_aster: massa pontual → POI1 em DIS_T com M_T_D_N e peso em FORCE_NODALE", () => {
  const m = parseMsh(MSH);
  const { mail, masses } = asterMesh(massCase, m);
  assert.match(mail, /GROUP_MA\nM2_1\n/);
  assert.match(mail, /GROUP_NO\nMN2_1\n/);
  assert.deepEqual(masses.map((x) => [x.group, x.nodes, +x.m.toFixed(12)]), [["M2_1", "MN2_1", 0.01]]);
  const comm = asterCase({ ...massCase, loads: [...massCase.loads, gravity] }, m).files["job.comm"];
  assert.match(comm, /_F\(GROUP_MA='M2_1', CARA='K_T_D_N', VALE=\(0\., 0\., 0\.\)\)/);
  assert.match(comm, /_F\(GROUP_MA='M2_1', CARA='M_T_D_N', VALE=0\.01\)/);
  assert.match(comm, /PESANTEUR=_F\(GRAVITE=9810\., DIRECTION=\(0\., 0\., -1\.\), GROUP_MA='SOLID'\)/);
  assert.match(comm, /_F\(GROUP_NO='MN2_1', FX=0\., FY=0\., FZ=-98\.1\)/);
  assert.ok(!/[^\x00-\x7f]/.test(comm));
  // sem massas a PESANTEUR fica em todo o modelo
  assert.ok(!/GROUP_MA='SOLID'\)/.test(asterCase({ ...base, loads: [{ kind: "fixed", group: "L1_FIXED" }, gravity] }, m).files["job.comm"]));
  assert.throws(() => asterCase({ ...massCase, nonlinear: { geometry: true, plasticity: false, increments: 4 } }, m), /massas só estão/);
});
