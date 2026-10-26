// Dados de furação para roscas métricas ISO de passo grosso.
// Rosca e furo de passagem: ISO 261 / ISO 273. Furo de broca para roscar: D − P.
// Rebaixos e escareados: valores típicos para ISO 4762 / ISO 10642 (verificar com o fornecedor).

export interface MetricSize {
  pitch: number;
  tapDrill: number;
  clearance: { close: number; normal: number; loose: number };
  counterbore: { d: number; depth: number };
  countersink?: { d: number; angle: number };
}

export const METRIC: Record<string, MetricSize> = {
  M2: { pitch: 0.4, tapDrill: 1.6, clearance: { close: 2.2, normal: 2.4, loose: 2.6 }, counterbore: { d: 4.3, depth: 2.4 }, countersink: { d: 4.4, angle: 90 } },
  "M2.5": { pitch: 0.45, tapDrill: 2.05, clearance: { close: 2.7, normal: 2.9, loose: 3.1 }, counterbore: { d: 5, depth: 2.9 }, countersink: { d: 5.5, angle: 90 } },
  M3: { pitch: 0.5, tapDrill: 2.5, clearance: { close: 3.2, normal: 3.4, loose: 3.6 }, counterbore: { d: 6.5, depth: 3.3 }, countersink: { d: 6.72, angle: 90 } },
  M4: { pitch: 0.7, tapDrill: 3.3, clearance: { close: 4.3, normal: 4.5, loose: 4.8 }, counterbore: { d: 8, depth: 4.4 }, countersink: { d: 8.96, angle: 90 } },
  M5: { pitch: 0.8, tapDrill: 4.2, clearance: { close: 5.3, normal: 5.5, loose: 5.8 }, counterbore: { d: 10, depth: 5.4 }, countersink: { d: 11.2, angle: 90 } },
  M6: { pitch: 1, tapDrill: 5, clearance: { close: 6.4, normal: 6.6, loose: 7 }, counterbore: { d: 11, depth: 6.5 }, countersink: { d: 13.44, angle: 90 } },
  M8: { pitch: 1.25, tapDrill: 6.8, clearance: { close: 8.4, normal: 9, loose: 10 }, counterbore: { d: 15, depth: 8.6 }, countersink: { d: 17.92, angle: 90 } },
  M10: { pitch: 1.5, tapDrill: 8.5, clearance: { close: 10.5, normal: 11, loose: 12 }, counterbore: { d: 18, depth: 10.8 }, countersink: { d: 22.4, angle: 90 } },
  M12: { pitch: 1.75, tapDrill: 10.2, clearance: { close: 13, normal: 13.5, loose: 14.5 }, counterbore: { d: 20, depth: 13 }, countersink: { d: 26.88, angle: 90 } },
  M14: { pitch: 2, tapDrill: 12, clearance: { close: 15, normal: 15.5, loose: 16.5 }, counterbore: { d: 24, depth: 15 }, countersink: { d: 30.8, angle: 90 } },
  M16: { pitch: 2, tapDrill: 14, clearance: { close: 17, normal: 17.5, loose: 18.5 }, counterbore: { d: 26, depth: 17.5 }, countersink: { d: 33.6, angle: 90 } },
  M20: { pitch: 2.5, tapDrill: 17.5, clearance: { close: 21, normal: 22, loose: 24 }, counterbore: { d: 33, depth: 21.5 }, countersink: { d: 40.32, angle: 90 } },
  M24: { pitch: 3, tapDrill: 21, clearance: { close: 25, normal: 26, loose: 28 }, counterbore: { d: 40, depth: 25.5 } },
};

export const METRIC_SIZES = Object.keys(METRIC);

export const HOLE_NOTE =
  "Diâmetros de passagem: ISO 273. Brocas para roscar: D − P (ISO 261, passo grosso). " +
  "Rebaixos e escareados: valores típicos (ISO 4762 / ISO 10642), a confirmar com o fornecedor dos parafusos. " +
  "A rosca é cosmética: não é modelada no sólido.";
