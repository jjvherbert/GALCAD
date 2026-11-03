// Feature de plugin: o plugin devolve um sólido a partir dos parâmetros avaliados, que entra como ferramenta booleana.
import type { FeatureOf } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { PLUGIN_BUILDERS } from "../../plugins/geometry.ts";
import type { Ctx, StepReport } from "../context.ts";
import { T, explore } from "../occ.ts";
import { nameFresh } from "../naming.ts";
import { applyOp } from "../boolean.ts";

export function pluginFeature(ctx: Ctx, f: FeatureOf<"plugin">, report: StepReport): Ctx {
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
