// Layout automático do «Criar desenho 2D»: escala normalizada, folha mínima e posições das vistas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newDrawing, newProject, type DrawingDoc } from "../src/doc/project.ts";
import { ISO_SCALES, autoLayout } from "../src/drawing/auto-layout.ts";
import { FRAME, SHEET_SIZES, TITLE_H } from "../src/drawing/render-base.ts";

const source = { kind: "part" as const, id: "p1" };
const box = (x: number, y: number, z: number) => ({ min: [0, 0, 0] as [number, number, number], max: [x, y, z] as [number, number, number] });
const drawing = (projection: "first" | "third" = "first"): DrawingDoc => {
  const d = newDrawing(newProject());
  return { ...d, sheet: { ...d.sheet, projection } };
};
const isIso = (s: [number, number]) => ISO_SCALES.some(([n, m]) => n === s[0] && m === s[1]);

test("quatro vistas: frente, duas projetadas e isométrica, com escala normalizada", () => {
  const out = autoLayout(drawing(), source, box(100, 60, 40));
  assert.equal(out.views.length, 4);
  assert.ok(isIso(out.sheet.scale), `${out.sheet.scale}`);
  assert.deepEqual(out.sheet.scale, [1, 1]); // 100×60×40 e a isométrica cabem a 1:1 numa A3, não a 2:1
  const [front, plan, side, iso] = out.views;
  assert.ok(front.kind === "model" && front.orientation === "front");
  assert.ok(plan.kind === "projected" && plan.side === "below" && plan.parent === front.id);
  assert.ok(side.kind === "projected" && side.side === "right");
  assert.ok(iso.kind === "model" && iso.orientation === "iso");
});

test("1.º diedro: planta abaixo da frente; 3.º diedro: acima", () => {
  const f = autoLayout(drawing("first"), source, box(100, 60, 40)).views;
  assert.ok(f[1].at[1] < f[0].at[1] && f[2].at[1] === f[0].at[1] && f[2].at[0] > f[0].at[0]);
  const t = autoLayout(drawing("third"), source, box(100, 60, 40)).views;
  assert.ok(t[1].kind === "projected" && t[1].side === "above" && t[1].at[1] > t[0].at[1]);
});

test("as vistas ficam dentro da área útil, sem tocar na legenda", () => {
  for (const b of [box(100, 60, 40), box(2000, 300, 500), box(5, 5, 80)]) {
    const out = autoLayout(drawing(), source, b);
    const [w, h] = SHEET_SIZES[out.sheet.size];
    for (const v of out.views) {
      assert.ok(v.at[0] > FRAME.left && v.at[0] < w - FRAME.right, `x ${v.at[0]}`);
      assert.ok(v.at[1] > FRAME.bottom + TITLE_H && v.at[1] < h - FRAME.top, `y ${v.at[1]}`);
    }
  }
});

test("com fitSheet escolhe a menor folha que permite 1:1", () => {
  assert.equal(autoLayout(drawing(), source, box(50, 30, 20), { fitSheet: true }).sheet.size, "A4");
  const mid = autoLayout(drawing(), source, box(300, 200, 150), { fitSheet: true });
  assert.deepEqual(mid.sheet.scale, [1, 1]);
  assert.ok(mid.sheet.size !== "A4" && mid.sheet.size !== "A0", mid.sheet.size);
  // um casco de 12 m não cabe a 1:1: a melhor escala da A0 (1:50), já atingida numa A2
  const hull = autoLayout(drawing(), source, box(12000, 4000, 3000), { fitSheet: true });
  assert.deepEqual(hull.sheet.scale, [1, 50]);
  assert.equal(hull.sheet.size, "A2");
});

test("peça plana: espessura mínima e escala finita", () => {
  const out = autoLayout(drawing(), source, box(200, 100, 0));
  assert.ok(isIso(out.sheet.scale));
  assert.ok(out.views.every((v) => Number.isFinite(v.at[0]) && Number.isFinite(v.at[1])));
});
