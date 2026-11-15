// Script Gmsh (opções da cascata de malha) e tradução dos erros do log.gmsh — sem núcleo nem Gmsh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { femGeo, minSizeFloor } from "../src/sim/gmsh.ts";
import { gmshError } from "../tools/cad-runner.ts";
import { MeshErrors, hoFailed, requireMeshDim } from "../tools/cad-runner-fem.ts";
import { meshQuality } from "../src/sim/quality.ts";
import type { Msh } from "../src/sim/msh.ts";
import type { FemCase } from "../src/sim/case.ts";

/** Caso mínimo: cubo de 100 mm (diagonal ≈ 173 mm), tetraedros de ordem 2. */
function cube(mesh: Partial<FemCase["mesh"]> = {}): FemCase {
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: "calculix", title: "cubo", analysis: "static", modes: 0,
    material: {} as FemCase["material"], groups: { FIX: [1], LOAD: [2] }, faces: [], loads: [],
    mesh: { size: 10, minSize: 0, curvature: 12, order: 2, local: [], ...mesh },
    bbox: { min: [0, 0, 0], max: [100, 100, 100] }, hypotheses: [],
  };
}

const line = (geo: string, key: string) => geo.split("\n").find((l) => l.startsWith(key));

test("femGeo: por omissão Delaunay, otimização de ordem 2 ligada e sem reparação OCC", () => {
  const g = femGeo(cube());
  assert.equal(line(g, "Mesh.Algorithm3D"), "Mesh.Algorithm3D = 1;");
  assert.equal(line(g, "Mesh.HighOrderOptimize"), "Mesh.HighOrderOptimize = 1;");
  assert.ok(!g.includes("OCCFix"));
});

test("femGeo: HXT, sem otimização de ordem 2 e reparação antes do Merge", () => {
  const g = femGeo(cube(), { algorithm3D: 10, optimizeHO: false, heal: true });
  assert.equal(line(g, "Mesh.Algorithm3D"), "Mesh.Algorithm3D = 10;");
  assert.equal(line(g, "Mesh.HighOrderOptimize"), "Mesh.HighOrderOptimize = 0;");
  const heal = g.indexOf("Geometry.OCCFixSmallEdges = 1;"), merge = g.indexOf(`Merge "model.brep";`);
  assert.ok(heal > 0 && heal < merge, "as flags OCC têm de vir antes de importar o BREP");
  assert.ok(g.includes("Geometry.OCCSewFaces = 1;"));
});

test("femGeo: hexaedros nunca otimizam a ordem 2 (pode não terminar)", () => {
  assert.equal(line(femGeo(cube({ element: "hex" })), "Mesh.HighOrderOptimize"), "Mesh.HighOrderOptimize = 0;");
});

test("minSizeFloor: piso de 1e-4 da diagonal, limitado pelo tamanho global e pelos locais", () => {
  const d = Math.hypot(100, 100, 100);
  assert.ok(Math.abs(minSizeFloor(cube()) - 1e-4 * d) < 1e-12);
  assert.equal(minSizeFloor(cube({ minSize: 2 })), 2);
  // pedido acima do global → fica no global; local mais fino → fica no local
  assert.equal(minSizeFloor(cube({ minSize: 50 })), 10);
  assert.equal(minSizeFloor(cube({ minSize: 50, local: [{ group: "LOAD", size: 3 }] })), 3);
  assert.equal(line(femGeo(cube()), "Mesh.MeshSizeMin"), `Mesh.MeshSizeMin = ${1e-4 * d};`);
});

test("gmshError: traduz os erros habituais com as faces envolvidas", () => {
  assert.equal(gmshError("Info : Meshing 1D...\nInfo : Done"), null);
  const pl = gmshError("Info : x\nError   : Invalid boundary mesh (overlapping facets) on surface 12 surface 7\nError   : No elements in volume 1");
  assert.match(pl!, /intersecta-se/);
  assert.match(pl!, /faces 7, 12/);
  assert.match(gmshError("Error : Could not recover boundary edge on surface 3")!, /não conseguiu respeitar.*faces 3/);
  assert.match(gmshError("Error : Surface loop not closed")!, /volume fechado/);
  assert.match(gmshError("Error : Zero length curve 5")!, /degeneradas/);
  assert.equal(gmshError("Error : Something odd\nError   : Last one"), "O Gmsh falhou: Last one");
});

