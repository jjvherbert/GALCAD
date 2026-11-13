import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abd, compositeDensity, elasticConstants, guidancePhi, invert, isoPlyToOrtho, laminateFailure, laminateModuli,
  laminateResponse, plyFailureIndex, orthoPlyError, phiFromPsi, plyMassKgM2, plyResult, plyThicknessMm, psiFromPhi, qBar,
  type OrthoPly,
} from "../src/sim/laminate.ts";

const close = (a: number, b: number, rel = 1e-9, msg?: string) =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), msg ?? `${a} ≉ ${b}`);

const iso = (e: number, nu: number, t: number, theta = 0): OrthoPly => ({ e1: e, e2: e, g12: e / (2 * (1 + nu)), nu12: nu, t, theta });
const ud: Omit<OrthoPly, "t" | "theta"> = { e1: 140000, e2: 10000, g12: 5000, nu12: 0.3 };

test("anexo C: teor em fibra, espessura e massa (Tabela C.2)", () => {
  for (const fibre of ["glass", "carbon"] as const) {
    close(phiFromPsi(psiFromPhi(0.3, fibre), fibre), 0.3);
    close(plyMassKgM2(plyThicknessMm(0.6, 0.3, fibre), 0.3, fibre), 0.6);
  }
  // Vidro, φ = 0,3: ψ = 0,768/(0,768 + 0,84) e ρ = 0,768 + 0,84.
  close(psiFromPhi(0.3, "glass"), 0.768 / 1.608);
  close(compositeDensity(0.3, "glass"), 1.608);
  close(plyThicknessMm(0.45, 0.167, "glass"), 0.45 / (0.167 * 2.56));
});

test("anexo C: φ de referência (Tabela C.7) e combinações inexistentes", () => {
  assert.equal(guidancePhi("glass", "csm", "hand-simple"), 0.167);
  assert.equal(guidancePhi("carbon", "ud", "hand-complex"), 0.378);
  assert.equal(guidancePhi("carbon", "csm", "hand-simple"), null);
  assert.equal(guidancePhi("carbon", "rovimat", "rtm"), null);
});

test("anexo C: constantes da manta de vidro a φ = 0,167 (Tabela C.5)", () => {
  const c = elasticConstants(0.167, "glass");
  close(c.eUD1, 0.975 * (73000 * 0.167 + 3300 * 0.833));
  const etaE = (73000 / 3300 - 1) / (73000 / 3300 + 1);
  close(c.eUD2, (3300 * (1 + etaE * 0.167)) / (1 - etaE * 0.167));
  close(c.eCSM, (3 / 8) * c.eUD1 + (5 / 8) * c.eUD2);
  const r = plyResult({ fibre: "glass", ply: "csm", w: 0.45, phi: 0.167 })!;
  close(r.e, c.eCSM);
  close(r.sigmaUt, (c.eCSM * 1.35) / 100);
  close(r.tauU, (c.gCSM * 2.0) / 100);
});

test("anexo C: camadas inválidas dão null", () => {
  assert.equal(plyResult({ fibre: "glass", ply: "wr", w: 0, phi: 0.3 }), null);
  assert.equal(plyResult({ fibre: "glass", ply: "wr", w: 0.6, phi: 1 }), null);
  assert.equal(plyResult({ fibre: "carbon", ply: "csm", w: 0.3, phi: 0.3 }), null);
  assert.equal(plyResult({ fibre: "carbon", ply: "rovimat", w: 1.1, phi: 0.25 }), null);
  assert.equal(isoPlyToOrtho({ fibre: "carbon", ply: "csm", w: 0.3, phi: 0.3 }), null);
});

test("CLT: placa isotrópica dá A = Et/(1−ν²), B = 0 e D = Et³/(12(1−ν²))", () => {
  const E = 70000, nu = 0.3, t = 4;
  const l = abd([iso(E, nu, 1.5), iso(E, nu, 2.5)]);
  close(l.t, t);
  close(l.A[0][0], (E * t) / (1 - nu * nu));
  close(l.A[0][1], (nu * E * t) / (1 - nu * nu));
  close(l.A[2][2], (E * t) / (2 * (1 + nu)));
  close(l.D[0][0], (E * t ** 3) / (12 * (1 - nu * nu)));
  for (const row of l.B) for (const v of row) assert.ok(Math.abs(v) < 1e-6);
  const m = laminateModuli(l)!;
  close(m.ex, E); close(m.ey, E); close(m.exf, E);
  close(m.gxy, E / (2 * (1 + nu))); close(m.nuxy, nu);
});

test("CLT: rodar 90° troca E1 com E2; Q̄ sem termos 16/26 a 0° e 90°", () => {
  const q0 = qBar({ ...ud, t: 1, theta: 0 });
  const q90 = qBar({ ...ud, t: 1, theta: 90 });
  close(q90[0][0], q0[1][1]); close(q90[1][1], q0[0][0]); close(q90[0][1], q0[0][1]);
  assert.ok(Math.abs(q90[0][2]) < 1e-6 && Math.abs(q90[1][2]) < 1e-6);
  const m = laminateModuli(abd([{ ...ud, t: 1, theta: 90 }]))!;
  close(m.ex, ud.e2); close(m.ey, ud.e1);
});

