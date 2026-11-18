// Menu flutuante: encosta-se à direita do botão, fica dentro do ecrã e abre para cima se não couber.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeMenu } from "../src/app/place-menu.ts";

const btn = (left: number, top: number) => ({ left, top, right: left + 20, bottom: top + 20 });

test("abre por baixo, encostado à direita do botão", () => {
  assert.deepEqual(placeMenu(btn(300, 100), 220, 200, 1440, 900), { top: 122, left: 100, up: false });
});

test("sem espaço em baixo abre para cima", () => {
  const p = placeMenu(btn(300, 800), 220, 200, 1440, 900);
  assert.equal(p.up, true);
  assert.equal(p.top, 800 - 2 - 200);
});

test("não sai pela esquerda nem pela direita do ecrã", () => {
  assert.equal(placeMenu(btn(10, 100), 220, 200, 390, 800).left, 4);
  assert.equal(placeMenu({ left: 380, right: 420, top: 100, bottom: 120 }, 220, 200, 390, 800).left, 390 - 220 - 4);
});

test("sem espaço nem em cima nem em baixo: lado com mais espaço, com scroll, sem tapar o botão", () => {
  // botão em 150..170 numa janela de 500: em baixo há 324, em cima 144
  const p = placeMenu(btn(300, 150), 220, 400, 1440, 500);
  assert.deepEqual({ up: p.up, top: p.top, maxHeight: p.maxHeight }, { up: false, top: 172, maxHeight: 500 - 4 - 172 });
  // botão perto do fundo: abre para cima, do topo até ao botão
  const q = placeMenu(btn(300, 400), 220, 450, 1440, 500);
  assert.deepEqual({ up: q.up, top: q.top, maxHeight: q.maxHeight }, { up: true, top: 4, maxHeight: 400 - 2 - 4 });
  assert.ok(q.top + q.maxHeight! <= 400 - 2);
  // quando cabe, não há maxHeight
  assert.equal(placeMenu(btn(300, 100), 220, 200, 1440, 900).maxHeight, undefined);
});
