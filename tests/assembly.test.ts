// Solver de mates (puro) e montagens no núcleo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { I3, applyPose, eulerXYZ, mv, solveMates, type SolverComponent, type SolverMate } from "../src/assembly/solver.ts";
import type { Vec3 } from "../src/doc/types.ts";

const near = (a: number, b: number, tol = 1e-5) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const nearV = (a: Vec3, b: Vec3, tol = 1e-5) => a.forEach((x, i) => near(x, b[i], tol));

// cubo de 10 mm: faces como planos (ponto, normal para fora)
const face = (axis: 0 | 1 | 2, side: 0 | 1) => {
  const p: Vec3 = [5, 5, 5]; p[axis] = side * 10;
  const n: Vec3 = [0, 0, 0]; n[axis] = side ? 1 : -1;
  return { kind: "plane" as const, p, n };
};

test("solver: cubo em cima de cubo, três faces → totalmente definido", () => {
  const comps: SolverComponent[] = [
    { id: "A", fixed: true, pose: { R: I3, t: [0, 0, 0] } },
    { id: "B", fixed: false, pose: { R: eulerXYZ([8, -5, 12]), t: [3, -4, 17] } },
  ];
  const mates: SolverMate[] = [
    { id: "m1", kind: "coincident", a: "A", ga: face(2, 1), b: "B", gb: face(2, 0) }, // topo de A com base de B (frente a frente)
    { id: "m2", kind: "coincident", a: "A", ga: face(0, 0), b: "B", gb: face(0, 0), align: "aligned" }, // faces x=0 de nível
    { id: "m3", kind: "coincident", a: "A", ga: face(1, 0), b: "B", gb: face(1, 0), align: "aligned" },
  ];
  const r = solveMates(comps, mates, 10);
  assert.ok(r.ok, JSON.stringify(r.failed));
  assert.equal(r.dof, 0);
  const B = r.poses.get("B")!;
  nearV(B.t, [0, 0, 10]);
  nearV(mv(B.R, [1, 0, 0]), [1, 0, 0]);
  nearV(mv(B.R, [0, 0, 1]), [0, 0, 1]);
});

test("solver: rotação de 180° necessária (arranques múltiplos)", () => {
  const comps: SolverComponent[] = [
    { id: "A", fixed: true, pose: { R: I3, t: [0, 0, 0] } },
    { id: "B", fixed: false, pose: { R: eulerXYZ([175, 3, 0]), t: [0, 0, 30] } },
  ];
  const r = solveMates(comps, [
    { id: "m1", kind: "coincident", a: "A", ga: face(2, 1), b: "B", gb: face(2, 0) },
    { id: "m2", kind: "coincident", a: "A", ga: face(0, 0), b: "B", gb: face(0, 0), align: "aligned" },
    { id: "m3", kind: "coincident", a: "A", ga: face(1, 0), b: "B", gb: face(1, 0), align: "aligned" },
  ], 10);
  assert.ok(r.ok, JSON.stringify(r.failed));
  nearV(applyPose(r.poses.get("B")!, [10, 10, 10]), [10, 10, 20]);
});

test("solver: pino num furo — concêntrico + coincidente deixa 1 grau de liberdade (rotação)", () => {
  const comps: SolverComponent[] = [
    { id: "base", fixed: true, pose: { R: I3, t: [0, 0, 0] } },
    { id: "pino", fixed: false, pose: { R: eulerXYZ([10, 20, 0]), t: [40, 10, 50] } },
  ];
  const r = solveMates(comps, [
    { id: "c", kind: "concentric", a: "base", ga: { kind: "axis", p: [20, 20, 0], d: [0, 0, 1], r: 5 }, b: "pino", gb: { kind: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 5 } },
    { id: "f", kind: "coincident", a: "base", ga: { kind: "plane", p: [20, 20, 10], n: [0, 0, 1] }, b: "pino", gb: { kind: "plane", p: [0, 0, 2], n: [0, 0, -1] } },
  ], 50);
  assert.ok(r.ok, JSON.stringify(r.failed));
  assert.equal(r.dof, 1);
  const P = r.poses.get("pino")!;
  const axisPt = applyPose(P, [0, 0, 7]);
  near(axisPt[0], 20); near(axisPt[1], 20); near(applyPose(P, [0, 0, 2])[2], 10);
});

