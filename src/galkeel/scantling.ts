// Análise integrada de painéis para a Galkeel: geometria medida no modelo (kernel/panels.ts) +
// pressões de projeto e espessura de chapeamento FRP monolítico calculadas PELOS MÓDULOS DA
// galkeel-calculadora (ISO 12215-5:2008, edição retirada — resultado legado e indicativo) +, se
// pedido, verificação por FEM com a mesma pressão. Produz o relatório (HTML) e os resultados no
// contrato da galkeel-app (`galkeel:calculator-result`, tag `iso12215-5-frp`), sempre com o veredito
// "indeterminado": não é cumprimento nem certificação. Puro (recebe a calculadora carregada).
import type { Vec3 } from "../doc/types.ts";
import type { FemStudy } from "../doc/study.ts";
import type { PanelGeom } from "../kernel/panels.ts";
import type { GalkeelCalc } from "./calc.ts";

export const EDITION = "ISO 12215-5:2008 (edição retirada, substituída pela ISO 12215-5:2019) — método legado";

export interface VesselRecord {
  craft: "motor" | "sail";
  category: "A" | "B" | "C" | "D";
  /** m */
  LH: number;
  LWL: number;
  /** boca no chine a 0,4·LWL (m), só motor */
  Bc: number;
  /** ângulo de deadrise a 0,4·LWL (°), só motor */
  beta04: number;
  /** velocidade máxima (nós), só motor */
  V: number;
  /** massa em carga máxima (kg) */
  mLDC: number;
  /** GZ máx. até 60° (m), só vela (opcional) */
  GZmax60?: number;
  /** Eixos do modelo: coordenada X (mm) da extremidade de ré da LWL, sentido de vante (+1/−1 em X), Z (mm) da linha de água e altura do costado/convés acima da LA (m). */
  xAft: number;
  forward: 1 | -1;
  zWL: number;
  Zside: number;
}

export interface Laminate {
  layup: "mat_roving_wr_cp" | "sprayed";
  psi: number;
  /** k5 (tipo de fibra, cl. 10.5.6): 1,0 vidro E ≤ 50 % CSM; 0,9 vidro contínuo; 0,7 aramida/carbono */
  k5: number;
  name?: string;
}

export interface PanelInput {
  face: string;
  label?: string;
  target: "auto" | "bottom" | "side" | "deck";
  /** Dimensões entre apoios (mm) a usar em vez das medidas (o engenheiro confirma os apoios). */
  b?: number;
  l?: number;
  c?: number;
  /** Espessura real do laminado (mm), se conhecida. */
  thickness?: number;
}

export interface PanelResult {
  face: string;
  label: string;
  target: "bottom" | "side" | "deck";
  targetAuto: boolean;
  geometry: { b: number; l: number; c: number; measured: { b: number; l: number; c: number }; area: number; center: Vec3; x: number; h: number };
  pressureKPa: number;
  pressureRule: string;
  sigmaUf: number;
  sigmaD: number;
  requiredThicknessMm: number;
  minimumThicknessMm: number;
  governingThicknessMm: number;
  actualThicknessMm?: number;
  /** espessura real / governante (≥ 1 cumpre o critério numérico desta folha) */
  ratio?: number;
  fem?: { stressMPa: number; utilisation: number; probe: string };
  warnings: string[];
  raw: { pressure: Record<string, unknown>; frp: Record<string, unknown> };
}

/** Zona do painel: convés se a normal aponta para cima, fundo se para baixo ou abaixo da LA, costado no resto. */
export function autoTarget(normal: Vec3, h: number): "bottom" | "side" | "deck" {
  if (normal[2] > 0.5) return "deck";
  if (normal[2] < -0.5 || h < 0) return "bottom";
  return "side";
}

