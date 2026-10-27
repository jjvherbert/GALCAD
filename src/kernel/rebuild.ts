// Motor de reconstrução: aplica as features por ordem, com cache incremental.
// Editar a feature k só reconstrói de k em diante; as anteriores vêm da cache.
import type { CadDocument, Feature } from "../doc/types.ts";
import { type RuleStatus, resolveWithRules } from "../doc/knowledge.ts";
import { PLUGIN_BUILDERS } from "../plugins/geometry.ts";
import type { BuildEnv, Ctx, StepReport } from "./context.ts";
import { Arena, T, explore, setArena } from "./occ.ts";
import { nameFresh } from "./naming.ts";
import { applyOp } from "./boolean.ts";
import { extrude, loft, revolve, rib, sweep } from "./features/solid.ts";
import { chamfer, draft, fillet, shell } from "./features/dress.ts";
import { hole } from "./features/hole.ts";
import { circularPattern, linearPattern, mirrorFeature } from "./features/pattern.ts";
import { axis, csys, importFeature, plane, sketch } from "./features/datum.ts";
import { boundary, deleteFace, fill, knit, offsetSurface, replaceFace, ruled, surfaceExtrude, surfaceLoft, surfaceRevolve, surfaceSweep, thicken, trimSurface, untrim } from "./features/surface.ts";
import { curve } from "./features/curve.ts";
import { blend, circleSweep, extrapolate, heal, multiSection } from "./features/gsd.ts";
import { freeform } from "./features/freeform.ts";
import { external } from "./features/external.ts";
import { evalParam } from "../doc/variables.ts";

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

async function runStep(ctx: Ctx, f: Feature, report: StepReport): Promise<Ctx> {
  switch (f.type) {
    case "sketch": return sketch(ctx, f, report);
    case "extrude": return extrude(ctx, f, report);
    case "revolve": return revolve(ctx, f, report);
    case "sweep": return sweep(ctx, f, report);
    case "loft": return loft(ctx, f, report);
    case "rib": return rib(ctx, f, report);
    case "hole": return hole(ctx, f, report);
    case "fillet": return fillet(ctx, f, report);
    case "chamfer": return chamfer(ctx, f, report);
    case "shell": return shell(ctx, f, report);
    case "draft": return draft(ctx, f, report);
    case "linearPattern": return linearPattern(ctx, f, report);
    case "circularPattern": return circularPattern(ctx, f, report);
    case "mirror": return mirrorFeature(ctx, f, report);
    case "plane": return plane(ctx, f, report);
    case "axis": return axis(ctx, f, report);
    case "csys": return csys(ctx, f);
    case "import": return importFeature(ctx, f, report);
    case "surfaceExtrude": return surfaceExtrude(ctx, f, report);
    case "surfaceRevolve": return surfaceRevolve(ctx, f, report);
    case "surfaceSweep": return surfaceSweep(ctx, f, report);
    case "surfaceLoft": return surfaceLoft(ctx, f, report);
    case "fill": return fill(ctx, f, report);
    case "offsetSurface": return offsetSurface(ctx, f, report);
    case "knit": return knit(ctx, f, report);
    case "thicken": return thicken(ctx, f, report);
    case "trimSurface": return trimSurface(ctx, f, report);
    case "deleteFace": return deleteFace(ctx, f, report);
    case "curve": return curve(ctx, f, report);
    case "boundary": return boundary(ctx, f, report);
    case "ruled": return ruled(ctx, f, report);
    case "untrim": return untrim(ctx, f, report);
    case "replaceFace": return replaceFace(ctx, f, report);
    case "multiSection": return multiSection(ctx, f, report);
    case "blend": return blend(ctx, f, report);
    case "circleSweep": return circleSweep(ctx, f, report);
    case "extrapolate": return extrapolate(ctx, f, report);
    case "heal": return heal(ctx, f, report);
    case "freeform": return freeform(ctx, f, report);
    case "external": return external(ctx, f, report);
    case "plugin": {
      const b = PLUGIN_BUILDERS[f.plugin]?.[f.kind];
      if (!b) throw new Error(`Plugin desconhecido: ${f.plugin}/${f.kind}`);
      const params = Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, evalParam(v, ctx.scope, k)]));
      const res = b(params);
      T(res.shape);
      if (!explore(res.shape.wrapped, "solid").length) throw new Error("O plugin não gerou um sólido");
      const tool = nameFresh(res.shape.wrapped, f.id);
      report.info = res.info;
      ctx.tools.set(f.id, { body: tool, op: f.op });
      return { ...ctx, body: applyOp(ctx, tool, f.op, f.id) };
    }
  }
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
    let key = JSON.stringify([...vars.values]);
    let ctx: Ctx = { doc, scope: vars.scope, body: null, sketches: new Map(), planes: new Map(), axes: new Map(), csys: new Map(), tools: new Map(), sheets: new Map(), curves: new Map(), env };
    const status: Record<string, FeatureStatus> = {};
    const limit = doc.rollback ?? doc.features.length;
    let reused = 0;
    let i = 0;

    for (; i < doc.features.length; i++) {
      const f = doc.features[i];
      if (i >= limit) { status[f.id] = { state: "rolledBack", warnings: [] }; continue; }
      // referência externa ligada: a chave inclui a revisão da peça de origem
      key = `${key}|${JSON.stringify(f)}${f.type === "external" && env ? `@${env.revision(f.part)}` : ""}`;
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
          ctx = await runStep(next, f, report);
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