test("solver: distância e ângulo; conflito identificado", () => {
  const comps: SolverComponent[] = [
    { id: "A", fixed: true, pose: { R: I3, t: [0, 0, 0] } },
    { id: "B", fixed: false, pose: { R: I3, t: [0, 0, 25] } },
  ];
  const d = solveMates(comps, [{ id: "d", kind: "distance", a: "A", ga: face(2, 1), b: "B", gb: face(2, 0), value: 5 }], 10);
  assert.ok(d.ok);
  near(d.poses.get("B")!.t[2], 15);
  assert.equal(d.dof, 3);
  const ang = solveMates(comps, [
    { id: "p", kind: "coincident", a: "A", ga: face(2, 1), b: "B", gb: face(2, 0) },
    { id: "g", kind: "angle", a: "A", ga: face(0, 1), b: "B", gb: face(0, 1), value: Math.PI / 6 },
  ], 10);
  assert.ok(ang.ok, JSON.stringify(ang.failed));
  const xB = mv(ang.poses.get("B")!.R, [1, 0, 0]);
  near(Math.acos(xB[0]), Math.PI / 6, 1e-4);
  const bad = solveMates(comps, [
    { id: "d1", kind: "distance", a: "A", ga: face(2, 1), b: "B", gb: face(2, 0), value: 5 },
    { id: "d2", kind: "distance", a: "A", ga: face(2, 1), b: "B", gb: face(2, 0), value: 9 },
  ], 10);
  assert.equal(bad.ok, false);
  assert.ok(bad.failed.length >= 1);
});

test("solver: tangente plano–cilindro e fixar (lock)", () => {
  const comps: SolverComponent[] = [
    { id: "A", fixed: true, pose: { R: I3, t: [0, 0, 0] } },
    { id: "rolo", fixed: false, pose: { R: eulerXYZ([0, 90, 0]), t: [0, 0, 40] } },
    { id: "C", fixed: false, pose: { R: I3, t: [100, 0, 0] } },
  ];
  const r = solveMates(comps, [
    { id: "t", kind: "tangent", a: "A", ga: face(2, 1), b: "rolo", gb: { kind: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 8 } },
    { id: "l", kind: "lock", a: "rolo", ga: { kind: "point", p: [0, 0, 0] }, b: "C", gb: { kind: "point", p: [0, 0, 0] } },
  ], 50);
  assert.ok(r.ok, JSON.stringify(r.failed));
  near(applyPose(r.poses.get("rolo")!, [0, 0, 0])[2], 18, 1e-4); // eixo a r = 8 acima do topo (z = 10)
});

// --- montagens no núcleo ------------------------------------------------------------
import { before } from "node:test";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature } from "../src/doc/io.ts";
import { type CadProject, newProject, newPart, newAssembly } from "../src/doc/project.ts";

before(initKernel);

/** Bloco w×d×h com o canto na origem. */
function blockPart(project: CadProject, w: number, d: number, h: number, name: string) {
  const s = new SketchBuilder();
  s.rect(0, 0, w, d, w, d);
  let p = { ...newPart(project, name) };
  p = { ...p, ...addFeature(p, s.build()).doc };
  p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: h } }).doc };
  return p;
}

