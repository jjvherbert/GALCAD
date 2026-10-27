// Estudo de convergência da malha: GCI de Celik et al. (2008) contra o exemplo publicado e contra
// soluções sintéticas f = f∞ + C·h^p.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convergenceReport, gci } from "../src/sim/convergence.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

test("GCI: exemplo do artigo de Celik et al. (2008), malhas 2D 18000/8000/4500", () => {
  const g = gci([18000, 8000, 4500], [6.063, 5.972, 5.863], 2);
  near(g.r21, 1.5, 1e-12);
  near(g.r32, 4 / 3, 1e-12);
  near(g.p, 1.53, 0.005);
  near(g.extrapolated, 6.1685, 5e-4);
  near(g.ea21 * 100, 1.5, 0.01);
  near(g.eext21 * 100, 1.7, 0.05);
  near(g.gciFine * 100, 2.2, 0.05);
  assert.equal(g.behaviour, "monotonic");
});

test("GCI: ordem e valor extrapolado exatos para f = f∞ + C·h^p (razões diferentes)", () => {
  const h = [1, 1.3, 2];
  const n = h.map((x) => 1 / x ** 3) as [number, number, number];
  const g = gci(n, h.map((x) => 3 - 0.2 * x ** 1.6) as [number, number, number]);
  near(g.p, 1.6, 1e-9);
  near(g.extrapolated, 3, 1e-9);
  const o = gci(n, [1.0, 1.1, 0.95]);
  assert.equal(o.behaviour, "oscillatory");
  assert.ok(o.notes.some((x) => /oscilatória/.test(x)));
  assert.equal(gci(n, [1, 1.2, 1.5]).behaviour, "monotonic");
  const d = gci(n, [1, 1.5, 1.6]);
  assert.equal(d.behaviour, "divergent");
  assert.ok(d.notes.some((x) => /afastam-se/.test(x)));
  assert.equal(gci(n, [1, 1, 1.2]).behaviour, "converged");
});

test("relatório de convergência: só as grandezas presentes nas três malhas", () => {
  const m = (cells: number, u: number, extra?: number) => ({ cells, size: 1, metrics: [{ key: "u", label: "u", unit: "mm", value: u }, ...(extra === undefined ? [] : [{ key: "s", label: "s", unit: "MPa", value: extra }])] });
  const r = convergenceReport(1.5, [m(8000, 1.0, 5), m(2370, 0.98, 4), m(702, 0.95)]);
  assert.deepEqual(r.rows.map((x) => x.key), ["u"]);
  assert.deepEqual(r.rows[0].values, [1.0, 0.98, 0.95]);
  near(r.rows[0].gci.r21, 1.5, 0.01);
  assert.ok(r.hypotheses.some((h) => /Celik/.test(h)));
});