export function analysePanel(calc: GalkeelCalc, v: VesselRecord, lam: Laminate, inp: PanelInput, g: PanelGeom): PanelResult {
  const warnings: string[] = [];
  const x = (v.forward * (g.center[0] - v.xAft)) / 1000, h = (g.center[2] - v.zWL) / 1000;
  const target = inp.target === "auto" ? autoTarget(g.normal, h) : inp.target;
  const b = inp.b ?? g.b, l = inp.l ?? g.l, c = inp.c ?? g.crown;
  if (x < 0 || x > v.LWL) warnings.push(`Centro do painel fora da LWL (x = ${x.toFixed(2)} m de 0 a ${v.LWL} m): confirme xAft e o sentido de vante`);
  if (inp.b === undefined || inp.l === undefined) warnings.push("b e l medidos na face do modelo: a norma pede o painel entre apoios (reforços, anteparas, chines) — confirmar");
  const common = { LWL: v.LWL, mLDC: v.mLDC, category: v.category, componentType: "panel", x, sandwich: false, b, l, target, h, Z: v.Zside };
  const pr = v.craft === "motor"
    ? calc.pressure.calculateMotorCraftPressures({ ...common, Bc: v.Bc, beta04: v.beta04, V: v.V })
    : calc.pressure.calculateSailingCraftPressures({ ...common, GZmax60: v.GZmax60 });
  warnings.push(...pr.warnings);
  const R = pr.results as Record<string, number | string | undefined>;
  const pick: Record<string, [string, string]> = v.craft === "motor"
    ? { bottom: ["bottomPressure", `fundo: maior de PBMD e PBMP (${R.bottomMode === "planing" ? "planeio" : "deslocamento"})`], side: ["sidePressure", String(R.sideRule ?? "costado")], deck: ["PDM", "convés: PDM"] }
    : { bottom: ["PBS", "fundo: PBS"], side: ["sidePressure", "costado: PSS"], deck: ["PDS", "convés: PDS"] };
  const P = Number(R[pick[target][0]]);
  if (!Number.isFinite(P)) throw new Error(`Painel ${inp.label ?? g.name}: a calculadora não devolveu a pressão (${pr.warnings.join("; ") || "dados em falta"})`);
  const props = calc.frp.glassMechanicalProperties(lam.psi, lam.layup);
  const frp = calc.frp.calculateFrpSingleSkinThickness({ b, l, c, P, sigma_uf: props.sigma_uf });
  warnings.push(...frp.warnings);
  const tOverW = calc.frp.glassThicknessPerMass(lam.psi);
  const tMin = target === "deck"
    ? calc.frp.calculateFrpMinimumDeckThickness({ LWL: v.LWL, k5: lam.k5, psi: lam.psi, fibreType: "glass" }).t_MIN
    : calc.frp.calculateFrpMinimumHullThickness({ location: target, LWL: v.LWL, V: v.V, mLDC: v.mLDC, k5: lam.k5, isSailingCraft: v.craft === "sail" }).w_MIN * tOverW;
  const gov = Math.max(frp.thicknessMm, tMin);
  const ratio = inp.thickness !== undefined ? inp.thickness / gov : undefined;
  if (inp.thickness === undefined) warnings.push("Sem espessura real do laminado: só a espessura requerida");
  return {
    face: g.name, label: inp.label ?? g.name, target, targetAuto: inp.target === "auto",
    geometry: { b, l, c, measured: { b: g.b, l: g.l, c: g.crown }, area: g.area, center: g.center, x, h },
    pressureKPa: P, pressureRule: pick[target][1], sigmaUf: props.sigma_uf, sigmaD: frp.sigma_d,
    requiredThicknessMm: frp.thicknessMm, minimumThicknessMm: tMin, governingThicknessMm: gov, actualThicknessMm: inp.thickness, ratio,
    warnings, raw: { pressure: pr.results, frp: { ...frp, minimumThicknessMm: tMin, laminate: lam, sigma_uf: props.sigma_uf } },
  };
}

/** Avaliação por FEM: tensão de von Mises no painel (sonda) contra σd = 0,5·σuf (Tabela 7 do método). */
export function femCheck(r: PanelResult, stressMPa: number, probe: string): PanelResult {
  const utilisation = stressMPa / r.sigmaD;
  const w = utilisation > 1 ? [`FEM: σ = ${stressMPa.toFixed(1)} MPa acima de σd = ${r.sigmaD.toFixed(1)} MPa (utilização ${(100 * utilisation).toFixed(0)} %)`] : [];
  return { ...r, fem: { stressMPa, utilisation, probe }, warnings: [...r.warnings, ...w] };
}

/**
 * Estudo FEM de verificação: os apoios do estudo base, a pressão de projeto de cada painel (kN/m² →
 * MPa) na face do painel e uma sonda de von Mises máxima por painel (probe1, probe2, …).
 */
export function femStudyForPanels(base: FemStudy, results: PanelResult[]): FemStudy {
  return {
    ...base, id: "__galkeel", name: `${base.name} — pressões ISO 12215-5 (Galkeel)`, analysis: "static", nonlinear: undefined,
    loads: [...base.loads.filter((l) => l.kind === "fixed" || l.kind === "displacement"), ...results.map((r) => ({ kind: "pressure" as const, faces: [{ kind: "face" as const, name: r.face }], p: r.pressureKPa / 1000 }))],
    probes: results.map((r) => ({ name: r.label, quantity: "vm" as const, stat: "max" as const, at: { kind: "faces" as const, faces: [{ kind: "face" as const, name: r.face }] } })),
  };
}

