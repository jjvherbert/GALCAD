// Publicações e referências externas (Fase 4.5). Uma peça publica geometria com nomes estáveis;
// outra peça copia uma publicação (ligada: acompanha a origem; congelada: fica a cópia guardada),
// na origem comum ou com a posição lida de uma montagem.
import type { ExternalFeature, Feature, Publication, Vec3 } from "../../doc/types.ts";
import { type Ctx, type ExternalGeom, type StepReport, edges as resolveEdges, faces as resolveFaces, featureName } from "../context.ts";
import type { Frame } from "../frame.ts";
import { nameFresh } from "../naming.ts";
import { T, type TopoDS_Shape, explore, getArena, makeCompound, oc, setArena, v3 } from "../occ.ts";
import { chainWire } from "../sketch3d.ts";
import { applyOp } from "../boolean.ts";
import { namedCurve } from "./curve.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Promise<Ctx>;

/** Geometria de uma publicação, resolvida no contexto (reconstruído) da peça que a publica. */
export function publish(ctx: Ctx, pub: Publication): ExternalGeom {
  const r = pub.ref;
  const report: StepReport = { warnings: [] };
  if (r.kind === "body") {
    if (!ctx.body) throw new Error(`"${pub.name}": a peça não tem corpo sólido`);
    return { kind: "shape", shape: ctx.body.shape, as: "solid" };
  }
  if (r.kind === "face") {
    const [nf] = resolveFaces(ctx, [r], report);
    if (!nf) throw new Error(`"${pub.name}": face inexistente`);
    return { kind: "shape", shape: nf.face, as: "sheet" };
  }
  if (r.kind === "edge") {
    const [ne] = resolveEdges(ctx, [r], report);
    if (!ne) throw new Error(`"${pub.name}": aresta inexistente`);
    return { kind: "shape", shape: ne.edge, as: "curve" };
  }
  const id = (r as { kind: "feature"; feature: string }).feature;
  const plane = ctx.planes.get(id) ?? ctx.csys.get(id);
  if (plane) return { kind: "plane", frame: plane };
  const axis = ctx.axes.get(id);
  if (axis) return { kind: "axis", axis };
  const sheet = ctx.sheets.get(id);
  if (sheet) return { kind: "shape", shape: sheet.shape, as: "sheet" };
  const curve = ctx.curves.get(id);
  if (curve) return { kind: "shape", shape: curve.shape, as: "curve" };
  const sk = ctx.sketches.get(id);
  if (sk) {
    if (!sk.profiles.chains.length) throw new Error(`"${pub.name}": o esboço está vazio`);
    return { kind: "shape", shape: makeCompound(sk.profiles.chains.map((c) => chainWire(c, sk.frame).wrapped)), as: "curve" };
  }
  throw new Error(`"${pub.name}": a feature "${featureName(ctx, id)}" não está disponível (suprimida ou com erro?)`);
}

/** Matriz 4×4 (coluna maior) aplicada a um ponto e a uma direção. */
const mp = (m: number[], p: Vec3): Vec3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const md = (m: number[], d: Vec3): Vec3 => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];

/** Cópia independente da forma (no arena atual), com a transformação opcional. */
function copyShape(s: TopoDS_Shape, m?: number[]): TopoDS_Shape {
  const o = oc();
  const t = T(new o.gp_Trsf());
  if (m) t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
  return T(T(new o.BRepBuilderAPI_Transform(s, t, true, false)).Shape());
}

export const external: Step<ExternalFeature & Feature> = async (ctx, f, report) => {
  const m = f.placement?.m;
  let g: ExternalGeom;
  if (f.mode === "frozen") {
    const z = f.frozen;
    if (!z) throw new Error("Referência congelada sem cópia guardada (volte a ligar e congele de novo)");
    if (ctx.env && ctx.env.revision(f.part) !== z.revision) report.warnings.push(`A peça "${ctx.env.partName(f.part)}" mudou desde que esta referência foi congelada`);
    if (z.frame) g = { kind: "plane", frame: z.frame };
    else if (z.axis) g = { kind: "axis", axis: z.axis };
    else if (z.brep) {
      const shape = T(oc().BRepToolsWrapper.Read(z.brep));
      const as = explore(shape, "solid").length ? "solid" : explore(shape, "face").length ? "sheet" : "curve";
      g = { kind: "shape", shape, as };
    } else throw new Error("Cópia congelada vazia");
  } else {
    if (!ctx.env) throw new Error("Referência externa: abra a peça dentro do projeto");
    // a origem é reconstruída por outro motor, que muda a arena atual: repô-la a seguir
    const arena = getArena();
    try { g = await ctx.env.external(f.part, f.publication); } finally { setArena(arena); }
  }
  switch (g.kind) {
    case "plane": {
      const fr = g.frame;
      ctx.planes.set(f.id, m ? { o: mp(m, fr.o), x: v3.norm(md(m, fr.x)), y: v3.norm(md(m, fr.y)), z: v3.norm(md(m, fr.z)) } as Frame : fr);
      break;
    }
    case "axis":
      ctx.axes.set(f.id, m ? { o: mp(m, g.axis.o), d: v3.norm(md(m, g.axis.d)) } : g.axis);
      break;
    case "shape": {
      const shape = copyShape(g.shape, m);
      if (g.as === "curve") ctx.curves.set(f.id, namedCurve(explore(shape, "edge"), f.id));
      else if (g.as === "sheet") ctx.sheets.set(f.id, nameFresh(shape, f.id, () => `${f.id}:x`));
      else {
        const tool = nameFresh(shape, f.id, () => undefined);
        const op = f.op ?? "new";
        ctx.tools.set(f.id, { body: tool, op });
        return { ...ctx, body: applyOp(ctx, tool, op, f.id) };
      }
    }
  }
  return ctx;
};

/** Geometria serializada para congelar uma referência (BRep em texto, plano ou eixo). */
export function freezeGeom(g: ExternalGeom): { brep?: string; frame?: Frame; axis?: { o: Vec3; d: Vec3 } } {
  if (g.kind === "plane") return { frame: g.frame };
  if (g.kind === "axis") return { axis: g.axis };
  return { brep: oc().BRepToolsWrapper.Write(g.shape) as string };
}
