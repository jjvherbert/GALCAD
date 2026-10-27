// Estudo de convergência da malha: extrapolação de Richardson e índice de convergência da malha (GCI)
// pelo procedimento de Celik et al., "Procedure for Estimation and Reporting of Uncertainty Due to
// Discretization in CFD Applications", J. Fluids Eng. 130 (2008) 078001 — o mesmo do ASME V&V 20.
// Puro: três malhas (1 = fina … 3 = grossa), com o tamanho representativo h = (V/N)^(1/dim).

export interface GciResult {
  /** Razões de refinamento h2/h1 e h3/h2. */
  r21: number;
  r32: number;
  /** Ordem aparente. */
  p: number;
  /** Valor extrapolado (Richardson) a partir das duas malhas mais finas. */
  extrapolated: number;
  /** Erro relativo aproximado e extrapolado da malha fina; GCI da malha fina (fração, não %). */
  ea21: number;
  eext21: number;
  gciFine: number;
  /** Verificação da gama assintótica: GCI32 / (r21^p · GCI21) ≈ 1. */
  asymptotic: number;
  /** monotónica (0 < R < 1), oscilatória (R < 0), divergente (R > 1) ou já convergida (ε21 = 0). */
  behaviour: "monotonic" | "oscillatory" | "divergent" | "converged";
  notes: string[];
}

/**
 * GCI de três soluções `f` (fina → grossa) com números de células/elementos `n` (fina → grossa).
 * `Fs` = 1,25 (fator de segurança recomendado para três malhas).
 */
export function gci(n: [number, number, number], f: [number, number, number], dim = 3, Fs = 1.25): GciResult {
  const h = n.map((x) => (1 / x) ** (1 / dim));
  const r21 = h[1] / h[0], r32 = h[2] / h[1];
  const [f1, f2, f3] = f;
  const e21 = f2 - f1, e32 = f3 - f2;
  const notes: string[] = [];
  if (r21 < 1.3 || r32 < 1.3) notes.push(`Razões de refinamento ${r21.toFixed(2)} / ${r32.toFixed(2)} abaixo de 1,3 (recomendado ≥ 1,3)`);
  if (e21 === 0 || Math.abs(e21) <= 1e-12 * Math.max(Math.abs(f1), 1e-300)) {
    return { r21, r32, p: NaN, extrapolated: f1, ea21: 0, eext21: 0, gciFine: 0, asymptotic: NaN, behaviour: "converged", notes: [...notes, "As duas malhas mais finas dão o mesmo valor"] };
  }
  const R = e21 / e32;
  const behaviour = !Number.isFinite(R) ? "divergent" : R < 0 ? "oscillatory" : R > 1 ? "divergent" : "monotonic";
  const s = Math.sign(e32 / e21);
  // ordem aparente: ponto fixo p = |ln|ε32/ε21| + q(p)| / ln r21, q(p) = ln((r21^p − s)/(r32^p − s))
  let p = Math.abs(Math.log(Math.abs(e32 / e21))) / Math.log(r21);
  for (let it = 0; it < 200; it++) {
    const q = Math.log((r21 ** p - s) / (r32 ** p - s));
    const next = Math.abs(Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21);
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - p) < 1e-12) { p = next; break; }
    p = next;
  }
  const rp = r21 ** p;
  const extrapolated = (rp * f1 - f2) / (rp - 1);
  const ea21 = Math.abs((f1 - f2) / f1);
  const eext21 = Math.abs((extrapolated - f1) / extrapolated);
  const gciFine = (Fs * ea21) / (rp - 1);
  const gci32 = (Fs * Math.abs((f2 - f3) / f2)) / (r32 ** p - 1);
  const asymptotic = gci32 / (rp * gciFine);
  if (behaviour === "oscillatory") notes.push("Convergência oscilatória: o GCI é apenas indicativo");
  if (behaviour === "divergent") notes.push("As soluções afastam-se ao refinar: a malha não está na gama assintótica (singularidade, malha demasiado grossa ou erro de modelação)");
  if (behaviour === "monotonic" && Math.abs(asymptotic - 1) > 0.1) notes.push(`Fora da gama assintótica (razão ${asymptotic.toFixed(2)}; esperado ≈ 1)`);
  if (p > 6 || p < 0.5) notes.push(`Ordem aparente ${p.toFixed(2)} pouco plausível para o método (esperado ≈ 1–2 em CFD, 2–3 em tetraedros quadráticos)`);
  return { r21, r32, p, extrapolated, ea21, eext21, gciFine, asymptotic, behaviour, notes };
}

/** Métrica escalar de um cálculo (para a convergência e para comparar estudos). */
export interface Metric { key: string; label: string; unit: string; value: number }

export interface ConvergenceReport {
  /** Razão pedida entre tamanhos de malha consecutivos. */
  ratio: number;
  /** Malhas (fina → grossa): número de células/elementos e tamanho máximo pedido (mm). */
  meshes: { cells: number; size: number }[];
  rows: { key: string; label: string; unit: string; values: [number, number, number]; gci: GciResult }[];
  hypotheses: string[];
  /** Refinamento automático: alvo, grandeza seguida, se foi atingido, porquê parou e cada nível. */
  auto?: { target: number; metric: string; achieved: boolean; stop: string; steps: { level: number; size: number; cells: number; value: number; gci?: number; behaviour?: GciResult["behaviour"] }[] };
}

/** Junta as métricas das três malhas (fina → grossa) num relatório de convergência. */
export function convergenceReport(ratio: number, meshes: { cells: number; size: number; metrics: Metric[] }[]): ConvergenceReport {
  const [a, b, c] = meshes;
  const rows: ConvergenceReport["rows"] = [];
  for (const m of a.metrics) {
    const v2 = b.metrics.find((x) => x.key === m.key)?.value, v3 = c.metrics.find((x) => x.key === m.key)?.value;
    if (v2 === undefined || v3 === undefined || ![m.value, v2, v3].every(Number.isFinite)) continue;
    rows.push({ key: m.key, label: m.label, unit: m.unit, values: [m.value, v2, v3], gci: gci([a.cells, b.cells, c.cells], [m.value, v2, v3]) });
  }
  return {
    ratio,
    meshes: meshes.map((m) => ({ cells: m.cells, size: m.size })),
    rows,
    hypotheses: [
      "Incerteza numérica da discretização pelo GCI (Celik et al., J. Fluids Eng. 130, 2008; ASME V&V 20-2009), Fs = 1,25, três malhas refinadas de forma sistemática",
      "h = (1/N)^(1/3) com N células/elementos (domínio igual nas três malhas)",
      "Não inclui erros de modelação (condições de fronteira, material, turbulência) nem de convergência iterativa",
      "Máximos locais junto a singularidades geométricas (cantos vivos, cargas pontuais) não convergem: use valores afastados das singularidades",
    ],
  };
}