test("CLT: [0/90]s à mão — B nulo, A11 = A22 e D11 > D22", () => {
  const t = 0.25;
  const ply = (theta: number): OrthoPly => ({ ...ud, t, theta });
  const l = abd([ply(0), ply(90), ply(90), ply(0)]);
  const q0 = qBar(ply(0));
  close(l.A[0][0], 2 * t * (q0[0][0] + q0[1][1]));
  close(l.A[0][0], l.A[1][1]);
  for (const row of l.B) for (const v of row) assert.ok(Math.abs(v) < 1e-6);
  // D11 = (Q11 · (z₂³ − z₁³)·2 + Q22 · (z₁³ − 0)·2)/3, com z₁ = 0,25 e z₂ = 0,5.
  close(l.D[0][0], (2 * (q0[0][0] * (0.5 ** 3 - 0.25 ** 3) + q0[1][1] * 0.25 ** 3)) / 3);
  assert.ok(l.D[0][0] > l.D[1][1]);
  assert.ok(Math.abs(l.A[0][2]) < 1e-6 && Math.abs(l.D[0][2]) < 1e-6);
});

test("CLT: laminado assimétrico [0/90] tem acoplamento B ≠ 0", () => {
  const l = abd([{ ...ud, t: 0.5, theta: 0 }, { ...ud, t: 0.5, theta: 90 }]);
  assert.ok(Math.abs(l.B[0][0]) > 1);
  close(l.B[0][0], -l.B[1][1]);
});

test("CLT: esforço N puro num laminado simétrico dá extensão uniforme e κ = 0", () => {
  const plies: OrthoPly[] = [0, 45, -45, 90, 90, -45, 45, 0].map((theta) => ({ ...ud, t: 0.2, theta }));
  const l = abd(plies);
  const m = laminateModuli(l)!;
  const nx = 100;
  const r = laminateResponse(plies, [nx, 0, 0])!;
  close(r.eps0[0], nx / (m.ex * l.t), 1e-9);
  for (const k of r.kappa) assert.ok(Math.abs(k) < 1e-12);
  for (const p of r.plies) close(p.bottom.strainXY[0], p.top.strainXY[0]);
  // Camada a 0°: σ1 = Q11·ε1 + Q12·ε2.
  const p0 = r.plies[0].bottom;
  close(p0.strain12[0], p0.strainXY[0]);
  // Equilíbrio: Σ σx·t = Nx (σx das tensões no material rodadas de volta).
  let sum = 0;
  plies.forEach((p, k) => {
    const q = qBar(p);
    const e = r.plies[k].bottom.strainXY;
    sum += (q[0][0] * e[0] + q[0][1] * e[1] + q[0][2] * e[2]) * p.t;
  });
  close(sum, nx, 1e-9);
});

test("CLT: momento puro numa placa isotrópica dá κ = M/D e σ = ±6M/t² nas faces", () => {
  const E = 70000, nu = 0.3, t = 2;
  const plies = [iso(E, nu, t)];
  const D = (E * t ** 3) / (12 * (1 - nu * nu));
  const r = laminateResponse(plies, [0, 0, 0], [10, 0, 0])!;
  // Flexão cilíndrica livre: κx = M/(D(1−ν²)), κy = −ν κx.
  close(r.kappa[0], 10 / (D * (1 - nu * nu)), 1e-9);
  close(r.kappa[1], -nu * r.kappa[0], 1e-9);
  close(r.plies[0].top.stress12[0], (6 * 10) / t ** 2, 1e-9);
  close(r.plies[0].bottom.stress12[0], (-6 * 10) / t ** 2, 1e-9);
});

test("ISO → CLT: tecido, biaxial e quadriaxial reproduzem E_BD, E_DBx, E_QX e G_QX da Tabela C.5", () => {
  const phi = 0.3;
  const c = elasticConstants(phi, "glass");
  const mod = (ply: "wr" | "dbx" | "qx" | "ud" | "csm") =>
    laminateModuli(abd(isoPlyToOrtho({ fibre: "glass", ply, w: 0.8, phi })!))!;
  close(mod("wr").ex, c.eBD, 1e-9);
  close(mod("dbx").ex, c.eDBx, 1e-9);
  close(mod("dbx").gxy, c.gDBx, 1e-9);
  close(mod("ud").ex, c.eUD1, 1e-9);
  close(mod("csm").ex, c.eCSM, 1e-9);
  close(mod("csm").gxy, c.gCSM, 1e-9);
  // QX: média de BD a 0° e a 45° — a fórmula da norma é a mesma (membrana, sem B na média de A).
  const qx = isoPlyToOrtho({ fibre: "glass", ply: "qx", w: 0.8, phi })!;
  const a = abd(qx).A;
  const t = qx.reduce((s, p) => s + p.t, 0);
  close(a[0][0] / t - a[0][1] ** 2 / (a[1][1] * t), c.eQX, 1e-9);
  close(a[2][2] / t, c.gQX, 1e-9);
  close(a[0][1] / a[1][1], c.nuQX, 1e-9);
  // Espessuras: a soma das partes é a espessura da camada.
  close(t, plyThicknessMm(0.8, phi, "glass"));
});

