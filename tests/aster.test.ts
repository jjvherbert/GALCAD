// Adaptador code_aster: malha ASTER, comandos e leitura das tabelas (sem o solver — o code_aster não
// está instalado nesta máquina; a verificação numérica fica por fazer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { asterCase, asterMesh, asterNode, asterResult, parseAsterTable } from "../src/sim/aster.ts";
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