function twoBlocks() {
  let pr = newProject("Teste");
  pr = { ...pr, parts: [] };
  const base = blockPart(pr, 100, 60, 20, "Base"); pr.parts.push(base);
  const cube = blockPart(pr, 20, 20, 20, "Cubo"); pr.parts.push(cube);
  const asm = newAssembly(pr);
  asm.components = [
    { id: "c1", name: "Base<1>", ref: { kind: "part", id: base.id }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "Cubo<1>", ref: { kind: "part", id: cube.id }, placement: { t: [30, 5, 40], r: [0, 0, 10] } },
  ];
  // topo da base com a base do cubo; faces laterais x=0 e y=0 de nível
  asm.mates = [
    { id: "m1", name: "Coincidente1", kind: "coincident", a: { component: "c1", ref: { kind: "face", name: "f2:end:l5" } }, b: { component: "c2", ref: { kind: "face", name: "f2:start:l5" } } },
    { id: "m2", name: "Coincidente2", kind: "coincident", a: { component: "c1", ref: { kind: "face", name: "f2:side:l8" } }, b: { component: "c2", ref: { kind: "face", name: "f2:side:l8" } }, align: "aligned" },
    { id: "m3", name: "Distância1", kind: "distance", a: { component: "c1", ref: { kind: "face", name: "f2:side:l5" } }, b: { component: "c2", ref: { kind: "face", name: "f2:side:l5" } }, align: "aligned", value: "-10" },
  ];
  pr.assemblies.push(asm);
  return pr;
}

test("montagem: mates entre faces de peças reais, massa e interferência", async () => {
  const pr = twoBlocks();
  const svc = new KernelService();
  const r = await svc.assembly(pr, pr.assemblies[0].id);
  assert.ok(r.ok, JSON.stringify(r.mates) + r.messages.join());
  assert.equal(r.dof, 0);
  const cube = r.instances.find((i) => i.top === "c2")!;
  // a origem do cubo vai para x=0, y=10 (face y=0 desviada 10 para dentro), z=20 (topo da base)
  nearV([cube.matrix[12], cube.matrix[13], cube.matrix[14]], [0, 10, 20], 1e-4);
  near(r.mass!.volume, 100 * 60 * 20 + 20 ** 3, 1e-3);
  assert.equal(Object.keys(r.parts).length, 2);
  assert.equal((await svc.interference()).pairs.length, 0);

  // sem o mate de topo, com o cubo a meio da base: interferência de 20×20×10
  const pr2 = structuredClone(pr);
  pr2.assemblies[0].mates = [];
  pr2.assemblies[0].components[1].placement = { t: [10, 10, 10], r: [0, 0, 0] };
  await svc.assembly(pr2, pr2.assemblies[0].id);
  const inter = await svc.interference();
  assert.equal(inter.pairs.length, 1);
  near(inter.pairs[0].volume, 20 * 20 * 10, 1e-3);
});

test("montagem: subconjunto rígido e mate a uma face de dentro do subconjunto", async () => {
  const pr = twoBlocks();
  const sub = pr.assemblies[0];
  const top = newAssembly(pr, "Conjunto");
  top.components = [
    { id: "c1", name: "Base<2>", ref: { kind: "part", id: pr.parts[0].id }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "Sub<1>", ref: { kind: "assembly", id: sub.id }, placement: { t: [0, 0, 100], r: [0, 0, 0] } },
  ];
  // o topo do cubo (dentro do subconjunto) com a base da segunda base: subconjunto virado ao contrário em cima
  top.mates = [
    { id: "m1", name: "Coincidente1", kind: "coincident", a: { component: "c1", ref: { kind: "face", name: "f2:end:l5" } }, b: { component: "c2", ref: { kind: "face", name: "c2/f2:end:l5" } } },
  ];
  pr.assemblies.push(top);
  const r = await new KernelService().assembly(pr, top.id);
  assert.ok(r.ok, JSON.stringify(r.mates));
  assert.equal(r.instances.length, 3);
  assert.ok(r.instances.some((i) => i.path === "c2/c2"));
  assert.equal(r.dof, 3, "plano sobre plano: 2 translações + 1 rotação livres");
});
