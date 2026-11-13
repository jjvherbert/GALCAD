// Desenho em janela própria: leitura de `?drawing=<id>` e endereço da janela nova.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newDrawing, newProject } from "../src/doc/project.ts";
import { drawingFromUrl, drawingWindowUrl } from "../src/app/doc-window.ts";

test("?drawing=<id> só conta se o desenho existir no projeto", () => {
  const p0 = newProject();
  const d = newDrawing(p0);
  const p = { ...p0, drawings: [d] };
  assert.equal(drawingFromUrl(p, `?drawing=${encodeURIComponent(d.id)}`), d.id);
  assert.equal(drawingFromUrl(p, "?drawing=nao-existe"), null);
  assert.equal(drawingFromUrl(p, ""), null);
  assert.equal(drawingFromUrl(p, "?outra=1"), null);
});

test("o endereço da janela volta a dar o mesmo desenho", () => {
  const p0 = newProject();
  const d = { ...newDrawing(p0), id: "d 1&x" };
  const p = { ...p0, drawings: [d] };
  const url = drawingWindowUrl("/app/", d.id);
  assert.ok(url.startsWith("/app/?drawing="));
  assert.equal(drawingFromUrl(p, url.slice(url.indexOf("?"))), d.id);
});
