// Ligação aos módulos de cálculo da galkeel-calculadora (submódulo vendor/galkeel-calculadora): o
// código é carregado TAL COMO ESTÁ (sem cópia nem reimplementação) e avaliado com um `module` próprio,
// porque os ficheiros são CommonJS para Node e globais para o browser. A versão (commit) do submódulo
// vai em cada resultado para rastreabilidade.
export type CalcModule = Record<string, (...a: never[]) => unknown> & Record<string, unknown>;

export function loadCalcModule(source: string, name: string): CalcModule {
  const module = { exports: {} as CalcModule };
  // os módulos são funções puras: sem acesso a nada além do próprio `module`
  new Function("module", "exports", `"use strict";\n${source}\n//# sourceURL=galkeel-calculadora/${name}`)(module, module.exports);
  if (!Object.keys(module.exports).length) throw new Error(`O módulo ${name} não exportou funções`);
  return module.exports;
}

/** Fontes dos módulos usados pela análise integrada. */
export interface CalcSources { pressure: string; frp: string; version: string }

export interface GalkeelCalc {
  pressure: { calculateMotorCraftPressures(i: Record<string, unknown>): { results: Record<string, unknown>; warnings: string[] }; calculateSailingCraftPressures(i: Record<string, unknown>): { results: Record<string, unknown>; warnings: string[] } };
  frp: {
    GLASS_FIBRE_CONTENT: Record<string, Record<string, number>>;
    glassMechanicalProperties(psi: number, layup: string): Record<string, number>;
    glassThicknessPerMass(psi: number): number;
    calculateFrpSingleSkinThickness(i: { b: number; l: number; c: number; P: number; sigma_uf: number }): { lOverB: number; k2: number; kC: number; sigma_d: number; thicknessMm: number; warnings: string[] };
    calculateFrpMinimumHullThickness(i: Record<string, unknown>): { w_MIN: number; effectiveV: number };
    calculateFrpMinimumDeckThickness(i: Record<string, unknown>): { t_MIN: number; w_MIN: number };
  };
  version: string;
}

export function galkeelCalc(src: CalcSources): GalkeelCalc {
  return { pressure: loadCalcModule(src.pressure, "iso12215-5-pressure.js") as never, frp: loadCalcModule(src.frp, "iso12215-5-frp-scantling.js") as never, version: src.version };
}