test("ISO → CLT: rovimat dá tecido + manta com a espessura da camada do anexo", () => {
  const input = { fibre: "glass", ply: "rovimat", w: 1.1, phi: 0.246 } as const;
  const parts = isoPlyToOrtho(input)!;
  assert.equal(parts.length, 2);
  close(parts.reduce((s, p) => s + p.t, 0), plyResult(input)!.t);
  // O anexo faz a média de E pela espessura; a CLT em membrana (só A) dá um pouco mais, porque os ν
  // do tecido e da manta diferem (Cauchy–Schwarz), e o laminado de duas camadas é assimétrico (B ≠ 0),
  // pelo que o módulo «livre de fletir» da inversa completa fica abaixo da média.
  const l = abd(parts);
  const exMembrane = (l.A[0][0] - l.A[0][1] ** 2 / l.A[1][1]) / l.t;
  const e = plyResult(input)!.e;
  assert.ok(exMembrane >= e && exMembrane < 1.02 * e, `${exMembrane} vs ${e}`);
  assert.ok(Math.abs(l.B[0][0]) > 1);
  assert.ok(laminateModuli(l)!.ex < e);
});

test("ISO → CLT: o ângulo de referência roda as camadas", () => {
  const p = isoPlyToOrtho({ fibre: "carbon", ply: "ud", w: 0.3, phi: 0.45 }, 90)!;
  assert.equal(p[0].theta, 90);
  const m = laminateModuli(abd(p))!;
  close(m.ey, elasticConstants(0.45, "carbon").eUD1, 1e-9);
});

test("validação de camadas ortotrópicas e inversa singular", () => {
  assert.equal(orthoPlyError({ ...ud, t: 1, theta: 0 }), null);
  assert.match(orthoPlyError({ ...ud, e2: 0, t: 1, theta: 0 })!, /positivos/);
  assert.match(orthoPlyError({ ...ud, t: 0, theta: 0 })!, /espessura/);
  assert.match(orthoPlyError({ ...ud, nu12: 4, t: 1, theta: 0 })!, /Poisson/);
  assert.match(orthoPlyError({ ...ud, t: 1, theta: NaN })!, /ângulo/);
  assert.equal(invert([[1, 2], [2, 4]]), null);
  const inv = invert([[4, 7], [2, 6]])!;
  close(inv[0][0], 0.6); close(inv[0][1], -0.7); close(inv[1][0], -0.2); close(inv[1][1], 0.4);
});

test("rotura por camada: extensão máxima com os limites da Tabela C.6", () => {
  const strains = { ut: 1.5, uc: 1.2, uf: 2, gamma: 2 };
  const p: OrthoPly = { ...iso(20000, 0.3, 1), strains };
  assert.equal(plyFailureIndex(iso(20000, 0.3, 1), [0.01, 0, 0]), null);
  assert.deepEqual(plyFailureIndex(p, [0.0075, 0, 0]), { index: 0.5, mode: "tração 1" });
  assert.deepEqual(plyFailureIndex(p, [0, -0.012, 0]), { index: 1, mode: "compressão 2" });
  const g = plyFailureIndex(p, [0.001, 0.001, -0.03])!;
  assert.equal(g.mode, "corte 12");
  close(g.index, 1.5);
});

test("rotura por camada: momento puro — camada crítica na face em compressão quando uc < ut", () => {
  const strains = { ut: 1.5, uc: 1.0, uf: 2, gamma: 2 };
  const plies: OrthoPly[] = [0, 1].map(() => ({ ...iso(20000, 0.3, 1), strains }));
  const r = laminateResponse(plies, [0, 0, 0], [100, 0, 0])!;
  const f = laminateFailure(plies, r);
  // κx > 0: z < 0 em compressão (camada 0, face inferior).
  assert.equal(f.critical!.ply, 0);
  assert.equal(f.critical!.mode, "compressão 1");
  close(f.critical!.index, -r.plies[0].bottom.strain12[0] / 0.01);
  close(f.plies[1]!.index, r.plies[1].top.strain12[0] / 0.015);
  assert.equal(laminateFailure([iso(20000, 0.3, 2)], laminateResponse([iso(20000, 0.3, 2)], [1, 0, 0])!).critical, null);
});

test("rotura por camada: camadas ISO trazem as extensões de rotura", () => {
  const [p] = isoPlyToOrtho({ fibre: "glass", ply: "wr", w: 0.8, phi: 0.4 })!;
  assert.deepEqual(p.strains, { ut: 1.55, uc: 1.4, uf: 1.84, gamma: 1.7 });
});