export const HYPOTHESES = [
  `Método: ${EDITION}; pressões de projeto (cl. 8) e espessura de chapeamento FRP monolítico por resistência à flexão (cl. 10.2, eq. 35) com mínimo absoluto (cl. 10.6), calculados pelos módulos da galkeel-calculadora`,
  "Só FRP monolítico de vidro E (Anexo C): não cobre sandwich, metal, madeira, laminados anisotrópicos nem reforços (cl. 11)",
  "Dimensões b, l e flecha c medidas na face do modelo (retângulo envolvente de área mínima e afastamento ao plano da fronteira) salvo indicação do engenheiro; a norma pede o painel entre apoios",
  "Posição x medida a partir da extremidade de ré da LWL e altura h acima da linha de água definidas no registo da embarcação",
  "Verificação por FEM (se feita): modelo sólido linear elástico isotrópico equivalente com a pressão de projeto, comparando von Mises na sonda com σd = 0,5·σuf — indicativa, não substitui o método",
  "Resultado de apoio à engenharia, com veredito indeterminado: não é declaração de conformidade, certificação nem decisão de autoridade ou organismo notificado",
];

/** Payloads para a galkeel-app (um por painel), no envelope {inputs, results, warnings} das calculadoras. */
export function galkeelPayloads(results: PanelResult[], v: VesselRecord, lam: Laminate, meta: { model: string; calcVersion: string; tool: string; date: string }) {
  return results.map((r) => ({
    type: "galkeel:calculator-result",
    calculator: "iso12215-5-frp",
    payload: {
      edition: EDITION,
      source: { tool: meta.tool, model: meta.model, face: r.face, panel: r.label, calculadora: meta.calcVersion, date: meta.date },
      inputs: {
        craft: v.craft, category: v.category, LH: v.LH, LWL: v.LWL, mLDC: v.mLDC, ...(v.craft === "motor" ? { Bc: v.Bc, beta04: v.beta04, V: v.V } : { GZmax60: v.GZmax60 ?? null }),
        target: r.target, b: r.geometry.b, l: r.geometry.l, c: r.geometry.c, x: r.geometry.x, h: r.geometry.h, psi: lam.psi, layup: lam.layup, k5: lam.k5,
        actualThicknessMm: r.actualThicknessMm ?? null,
      },
      results: {
        pressureKPa: r.pressureKPa, sigma_uf: r.sigmaUf, sigma_d: r.sigmaD, calculatedThicknessMm: r.requiredThicknessMm, minimumThicknessMm: r.minimumThicknessMm,
        requiredThicknessMm: r.governingThicknessMm, ...(r.ratio !== undefined ? { thicknessRatio: r.ratio } : {}), ...(r.fem ? { femStressMPa: r.fem.stressMPa, femUtilisation: r.fem.utilisation } : {}),
      },
      warnings: r.warnings,
      assessment: { verdict: "undetermined", reason: "Método legado (2008) e só critério de resistência do chapeamento; dimensões a confirmar entre apoios", blockers: ["Edição 2019 por implementar e rever", "Apoios e reforços não verificados", "Revisão por técnico habilitado"] },
      hypotheses: HYPOTHESES,
    },
  }));
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const n = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));

