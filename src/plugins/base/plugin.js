// Plugin base: peças e superfícies genéricas. Só metadados (UI); a geometria está em geometry.js.
export default {
  id: "base",
  name: "Peças e superfícies",
  models: {
    placa: {
      label: "Peça: placa com furo",
      units: "mm",
      params: {
        w: { label: "Largura", min: 20, max: 300, step: 1, value: 100 },
        h: { label: "Altura", min: 20, max: 300, step: 1, value: 60 },
        t: { label: "Espessura", min: 2, max: 50, step: 0.5, value: 10 },
        r: { label: "Raio do furo passante", min: 2, max: 50, step: 0.5, value: 12 },
        f: { label: "Fillet das arestas superiores", min: 0, max: 5, step: 0.1, value: 1.5 },
      },
    },
    caixa: {
      label: "Peça: caixa em casca (shell)",
      units: "mm",
      params: {
        w: { label: "Largura", min: 20, max: 300, step: 1, value: 120 },
        d: { label: "Profundidade", min: 20, max: 300, step: 1, value: 80 },
        h: { label: "Altura", min: 10, max: 200, step: 1, value: 50 },
        r: { label: "Fillet vertical", min: 0, max: 30, step: 0.5, value: 10 },
        e: { label: "Espessura de parede", min: 0.5, max: 10, step: 0.1, value: 2 },
      },
    },
    superficie: {
      label: "Superfície: loft aberto por 3 curvas",
      units: "mm",
      params: {
        L: { label: "Comprimento", min: 50, max: 500, step: 1, value: 200 },
        W: { label: "Largura", min: 20, max: 300, step: 1, value: 120 },
        h0: { label: "Flecha da curva inicial", min: -60, max: 60, step: 1, value: 10 },
        h1: { label: "Flecha da curva central", min: -60, max: 60, step: 1, value: 40 },
        h2: { label: "Flecha da curva final", min: -60, max: 60, step: 1, value: 0 },
      },
    },
  },
};