test("gmshError: faces periódicas que não malham não são confundidas com volume aberto", () => {
  const m = gmshError("Error   : The 1D mesh seems not to be forming a closed loop\nError   : Impossible to mesh periodic surface 1\nError   : Impossible to mesh periodic surface 3")!;
  assert.match(m, /faces curvas fechadas/);
  assert.match(m, /faces 1, 3/);
  assert.doesNotMatch(m, /volume fechado/);
});

test("hoFailed: reconhece a falha da otimização de ordem 2 (salta para as tentativas sem ela)", () => {
  assert.ok(hoFailed("Error   : Failed to reach critical value in pass 0 for measure(s): ScaledJac\nError   : Optimization failed (some measures below critical value)"));
  assert.ok(!hoFailed("Error   : Impossible to mesh periodic surface 1"));
});

test("gmshError: ignora os separadores e cabeçalhos do resumo final do Gmsh", () => {
  const log = "Error : Unable to recover the edge 14 on curve 3 (on surface 2)\nError : ------------------------------\nError : Mesh generation error summary\nError :     1 warning\nError :     2 errors\nError : Check the full log for details\nError : ------------------------------";
  assert.equal(gmshError("Error : ------------------------------\nError : Mesh generation error summary\nError : Check the full log for details"), null);
  assert.match(gmshError(log)!, /edge 14|faces 2|não conseguiu/);
  assert.doesNotMatch(gmshError(log)!, /-----|summary|errors|full log/);
});

/** Malha com n tetraedros independentes (nós próprios) e, opcionalmente, um triângulo de superfície. */
function tets(n: number, withTri = true): Msh {
  const nodes = new Map<number, [number, number, number]>();
  const conn: number[] = [], tags: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = 4 * i, x = i % 100, y = Math.floor(i / 100) % 100, z = Math.floor(i / 10000);
    nodes.set(k + 1, [x, y, z]); nodes.set(k + 2, [x + 1, y, z]); nodes.set(k + 3, [x, y + 1, z]); nodes.set(k + 4, [x, y, z + 1]);
    conn.push(k + 1, k + 2, k + 3, k + 4); tags.push(i + 1);
  }
  const blocks = [{ dim: 3, entity: 1, type: 4, conn, tags }];
  if (withTri) blocks.push({ dim: 2, entity: 1, type: 2, conn: [1, 2, 3], tags: [n + 1] });
  return { nodes, blocks, physicals: new Map([["SOLID", { dim: 3, tag: 1 }]]), entityPhysicals: new Map([["3:1", [1]]]), entityBox: new Map() };
}

test("requireMeshDim: rejeita uma malha só com superfície (o Gmsh «terminou» sem tetraedros)", () => {
  const m = tets(2);
  assert.doesNotThrow(() => requireMeshDim(m, 3));
  m.blocks = m.blocks.filter((b) => b.dim === 2);
  assert.throws(() => requireMeshDim(m, 3), /sem gerar elementos de volume/);
  assert.doesNotThrow(() => requireMeshDim(m, 2));
  assert.throws(() => requireMeshDim({ ...m, blocks: [] }, 2), /sem gerar elementos de superfície/);
});

test("meshQuality: 300 mil elementos não rebentam a pilha (sem Math.min(...v))", () => {
  const q = meshQuality(tets(300000, false));
  assert.equal(q.types.tet4, 300000);
  const sj = q.metrics.find((x) => x.key === "sj")!;
  assert.equal(sj.count, 300000);
  assert.ok(sj.min > 0 && sj.max <= 1 + 1e-9);
});

test("MeshErrors: faces curvas fechadas por malhar ganham ao «volume não fechado» de uma tentativa anterior", () => {
  const e = new MeshErrors();
  e.add("x", "A geometria não forma um volume fechado.");
  e.add("y", "O Gmsh falhou: algo");
  e.add("z", "Não foi possível malhar faces curvas fechadas (cilindros, cones ou toros) (faces 1, 3): …");
  assert.match(e.best()!, /faces curvas fechadas/);
  const f = new MeshErrors();
  f.add("A malha terminou sem gerar elementos de volume", null);
  f.add("y", "O Gmsh falhou: algo");
  assert.match(f.best()!, /sem gerar elementos/);
});

test("gmshError: Frontal sem Netgen não é dado como volume não fechado", () => {
  const d = gmshError("Error   : Frontal algorithm requires Netgen\nError   : No elements in volume 1\n");
  assert.match(d ?? "", /Netgen/);
  const e = new MeshErrors();
  e.add("x", d);
  e.add("y", "Há arestas ou faces degeneradas/minúsculas.");
  assert.match(e.best() ?? "", /degeneradas/);
});
