// Plugin náutico (módulo opcional): casco paramétrico e hidrostática simplificada.
export default {
  id: "nautica",
  name: "Náutica",
  models: {
    casco: {
      label: "Casco (loft de secções)",
      units: "m",
      waterline: true,
      params: {
        L: { label: "Comprimento L", min: 3, max: 20, step: 0.1, value: 8 },
        B: { label: "Boca B", min: 1, max: 6, step: 0.05, value: 2.6 },
        D: { label: "Pontal D (acima da LA)", min: 0.3, max: 3, step: 0.05, value: 1.2 },
        T: { label: "Calado T", min: 0.1, max: 2, step: 0.05, value: 0.5 },
        stations: { label: "Nº de secções", min: 5, max: 21, step: 1, value: 9, unitless: true },
      },
    },
  },
};