/** Relatório HTML autónomo (imprimível em PDF) com rastreabilidade, hipóteses e limitações. */
export function scantlingReport(results: PanelResult[], v: VesselRecord, lam: Laminate, meta: { model: string; calcVersion: string; tool: string; date: string; femSolver?: string; caseRef?: string }): string {
  const zone = { bottom: "Fundo", side: "Costado", deck: "Convés" };
  const rows = results.map((r) => `<tr>
    <td>${esc(r.label)}</td><td>${zone[r.target]}${r.targetAuto ? "*" : ""}</td>
    <td>${n(r.geometry.b, 0)}</td><td>${n(r.geometry.l, 0)}</td><td>${n(r.geometry.c, 1)}</td><td>${n(r.geometry.x)}</td><td>${n(r.geometry.h)}</td>
    <td>${n(r.pressureKPa)}</td><td>${n(r.requiredThicknessMm)}</td><td>${n(r.minimumThicknessMm)}</td><td><b>${n(r.governingThicknessMm)}</b></td>
    <td>${n(r.actualThicknessMm)}</td><td>${r.ratio === undefined ? "—" : n(r.ratio)}</td>
    <td>${r.fem ? `${n(r.fem.stressMPa, 1)} / ${n(r.sigmaD, 1)}` : "—"}</td></tr>`).join("\n");
  const warn = results.filter((r) => r.warnings.length).map((r) => `<li><b>${esc(r.label)}</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></li>`).join("");
  return `<!doctype html>
<html lang="pt-PT"><head><meta charset="utf-8"><title>Escantilhonamento de painéis — ${esc(meta.model)}</title>
<style>
body{font:11pt/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18pt;margin:0 0 4px}h2{font-size:13pt;margin:20px 0 6px;border-bottom:1px solid #999}
table{border-collapse:collapse;width:100%;font-size:9pt}td,th{border:1px solid #bbb;padding:3px 5px;text-align:right}th{background:#eee}td:first-child,th:first-child{text-align:left}
.meta td{text-align:left}.note{font-size:9pt;color:#444}.banner{border:2px solid #b45309;background:#fffbeb;padding:8px;margin:10px 0}
@media print{body{margin:10mm}}
</style></head><body>
<h1>Escantilhonamento de painéis — ${esc(meta.model)}</h1>
<p class="note">${esc(meta.date)}${meta.caseRef ? ` · caso ${esc(meta.caseRef)}` : ""}</p>
<div class="banner"><b>Resultado indicativo, veredito indeterminado.</b> ${esc(EDITION)}. Apoio à engenharia: não é declaração de conformidade, certificação nem decisão de autoridade ou organismo notificado.</div>
<h2>Rastreabilidade</h2>
<table class="meta"><tr><td>Modelo</td><td>${esc(meta.model)}</td></tr><tr><td>Ferramenta</td><td>${esc(meta.tool)}</td></tr>
<tr><td>Cálculo normativo</td><td>galkeel-calculadora ${esc(meta.calcVersion)} (assets/iso12215-5-pressure.js, iso12215-5-frp-scantling.js)</td></tr>
${meta.femSolver ? `<tr><td>FEM</td><td>${esc(meta.femSolver)}</td></tr>` : ""}</table>
<h2>Embarcação</h2>
<table class="meta"><tr><td>Tipo / categoria</td><td>${v.craft === "motor" ? "Motor" : "Vela"} / ${v.category}</td></tr>
<tr><td>LH · LWL</td><td>${n(v.LH)} m · ${n(v.LWL)} m</td></tr><tr><td>mLDC</td><td>${n(v.mLDC, 0)} kg</td></tr>
${v.craft === "motor" ? `<tr><td>Bc · β0,4 · V</td><td>${n(v.Bc)} m · ${n(v.beta04, 1)}° · ${n(v.V, 1)} nós</td></tr>` : `<tr><td>GZmax (≤60°)</td><td>${v.GZmax60 === undefined ? "—" : `${n(v.GZmax60)} m`}</td></tr>`}
<tr><td>Referências no modelo</td><td>ré da LWL em X = ${n(v.xAft, 0)} mm, vante para ${v.forward > 0 ? "+X" : "−X"}, LA em Z = ${n(v.zWL, 0)} mm, costado ${n(v.Zside)} m acima da LA</td></tr></table>
<h2>Laminado</h2>
<table class="meta"><tr><td>Laminado</td><td>${esc(lam.name ?? "PRFV monolítico, vidro E")} — ${lam.layup === "sprayed" ? "projetado" : "mat/roving/WR/CP"}, ψ = ${n(lam.psi)}, k5 = ${n(lam.k5)}</td></tr>
<tr><td>σuf · σd</td><td>${n(results[0]?.sigmaUf, 1)} MPa · ${n(results[0]?.sigmaD, 1)} MPa (Anexo C; σd = 0,5·σuf)</td></tr></table>
<h2>Painéis</h2>
<table><tr><th>Painel</th><th>Zona</th><th>b (mm)</th><th>l (mm)</th><th>c (mm)</th><th>x (m)</th><th>h (m)</th><th>P (kN/m²)</th><th>t resist. (mm)</th><th>t mín. (mm)</th><th>t requerida (mm)</th><th>t real (mm)</th><th>real / req.</th><th>FEM σ / σd (MPa)</th></tr>
${rows}</table>
<p class="note">* zona atribuída automaticamente pela normal e pela altura à LA. t requerida = maior de t resistência (cl. 10.2) e t mínima (cl. 10.6). A razão real/requerida ≥ 1 indica só que o critério numérico desta folha é satisfeito.</p>
${warn ? `<h2>Avisos</h2><ul>${warn}</ul>` : ""}
<h2>Hipóteses e limitações</h2><ul>${HYPOTHESES.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
</body></html>`;
}
