// Esboço, geometria de referência (plano, eixo, sistema de coordenadas) e importação.
import { importSTEP } from "replicad";
import type { AxisFeature, CsysFeature, Feature, ImportFeature, PlaneFeature, SketchFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { solveSketch } from "../../sketch/solver.ts";
import { findProfiles } from "../../sketch/profiles.ts";
import { type Ctx, type StepReport, axisOf, edges, planeFrame } from "../context.ts";
import { flipFrame, frameFromEuler, offsetFrame, planesIntersection, rotateFrame } from "../frame.ts";
import { nameFresh } from "../naming.ts";
import { T, explore, v3 } from "../occ.ts";
import { applyOp } from "../boolean.ts";

export function sketch(ctx: Ctx, f: SketchFeature & Feature, report: StepReport): Ctx {
  const frame = planeFrame(ctx, f.plane, report);
  const r = solveSketch(f, ctx.scope);
  const profiles = findProfiles(r.entities);
  ctx.sketches.set(f.id, {
    frame,
    entities: r.entities,
    profiles,
    solve: { ok: r.ok, dof: r.dof, conflicting: r.conflicting, redundant: r.redundant, valueErrors: r.valueErrors, message: r.message },
  });
  const valueErrors = Object.values(r.valueErrors);
  if (valueErrors.length) report.warnings.push(...valueErrors.map((e) => `Cota: ${e}`));
  if (r.redundant.length) report.warnings.push(`${r.redundant.length} restrição(ões) redundante(s)`);
  report.warnings.push(...profiles.errors);
  if (!r.ok) throw new Error(r.message ?? "O esboço não foi resolvido");
  report.info = {
    title: "Esboço",
    rows: [
      ["Estado", r.dof === 0 ? "Totalmente definido" : `Sub-definido (${r.dof} grau(s) de liberdade)`],
      ["Contornos fechados", String(profiles.regions.length)],
    ],
  };
  return ctx;
}

export function plane(ctx: Ctx, f: PlaneFeature & Feature, report: StepReport): Ctx {
  let fr = planeFrame(ctx, f.base, report);
  const angle = evalParam(f.angle, ctx.scope, "Ângulo", 0);
  if (Math.abs(angle) > 1e-12) {
    if (!f.axis) throw new Error("Plano com ângulo: indique o eixo de rotação");
    fr = rotateFrame(fr, axisOf(ctx, f.axis, report), (angle * Math.PI) / 180);
  }
  fr = offsetFrame(fr, evalParam(f.offset, ctx.scope, "Distância", 0));
  if (f.flip) fr = flipFrame(fr);
  ctx.planes.set(f.id, fr);
  return ctx;
}

export function axis(ctx: Ctx, f: AxisFeature & Feature, report: StepReport): Ctx {
  if (f.mode === "twoPlanes") {
    if (!f.planes) throw new Error("Indique os dois planos");
    ctx.axes.set(f.id, planesIntersection(planeFrame(ctx, f.planes[0], report), planeFrame(ctx, f.planes[1], report)));
  } else if (f.mode === "edge") {
    if (!f.edge) throw new Error("Indique a aresta");
    edges(ctx, [f.edge], report); // valida a referência
    ctx.axes.set(f.id, axisOf(ctx, { kind: "edge", ref: f.edge }, report));
  } else {
    if (!f.points) throw new Error("Indique os dois pontos");
    const [a, b] = f.points;
    if (v3.dist(a, b) < 1e-9) throw new Error("Os pontos coincidem");
    ctx.axes.set(f.id, { o: a, d: v3.norm(v3.sub(b, a)) });
  }
  return ctx;
}

export function csys(ctx: Ctx, f: CsysFeature & Feature): Ctx {
  const P = (v: (typeof f.origin)[number], l: string) => evalParam(v, ctx.scope, l);
  const o: [number, number, number] = [P(f.origin[0], "Origem X"), P(f.origin[1], "Origem Y"), P(f.origin[2], "Origem Z")];
  ctx.csys.set(f.id, frameFromEuler(o, P(f.rotation[0], "Rotação X"), P(f.rotation[1], "Rotação Y"), P(f.rotation[2], "Rotação Z")));
  return ctx;
}

export async function importFeature(ctx: Ctx, f: ImportFeature & Feature, report: StepReport): Promise<Ctx> {
  if (!f.data) throw new Error("Ficheiro vazio");
  const shape = await importSTEP(new Blob([f.data]));
  T(shape);
  const solids = explore(shape.wrapped, "solid");
  if (!solids.length) throw new Error(`"${f.fileName}" não contém sólidos`);
  // faces importadas: nomes pela ordem do ficheiro (estáveis enquanto o ficheiro não mudar)
  let k = 0;
  const tool = nameFresh(shape.wrapped, f.id, () => `${f.id}:imp${k++}`);
  report.info = { title: "Importação", rows: [["Ficheiro", f.fileName], ["Sólidos", String(solids.length)], ["Faces", String(tool.faces.length)]] };
  ctx.tools.set(f.id, { body: tool, op: f.op });
  return { ...ctx, body: applyOp(ctx, tool, f.op, f.id) };
}
