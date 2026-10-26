// Metadados dos modelos (parâmetros e limites) — usado pela UI, sem dependência do núcleo geométrico.
export const modelDefs = {
  casco: {
    label: "Casco (loft de secções)",
    units: "m",
    params: {
      L: { label: "Comprimento L", min: 3, max: 20, step: 0.1, value: 8 },
      B: { label: "Boca B", min: 1, max: 6, step: 0.05, value: 2.6 },
      D: { label: "Pontal D (acima da LA)", min: 0.3, max: 3, step: 0.05, value: 1.2 },
      T: { label: "Calado T", min: 0.1, max: 2, step: 0.05, value: 0.5 },
      stations: { label: "Nº de secções", min: 5, max: 21, step: 1, value: 9 },
    },
  },
  placa: {
    label: "Placa com furo (peça)",
    units: "mm",
    params: {
      w: { label: "Largura", min: 20, max: 300, step: 1, value: 100 },
      h: { label: "Altura", min: 20, max: 300, step: 1, value: 60 },
      t: { label: "Espessura", min: 2, max: 50, step: 0.5, value: 10 },
      r: { label: "Raio do furo", min: 2, max: 50, step: 0.5, value: 12 },
      f: { label: "Fillet", min: 0, max: 5, step: 0.1, value: 1.5 },
    },
  },
};
