import type { PluginMeta } from "../types.ts";

// Módulo náutico (opcional): casco paramétrico simplificado e hidrostática de conceção.
export const nauticaMeta = {
  id: "nautica",
  name: "Náutica",
  kinds: {
    casco: {
      label: "Casco paramétrico",
      params: {
        L: { label: "Comprimento L", value: 8000, unit: "mm", min: 1000 },
        B: { label: "Boca B", value: 2600, unit: "mm", min: 300 },
        D: { label: "Pontal acima da LA", value: 1200, unit: "mm", min: 100 },
        T: { label: "Calado T", value: 500, unit: "mm", min: 50 },
        stations: { label: "Nº de secções", value: 9, min: 5, max: 21, integer: true },
      },
      help: {
        title: "Casco paramétrico",
        what: "Gera um casco simétrico a partir das dimensões principais e estima a hidrostática na linha de água.",
        steps: ["Defina comprimento, boca, pontal e calado.", "Ajuste o número de secções do loft.", "Leia o volume, o deslocamento e o centro de carena no painel de resultados."],
        tip: "Estimativa de conceção: não substitui um cálculo de estabilidade nem tem valor de certificação.",
      },
    },
  },
} satisfies PluginMeta;
