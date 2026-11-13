// Verificação cruzada do módulo de laminados (ISO 12215-5:2019, anexo C) com a implementação independente
// da edição de 2008 na galkeel-calculadora (submódulo privado, carregado tal como está): espessura por
// massa de reforço (eq. C.1/C.3) e módulos de vidro (Tabela C.4a), mais um laminado de referência.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadCalcModule } from "../src/galkeel/calc.ts";
import {
  abd, compositeDensity, elasticConstants, guidancePhi, isoPlyToOrtho, laminateModuli, phiFromPsi, plyMassKgM2, plyThicknessMm, psiFromPhi,
  type OrthoPly,
} from "../src/sim/laminate.ts";

const file = new URL("../vendor/galkeel-calculadora/assets/iso12215-5-frp-scantling.js", import.meta.url);
const skip = !existsSync(file) && "submódulo privado galkeel-calculadora não inicializado";
const ref = skip ? (undefined as never) : (loadCalcModule(readFileSync(file, "utf8"), "iso12215-5-frp-scantling.js") as unknown as {
  glassThicknessPerMass(psi: number): number;
  glassFibreContentFromRatio(tOverW: number): number;
  carbonThicknessPerMass(psi: number): number;
  thicknessToFibreMass(t: number, psi: number, fibre?: string): number;
  glassMechanicalProperties(psi: number, layup: string): Record<string, number>;
});
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

test("eq. C.1/C.2 (vidro): a espessura por massa é a mesma nas duas edições", { skip }, () => {
  for (const psi of [0.25, 0.3, 0.4, 0.5, 0.6, 0.7]) {
    const phi = phiFromPsi(psi, "glass");
    // t/w (mm por kg/m²) e o inverso: 2008 em ψ, 2019 em φ, mesmas massas volúmicas (2,56 e 1,2)
    assert.ok(rel(plyThicknessMm(1, phi, "glass"), ref.glassThicknessPerMass(psi)) < 1e-3, `ψ = ${psi}`);
    assert.ok(rel(psiFromPhi(phi, "glass"), ref.glassFibreContentFromRatio(plyThicknessMm(1, phi, "glass"))) < 1e-3, `ψ = ${psi}`);
    assert.ok(rel(plyMassKgM2(5, phi, "glass"), ref.thicknessToFibreMass(5, psi, "glass")) < 1e-3, `ψ = ${psi}`);
  }
});

test("eq. C.3 (carbono): diferença só da massa volúmica da fibra (1,78 em 2019, 1,8 em 2008)", { skip }, () => {
  for (const psi of [0.4, 0.5, 0.6, 0.7]) {
    const t = plyThicknessMm(1, phiFromPsi(psi, "carbon"), "carbon");
    const r = ref.carbonThicknessPerMass(psi);
    assert.ok(t > r && rel(t, r) < 0.025, `ψ = ${psi}: ${t} vs ${r}`);
    // t/w = 1/ρf − 1/ρm + 1/(ψ·ρm): a diferença é a constante 1/1,78 − 1/1,8, igual para todo o ψ
    assert.ok(Math.abs(t - r - (1 / 1.78 - 1 / 1.8)) < 1e-9, `ψ = ${psi}`);
  }
});

test("Tabela C.5 (2019) contra Tabela C.4a (2008): módulos de vidro na mesma ordem", { skip }, () => {
  // as edições usam modelos diferentes (micromecânica ζ = 1 contra regressões em ψ): tolerâncias largas,
  // só dentro da gama de ψ habitual de cada reforço
  for (const psi of [0.35, 0.42, 0.48, 0.55]) {
    const e = elasticConstants(phiFromPsi(psi, "glass"), "glass");
    const ud = ref.glassMechanicalProperties(psi, "ud_parallel");
    const udT = ref.glassMechanicalProperties(psi, "ud_perpendicular");
    const mat = ref.glassMechanicalProperties(psi, "mat_roving_wr_cp");
    assert.ok(rel(e.eUD1, ud.E) < 0.12, `E1 UD, ψ = ${psi}: ${e.eUD1} vs ${ud.E}`);
    assert.ok(rel(e.eUD2, udT.E) < 0.2, `E2 UD, ψ = ${psi}: ${e.eUD2} vs ${udT.E}`);
    assert.ok(rel(e.gUD12, ud.G) < 0.1, `G12 UD, ψ = ${psi}: ${e.gUD12} vs ${ud.G}`);
    assert.ok(rel(e.eCSM, mat.E) < 0.15, `E manta, ψ = ${psi}: ${e.eCSM} vs ${mat.E}`);
  }
});

test("laminado de referência: manta 450 / tecido 600 / manta 450, vidro, contacto simples", () => {
  const phiCsm = guidancePhi("glass", "csm", "hand-simple")!;
  const phiWr = guidancePhi("glass", "wr", "hand-simple")!;
  const csm = isoPlyToOrtho({ fibre: "glass", ply: "csm", w: 0.45, phi: phiCsm })!;
  const wr = isoPlyToOrtho({ fibre: "glass", ply: "wr", w: 0.6, phi: phiWr })!;
  const plies: OrthoPly[] = [...csm, ...wr, ...csm];
  const t = plies.reduce((a, p) => a + p.t, 0);
  // espessuras do anexo C: t = w/(φ·ρf)
  const tCsm = 0.45 / (phiCsm * 2.56), tWr = 0.6 / (phiWr * 2.56);
  assert.ok(Math.abs(t - (2 * tCsm + tWr)) < 1e-9);
  assert.ok(Math.abs(tCsm - 1.053) < 1e-3 && Math.abs(tWr - 0.781) < 1e-3, `${tCsm} ${tWr}`);
  // massa do laminado (reforço + resina) = Σ t·ρc
  const mass = 2 * tCsm * compositeDensity(phiCsm, "glass") + tWr * compositeDensity(phiWr, "glass");
  const resin = (2 * tCsm * (1 - phiCsm) + tWr * (1 - phiWr)) * 1.2;
  assert.ok(Math.abs(mass - (1.5 + resin)) < 1e-9 && Math.abs(mass - 4.26) < 0.01, `massa ${mass}`);
  // simétrico e balanceado: Ex = Ey (manta e tecido equilibrado), Ex entre o da manta e o do tecido
  const mod = laminateModuli(abd(plies))!;
  const e = elasticConstants(phiCsm, "glass"), eW = elasticConstants(phiWr, "glass");
  assert.ok(Math.abs(mod.ex - mod.ey) / mod.ex < 1e-9);
  assert.ok(mod.ex > e.eCSM && mod.ex < eW.eBD, `Ex ${mod.ex}`);
  // média das rigidezes de membrana pesada pela espessura (camadas quase isótropas no plano)
  const avg = (2 * tCsm * e.eCSM + tWr * eW.eBD) / t;
  assert.ok(Math.abs(mod.ex - avg) / avg < 0.03, `Ex ${mod.ex} vs ${avg}`);
});
