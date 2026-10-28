// No browser: as fontes dos módulos entram no pacote como texto (Vite `?raw`) a partir do submódulo.
import pressure from "../../vendor/galkeel-calculadora/assets/iso12215-5-pressure.js?raw";
import frp from "../../vendor/galkeel-calculadora/assets/iso12215-5-frp-scantling.js?raw";
import { type GalkeelCalc, galkeelCalc } from "./calc.ts";

declare const __GALKEEL_CALC_VERSION__: string;

/** Falso numa compilação sem o submódulo (privado): a análise Galkeel fica indisponível, o resto não muda. */
export const calcAvailable = pressure.length > 0 && frp.length > 0;

let cached: GalkeelCalc | null = null;
export const browserCalc = () => {
  if (!calcAvailable) throw new Error("Esta compilação não inclui a galkeel-calculadora (submódulo privado)");
  return (cached ??= galkeelCalc({ pressure, frp, version: typeof __GALKEEL_CALC_VERSION__ === "string" ? __GALKEEL_CALC_VERSION__ : "?" }));
};
