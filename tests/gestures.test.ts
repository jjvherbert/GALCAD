// Reconhecedor de gestos: limiar de distância, 8 setores de ±15° e zonas ambíguas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gestureDir } from "../src/app/gestures.ts";

const at = (deg: number, r = 60): [number, number] => [r * Math.cos((deg * Math.PI) / 180), -r * Math.sin((deg * Math.PI) / 180)];

test("gestureDir: as 8 direções no centro do setor", () => {
  const exp = ["right", "upRight", "up", "upLeft", "left", "downLeft", "down", "downRight"];
  exp.forEach((d, i) => assert.equal(gestureDir([0, 0], at(i * 45)), d));
});

test("gestureDir: tolerância de ±15°", () => {
  assert.equal(gestureDir([0, 0], at(90 + 14)), "up");
  assert.equal(gestureDir([0, 0], at(90 - 14)), "up");
  assert.equal(gestureDir([0, 0], at(-14)), "right");
  assert.equal(gestureDir([0, 0], at(180 + 14)), "left");
});

test("gestureDir: entre setores é ambíguo → null", () => {
  assert.equal(gestureDir([0, 0], at(22.5)), null);
  assert.equal(gestureDir([0, 0], at(90 + 20)), null);
  assert.equal(gestureDir([0, 0], at(-30 + 2)), null);
});

test("gestureDir: até 25 px não é gesto", () => {
  assert.equal(gestureDir([10, 10], [10, 10 - 25]), null);
  assert.equal(gestureDir([10, 10], [10, 10 - 26]), "up");
  assert.equal(gestureDir([0, 0], [3, 2]), null);
});
