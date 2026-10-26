import { buildHull, hydrostatics } from "./geometry-hull.js";

const fmt = (v, d = 2) => v.toLocaleString("pt-PT", { maximumFractionDigits: d, minimumFractionDigits: d });

export const builders = {
  casco(p) {
    const shape = buildHull(p);
    const h = hydrostatics(shape, p);
    return {
      shape,
      info: {
        title: "Hidrostática (estimativa)",
        rows: [
          ["Volume imerso ∇", `${fmt(h.volume)} m³`],
          ["Deslocamento Δ (ρ=1025)", `${fmt(h.displacementKg / 1000)} t`],
          ["LCB (da popa)", `${fmt(h.lcb)} m · ${fmt((100 * h.lcb) / p.L, 1)}% L`],
          ["VCB (abaixo da LA)", `${fmt(-h.vcb)} m`],
          ["Coef. de bloco CB", fmt(h.volume / (p.L * p.B * p.T), 3)],
        ],
        note: "Hipóteses: águas paradas, sem caimento nem adornamento, LA em z = 0, água salgada ρ = 1025 kg/m³, geometria paramétrica simplificada. Estimativa de conceção: não substitui um cálculo de estabilidade nem tem valor de certificação.",
      },
    };
  },
};
