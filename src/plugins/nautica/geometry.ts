import type { PluginBuilders } from "../types.ts";
import { buildHull, hydrostatics, type HullParams } from "./hull.ts";

const fmt = (v: number, d = 2) => v.toLocaleString("pt-PT", { maximumFractionDigits: d, minimumFractionDigits: d });

export const nauticaBuilders: PluginBuilders = {
  casco(p) {
    const hp = p as unknown as HullParams;
    const shape = buildHull(hp);
    const h = hydrostatics(shape, hp);
    const L = hp.L / 1000;
    return {
      shape,
      info: {
        title: "Hidrostática (estimativa)",
        rows: [
          ["Volume imerso ∇", `${fmt(h.volume)} m³`],
          ["Deslocamento Δ (ρ=1025)", `${fmt(h.displacementKg / 1000)} t`],
          ["LCB (da popa)", `${fmt(h.lcb)} m · ${fmt((100 * h.lcb) / L, 1)}% L`],
          ["VCB (abaixo da LA)", `${fmt(-h.vcb)} m`],
          ["Coef. de bloco CB", fmt((h.volume * 1e9) / (hp.L * hp.B * hp.T), 3)],
        ],
        note: "Hipóteses: águas paradas, sem caimento nem adornamento, LA em z = 0, água salgada ρ = 1025 kg/m³, geometria paramétrica simplificada. Estimativa de conceção: não substitui um cálculo de estabilidade nem tem valor de certificação.",
      },
    };
  },
};
