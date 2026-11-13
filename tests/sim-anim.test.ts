// Deformada animada dos resultados: fase sinusoidal e posições base + fase·deformada, só com a opção ligada.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applySimPhase, buildSimLayers, simAnimPhase, stepSimAnim, SIM_ANIM_PERIOD } from "../src/app/viewport-sim.ts";
import type { ResultView } from "../src/sim/result.ts";

test("fase da deformada animada oscila entre −1 e 1", () => {
  assert.equal(simAnimPhase(0), 0);
  assert.ok(Math.abs(simAnimPhase(SIM_ANIM_PERIOD / 4) - 1) < 1e-12);
  assert.ok(Math.abs(simAnimPhase((3 * SIM_ANIM_PERIOD) / 4) + 1) < 1e-12);
});

test("posições animadas = base + fase × deformada ampliada", () => {
  const pos = new Float32Array(3);
  applySimPhase(pos, [1, 2, 3], new Float32Array([0.5, 0, -1]), -1);
  assert.deepEqual([...pos], [0.5, 2, 4]);
});

const view = (): ResultView => ({
  fields: [{ name: "U", unit: "mm" }],
  modes: ["Modo 1"],
  layers: [{ name: "Peça", visible: true, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2], values: [[0, 1, 0]], displacements: [[0, 0, 1, 0, 0, 0, 0, 0, 0]] }],
} as unknown as ResultView);

test("só anima com a opção ligada; o ciclo move a deformada", () => {
  const off = new THREE.Group();
  buildSimLayers(off, view(), { field: 0, disp: 0, scale: 2, hidden: [] }, 1, null);
  assert.equal(off.userData.anim.length, 0);
  const g = new THREE.Group();
  buildSimLayers(g, view(), { field: 0, disp: 0, scale: 2, hidden: [], anim: true }, 1, null);
  assert.equal(g.userData.anim.length, 1);
  stepSimAnim(g, SIM_ANIM_PERIOD / 4);
  const p = ((g.children[0] as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute).array;
  assert.equal(p[2], 2);
  stepSimAnim(g, (3 * SIM_ANIM_PERIOD) / 4);
  assert.equal(p[2], -2);
});
