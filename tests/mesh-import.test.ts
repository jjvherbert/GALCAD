import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import { featureError } from "../src/doc/schema.ts";
import { bytesToBase64, base64ToBytes } from "../src/doc/base64.ts";
import { MAX_TRIANGLES, stlTriangles } from "../src/kernel/features/mesh.ts";

before(initKernel);

type V = [number, number, number];
/** Cubo de aresta a com triângulos orientados para fora; `skip` tira triângulos (malha aberta). */
function cube(a: number, skip = 0): V[][] {
  const p = (i: number): V => [i & 1 ? a : 0, i & 2 ? a : 0, i & 4 ? a : 0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const tris = quads.flatMap(([a0, b, c, d]) => [[p(a0), p(b), p(c)], [p(a0), p(c), p(d)]]);
  return tris.slice(skip);
}
function binary(tris: V[][]): Uint8Array {
  const b = new Uint8Array(84 + 50 * tris.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.forEach((v, j) => v.forEach((x, k) => dv.setFloat32(84 + 50 * i + 12 + 12 * j + 4 * k, x, true))));
  return b;
}
function ascii(tris: V[][]): Uint8Array {
  const body = tris.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((v) => `vertex ${v.join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n");
  return new TextEncoder().encode(`solid c\n${body}\nendsolid c\n`);
}
const rebuild = (bytes: Uint8Array) => {
  const d = addFeature(newDocument(), { type: "import", format: "stl", fileName: "c.stl", data: bytesToBase64(bytes), op: "new" }).doc;
  assert.equal(featureError(d.features[0] as never), null); // o esquema aceita format: "stl"
  return new KernelService().rebuild(d);
};

test("base64 e contagem de triângulos (binário e ASCII)", () => {
  const b = binary(cube(10));
  assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
  assert.equal(stlTriangles(b), 12);
  assert.equal(stlTriangles(ascii(cube(10))), 12);
});

for (const [name, enc] of [["binário", binary], ["ASCII", ascii]] as const) {
  test(`STL ${name}: cubo fechado vira sólido com o volume certo`, async () => {
    const r = await rebuild(enc(cube(10)));
    assert.equal(r.status.f1.state, "ok", r.status.f1.error ?? "");
    assert.ok(Math.abs(r.mass!.volume - 1000) < 1e-3, `${r.mass!.volume}`);
    const rows = Object.fromEntries(r.status.f1.info!.rows);
    assert.equal(rows["Triângulos"], "12");
    assert.equal(rows["Sólidos"], "1");
    assert.equal(rows["Faces"], "6"); // triângulos coplanares juntos
  });
}

test("STL aberto: fica como superfície, com aviso", async () => {
  const r = await rebuild(binary(cube(10, 2)));
  assert.equal(r.status.f1.state, "warning", r.status.f1.error ?? "");
  assert.ok(r.status.f1.warnings.some((w) => /não é fechada/.test(w)));
  assert.ok(!r.mass);
});

test("STL acima do limite de triângulos: erro claro", async () => {
  const b = new Uint8Array(84 + 50 * (MAX_TRIANGLES + 1));
  new DataView(b.buffer).setUint32(80, MAX_TRIANGLES + 1, true);
  const r = await rebuild(b);
  assert.equal(r.status.f1.state, "error");
  assert.match(r.status.f1.error ?? "", /limite/);
});
