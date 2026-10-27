// Conversões dos resultados do núcleo e do agente para os objetos simples que os scripts recebem.
// Puro (só tipos e aritmética): usado pelo anfitrião do browser e pelo de Node.
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { RunResult } from "../../tools/cad-runner.ts";
import type { ScriptRebuild, ScriptSimulation } from "./api.ts";

export function rebuildSummary(r: RebuildResponse | null, density: number): ScriptRebuild {
  if (!r) return { ok: false, errors: [{ feature: "", message: "Reconstrução cancelada" }], measures: {}, variables: {}, checks: [], pmi: [] };
  const errors = Object.entries(r.status).filter(([, s]) => s.state === "error").map(([feature, s]) => ({ feature, message: s.error ?? "erro" }));
  const m = r.mass;
  const measures: Record<string, number> = m ? {
    volume: m.volume, area: m.area, massa: (m.volume / 1000) * density,
    dimX: m.bbox.max[0] - m.bbox.min[0], dimY: m.bbox.max[1] - m.bbox.min[1], dimZ: m.bbox.max[2] - m.bbox.min[2],
    cgX: m.center[0], cgY: m.center[1], cgZ: m.center[2],
  } : {};
  return {
    ok: errors.length === 0 && Object.keys(r.variables.errors).length === 0,
    errors: [...errors, ...Object.entries(r.variables.errors).map(([feature, message]) => ({ feature: `variável ${feature}`, message }))],
    measures, variables: { ...r.variables.values },
    checks: (r.checks ?? []).map((c) => ({ name: c.name, ok: c.ok, message: c.message })),
    pmi: (r.pmi ?? []).map((p) => ({ id: p.id, text: p.text, errors: p.errors })),
  };
}

export function simulationSummary(r: RunResult): ScriptSimulation {
  return {
    solver: r.solver,
    metrics: Object.fromEntries(r.metrics.map((x) => [x.key, x.value])),
    summary: r.summary, warnings: r.warnings, cells: r.cells, seconds: r.seconds,
    convergence: r.convergence?.rows.map((x) => ({ key: x.key, values: x.values, extrapolated: x.gci.extrapolated, gci: x.gci.gciFine, behaviour: x.gci.behaviour })),
  };
}

/** Polar do XFOIL (resultado do agente) resumida para scripts. */
export function polarForScript(r: import("../sim/xfoil.ts").XfoilResult): import("./api.ts").ScriptPolar {
  const { clAlphaDeg, alpha0, clMax, alphaClMax, cdMin, ldMax, missing } = r.summary;
  return { airfoil: r.airfoil, re: r.re, polar: r.polar.map(({ alpha, cl, cd, cm }) => ({ alpha, cl, cd, cm })), summary: { clAlphaDeg, alpha0, clMax, alphaClMax, cdMin, ldMax, missing }, warnings: r.warnings };
}
