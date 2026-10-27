// No browser: as fontes dos módulos entram no pacote como texto (Vite `?raw`) a partir do submódulo.
import pressure from "../../vendor/galkeel-calculadora/assets/iso12215-5-pressure.js?raw";
import frp from "../../vendor/galkeel-calculadora/assets/iso12215-5-frp-scantling.js?raw";
import { type GalkeelCalc, galkeelCalc } from "./calc.ts";

declare const __GALKEEL_CALC_VERSION__: string;

let cached: GalkeelCalc | null = null;
export const browserCalc = () => (cached ??= galkeelCalc({ pressure, frp, version: typeof __GALKEEL_CALC_VERSION__ === "string" ? __GALKEEL_CALC_VERSION__ : "?" }));
