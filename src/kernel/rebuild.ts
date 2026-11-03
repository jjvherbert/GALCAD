// Motor de reconstrução: aplica as features por ordem, com cache incremental.
// Editar a feature k só reconstrói de k em diante; as anteriores vêm da cache.
import type { CadDocument } from "../doc/types.ts";
import { type RuleStatus, resolveWithRules } from "../doc/knowledge.ts";
import type { BuildEnv, Ctx, StepReport } from "./context.ts";
import { Arena, setArena } from "./occ.ts";
import { buildFeature } from "./registry.ts";
import { chainKey, seedKey } from "./cache-key.ts";

export interface FeatureStatus {
  state: "ok" | "warning" | "error" | "suppressed" | "rolledBack";
  error?: string;
  warnings: string[];
  info?: StepReport["info"];
  net?: StepReport["net"];
  ms?: number;
}

export interface RebuildResult {
  ctx: Ctx;
  status: Record<string, FeatureStatus>;
  variables: { values: Record<string, number>; errors: Record<string, string> };
  rules: RuleStatus[];
  ms: number;
  reused: number;
}

interface CacheEntry {
  key: string;
  ctx: Ctx;
  status: FeatureStatus;
  arena: Arena;
}

const copyCtx = (c: Ctx, doc: CadDocument): Ctx => ({
  ...c,
  doc,
  sketches: new Map(c.sketches),
  planes: new Map(c.planes),
  axes: new Map(c.axes),
  csys: new Map(c.csys),
  tools: new Map(c.tools),
  sheets: new Map(c.sheets),
  curves: new Map(c.curves),
});

export class Engine {
  private cache: CacheEntry[] = [];
  /** Objetos auxiliares fora das features (malhas, exportação), libertados na reconstrução seguinte. */
  private scratch = new Arena();

  async rebuild(doc: CadDocument, env?: BuildEnv): Promise<RebuildResult> {
    const t0 = performance.now();
    this.scratch.free();
    const vars = resolveWithRules(doc.variables, doc.rules);
    let key = seedKey(vars.values);
    let ctx: Ctx = { doc, scope: vars.scope, body: null, sketches: new Map(), planes: new Map(), axes: new Map(), csys: new Map(), tools: new Map(), sheets: new Map(), curves: new Map(), env };
    const status: Record<string, FeatureStatus> = {};
    const limit = doc.rollback ?? doc.features.length;
    let reused = 0;
    let i = 0;

    for (; i < doc.features.length; i++) {
      const f = doc.features[i];
      if (i >= limit) { status[f.id] = { state: "rolledBack", warnings: [] }; continue; }
      // referência externa ligada: a chave inclui a revisão da peça de origem
      key = chainKey(key, f, f.type === "external" && env ? env.revision(f.part) : undefined);
      const hit = this.cache[i];
      if (hit && hit.key === key) {
        ctx = { ...hit.ctx, doc, scope: vars.scope, env };
        status[f.id] = hit.status;
        reused++;
        continue;
      }
      // cache inválida daqui em diante
      for (const e of this.cache.splice(i)) e.arena.free();
      const arena = new Arena();
      setArena(arena);
      const report: StepReport = { warnings: [] };
      const ts = performance.now();
      let st: FeatureStatus;
      if (f.suppressed) {
        st = { state: "suppressed", warnings: [] };
      } else {
        const next = copyCtx(ctx, doc);
        try {
          ctx = await buildFeature(next, f, report);
          st = { state: report.warnings.length ? "warning" : "ok", warnings: report.warnings, info: report.info, net: report.net };
        } catch (e) {
          // a feature falhada é ignorada; as seguintes continuam (como no SolidWorks)
          ctx = { ...next, body: next.body };
          st = { state: "error", error: (e as Error).message, warnings: report.warnings, info: report.info };
        }
      }
      st.ms = Math.round(performance.now() - ts);
      status[f.id] = st;
      this.cache[i] = { key, ctx, status: st, arena };
    }
    // features removidas do fim do documento
    for (const e of this.cache.splice(Math.min(i, limit))) e.arena.free();
    setArena(this.scratch);

    return {
      ctx,
      status,
      variables: { values: Object.fromEntries(vars.values), errors: Object.fromEntries(vars.errors) },
      rules: vars.rules,
      ms: Math.round(performance.now() - t0),
      reused,
    };
  }

  clear() {
    this.scratch.free();
    for (const e of this.cache) e.arena.free();
    this.cache = [];
  }
}
