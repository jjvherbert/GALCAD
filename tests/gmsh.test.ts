// Script Gmsh (opções da cascata de malha) e tradução dos erros do log.gmsh — sem núcleo nem Gmsh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { femGeo, minSizeFloor } from "../src/sim/gmsh.ts";
import { gmshError } from "../tools/cad-runner.ts";
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
