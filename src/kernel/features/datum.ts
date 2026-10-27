// Esboço, geometria de referência (plano, eixo, sistema de coordenadas) e importação.
import { importSTEP } from "replicad";
import type { AxisFeature, CsysFeature, Feature, ImportFeature, PlaneFeature, SketchFeature, TopoRef } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { solveSketch } from "../../sketch/solver.ts";
import { findProfiles } from "../../sketch/profiles.ts";
import { type SketchRegion, computeRegions } from "../regions.ts";
import { type Ctx, type StepReport, axisOf, edges, planeFrame } from "../context.ts";
import { type Frame, flipFrame, frameFromEuler, offsetFrame, planesIntersection, rotateFrame, to2D } from "../frame.ts";
import { nameFresh } from "../naming.ts";
import { T, edgeProps, explore, v3 } from "../occ.ts";
import { applyOp } from "../boolean.ts";

/** Atualiza as entidades convertidas de arestas do modelo, projetando cada aresta no plano do esboço. */
function projectExternal<F extends SketchFeature>(ctx: Ctx, f: F, frame: Frame, report: StepReport): F {
  const linked = Object.entries(f.entities).filter(([, e]) => "ext" in e && e.ext);
  if (!linked.length) return f;
  const entities = { ...f.entities };
  const setPt = (id: string, p: [number, number]) => { const e = entities[id]; if (e?.type === "point") entities[id] = { ...e, x: p[0], y: p[1], fixed: true }; };
  for (const [id, e] of linked) {
    const ref = (e as { ext: TopoRef }).ext;
    let edge;
    try {
      [edge] = edges(ctx, [ref], report);
    } catch {
      report.warnings.push(`Entidade convertida ${id}: a aresta de origem já não existe (mantém a última posição)`);
      continue;
    }
    if (!edge) continue;
    const p = edgeProps(edge.edge);
    if (e.type === "line") {
      const a = to2D(frame, p.start), b = to2D(frame, p.end);
      // manter a correspondência dos extremos com a posição anterior
      const p1 = entities[e.p1] as { x: number; y: number };
      const swap = p1 && Math.hypot(p1.x - b[0], p1.y - b[1]) < Math.hypot(p1.x - a[0], p1.y - a[1]);
      setPt(e.p1, swap ? b : a);
      setPt(e.p2, swap ? a : b);
    } else if ((e.type === "circle" || e.type === "arc") && p.type === "circle" && p.center && p.dir && p.radius) {
      if (Math.abs(Math.abs(v3.dot(p.dir, frame.z)) - 1) > 1e-6) { report.warnings.push(`Entidade convertida ${id}: o círculo não é paralelo ao plano do esboço`); continue; }
      const c = to2D(frame, p.center);
      setPt(e.c, c);
      if (e.type === "circle") entities[id] = { ...e, r: p.radius };
      else {
        const ccw = v3.dot(p.dir, frame.z) > 0;
        const [from, to] = ccw ? [to2D(frame, p.start), to2D(frame, p.end)] : [to2D(frame, p.end), to2D(frame, p.start)];
        setPt(e.s, from);
        setPt(e.e, to);
        entities[id] = { ...e, r: p.radius, a0: Math.atan2(from[1] - c[1], from[0] - c[0]), a1: Math.atan2(to[1] - c[1], to[0] - c[0]) };
      }
    } else {
      report.warnings.push(`Entidade convertida ${id}: tipo de aresta não suportado (${p.type})`);
    }
  }
  return { ...f, entities };
}

export function sketch(ctx: Ctx, f0: SketchFeature & Feature, report: StepReport): Ctx {
  const frame = planeFrame(ctx, f0.plane, report);
  const f = ctx.body ? projectExternal(ctx, f0, frame, report) : f0;
  const r = solveSketch(f, ctx.scope);
  const profiles = findProfiles(r.entities);
  let regions: SketchRegion[] = [];
  try { if (r.ok) regions = computeRegions(r.entities, frame); } catch (e) { report.warnings.push((e as Error).message); }
  ctx.sketches.set(f.id, {
    frame,
    entities: r.entities,
    profiles,
    regions,
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
