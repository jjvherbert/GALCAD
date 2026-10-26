import type { PluginMeta } from "../types.ts";

// Módulo náutico (opcional): casco paramétrico simplificado e hidrostática de conceção.
export const nauticaMeta: PluginMeta = {
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
        stations: { label: "Nº de secções", value: 9, min: 5, max: 21 },
      },
    },
  },
};
