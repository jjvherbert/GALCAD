// Padrões linear e circular e espelho: repetem os sólidos-ferramenta de features (ou o corpo inteiro).
import type { CircularPatternFeature, Feature, LinearPatternFeature, MirrorFeature, Vec3 } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { TOOL_FEATURES } from "../../doc/features.ts";
import { type Ctx, type StepReport, axisOf, featureName, planeFrame } from "../context.ts";
import type { Axis, Frame } from "../frame.ts";
import { type NamedBody, nameResult } from "../naming.ts";
import { T, gpAx1, gpAx2, gpVec, makeCompound, oc, v3, type Any } from "../occ.ts";
import { applyOp } from "../boolean.ts";

type Trsf = Any;

function translation(v: Vec3): Trsf {
  const t = T(new (oc().gp_Trsf)());
  t.SetTranslation(gpVec(v));
  return t;
}
function rotation(a: Axis, rad: number): Trsf {
  const t = T(new (oc().gp_Trsf)());
  t.SetRotation(gpAx1(a.o, a.d), rad);
  return t;
}
function mirror(p: Frame): Trsf {
  const t = T(new (oc().gp_Trsf)());
  t.SetMirror(gpAx2(p.o, p.z, p.x));
  return t;
}

/** Cópia transformada de um corpo, com os nomes prefixados pela instância. */
export function transformed(body: NamedBody, trsf: Trsf, prefix: string, fid: string): NamedBody {
  const mk = T(new (oc().BRepBuilderAPI_Transform)(body.shape, trsf, true, false));
  const shape = T(mk.Shape());
  return nameResult(mk, body.faces.map((f) => ({ face: f.face, name: `${prefix}${f.name}` })), shape, fid);
}

/** Aplica as instâncias (transformações) às features de origem, ou ao corpo inteiro. */
function applyInstances(ctx: Ctx, fid: string, sources: string[], trsfs: Trsf[]): Ctx {
  if (!trsfs.length) throw new Error("O padrão não tem instâncias");
  const instances = (b: NamedBody) => trsfs.map((t, k) => transformed(b, t, `${fid}:i${k + 1}:`, fid));
  const compound = (bs: NamedBody[]): NamedBody => ({ shape: makeCompound(bs.map((b) => b.shape)), faces: bs.flatMap((b) => b.faces) });

  if (!sources.length) {
    if (!ctx.body) throw new Error("Não há corpo para repetir");
    const tool = compound(instances(ctx.body));
    ctx.tools.set(fid, { body: tool, op: "add" });
    return { ...ctx, body: applyOp(ctx, tool, "add", fid) };
  }
  let cur = ctx;
  const made: NamedBody[] = [];
  for (const src of sources) {
    const t = ctx.tools.get(src);
    if (!t) {
      const f = ctx.doc.features.find((x) => x.id === src);
      throw new Error(f && !TOOL_FEATURES.has(f.type) ? `"${f.name}" não pode ser repetida (só extrusões, revoluções, varrimentos, lofts, furos e nervuras)` : `"${featureName(ctx, src)}" indisponível (suprimida ou com erro?)`);
    }
    const tool = compound(instances(t.body));
    made.push(tool);
    cur = { ...cur, body: applyOp(cur, tool, t.op, fid) };
  }
  // um padrão de uma só feature pode, por sua vez, ser repetido
  const ops = new Set(sources.map((s) => ctx.tools.get(s)!.op));
  if (ops.size === 1) ctx.tools.set(fid, { body: compound(made), op: [...ops][0] });
  return cur;
}

export function linearPattern(ctx: Ctx, f: LinearPatternFeature & Feature, report: StepReport): Ctx {
  const dir = (a: typeof f.direction, flip?: boolean) => { const d = axisOf(ctx, a, report).d; return flip ? v3.mul(d, -1) : d; };
  const n1 = Math.round(evalParam(f.count, ctx.scope, "Instâncias"));
  const s1 = evalParam(f.spacing, ctx.scope, "Espaçamento");
  if (n1 < 1) throw new Error("Instâncias: pelo menos 1");
  const d1 = dir(f.direction, f.flip);
  let n2 = 1, s2 = 0, d2: Vec3 = [0, 0, 0];
  if (f.direction2) {
    n2 = Math.round(evalParam(f.count2, ctx.scope, "Instâncias (direção 2)", 1));
    s2 = evalParam(f.spacing2, ctx.scope, "Espaçamento (direção 2)", 0);
    d2 = dir(f.direction2, f.flip2);
    if (Math.abs(v3.dot(d1, d2)) > 1 - 1e-9) throw new Error("As duas direções são paralelas");
  }
  const trsfs: Trsf[] = [];
  for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
    if (i === 0 && j === 0) continue;
    trsfs.push(translation(v3.add(v3.mul(d1, i * s1), v3.mul(d2, j * s2))));
  }
  return applyInstances(ctx, f.id, f.features, trsfs);
}

export function circularPattern(ctx: Ctx, f: CircularPatternFeature & Feature, report: StepReport): Ctx {
  const axis = axisOf(ctx, f.axis, report);
  const n = Math.round(evalParam(f.count, ctx.scope, "Instâncias"));
  const total = evalParam(f.angle, ctx.scope, "Ângulo total", 360);
  if (n < 2) throw new Error("Instâncias: pelo menos 2");
  // volta completa: n passos iguais; ângulo parcial: primeira e última nas extremidades
  const step = Math.abs(Math.abs(total) - 360) < 1e-9 ? total / n : total / (n - 1);
  const trsfs = Array.from({ length: n - 1 }, (_, k) => rotation(axis, ((k + 1) * step * Math.PI) / 180));
  return applyInstances(ctx, f.id, f.features, trsfs);
}

export function mirrorFeature(ctx: Ctx, f: MirrorFeature & Feature, report: StepReport): Ctx {
  const p = planeFrame(ctx, f.plane, report);
  return applyInstances(ctx, f.id, f.features, [mirror(p)]);
}
