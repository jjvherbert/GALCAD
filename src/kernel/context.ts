// Estado da reconstrução, passado de feature em feature, e resolução de referências.
import type { AxisRef, CadDocument, BodyOp, PlaneRef, TopoRef, SketchEntity, Vec3 } from "../doc/types.ts";
import type { Scope } from "../doc/expr.ts";
import type { Profiles } from "../sketch/profiles.ts";
import type { SketchRegion } from "./regions.ts";
import type { SolveResult } from "../sketch/solver.ts";
import { type Axis, type Frame, STD_AXES, STD_FRAMES, csysAxis, csysPlane, frameFromPlane, to3D } from "./frame.ts";
import { type NamedBody, type NamedEdge, type NamedFace, namedEdges, resolveEdge, resolveFace } from "./naming.ts";
import { type TopoDS_Face, bbox, edgeProps, explore, faceProps, isSmoothEdge, v3 } from "./occ.ts";

export interface SketchResult {
  frame: Frame;
  entities: Record<string, SketchEntity>;
  profiles: Profiles;
  /** Regiões do esboço (curvas que se cruzam incluídas), calculadas no passo do esboço. */
  regions: SketchRegion[];
  solve: Pick<SolveResult, "ok" | "dof" | "conflicting" | "redundant" | "valueErrors" | "message">;
}

/** Sólido-ferramenta de uma feature (para padrões e espelho). */
export interface Tool {
  body: NamedBody;
  op: BodyOp;
}

export interface Ctx {
  doc: CadDocument;
  scope: Scope;
  body: NamedBody | null;
  sketches: Map<string, SketchResult>;
  planes: Map<string, Frame>;
  axes: Map<string, Axis>;
  csys: Map<string, Frame>;
  tools: Map<string, Tool>;
  /** Corpos de superfície (folhas), pelo id da feature que os criou. */
  sheets: Map<string, NamedBody>;
}

/** Avisos e informação produzidos por uma feature. */
export interface StepReport {
  warnings: string[];
  info?: { title: string; rows: [string, string][]; note?: string };
}

export const featureName = (ctx: Ctx, id: string) => ctx.doc.features.find((f) => f.id === id)?.name ?? id;

export function planeFrame(ctx: Ctx, ref: PlaneRef, report: StepReport): Frame {
  switch (ref.kind) {
    case "std": return STD_FRAMES[ref.name];
    case "datum": {
      const f = ctx.planes.get(ref.feature);
      if (!f) throw new Error(`Plano "${featureName(ctx, ref.feature)}" indisponível`);
      return f;
    }
    case "csys": {
      const f = ctx.csys.get(ref.feature);
      if (!f) throw new Error(`Sistema de coordenadas "${featureName(ctx, ref.feature)}" indisponível`);
      return csysPlane(f, ref.name);
    }
    case "face": {
      const [face] = faces(ctx, [ref.ref], report);
      if (!face) throw new Error("Face de esboço inexistente");
      const p = faceProps(face.face);
      if (p.type !== "plane" || !p.normal || !p.planeOrigin) throw new Error(`A face "${ref.ref.name}" não é plana`);
      return frameFromPlane(p.center, p.normal);
    }
  }
}

export function axisOf(ctx: Ctx, ref: AxisRef, report: StepReport): Axis {
  switch (ref.kind) {
    case "std": return STD_AXES[ref.name];
    case "datum": {
      const a = ctx.axes.get(ref.feature);
      if (!a) throw new Error(`Eixo "${featureName(ctx, ref.feature)}" indisponível`);
      return a;
    }
    case "csys": {
      const f = ctx.csys.get(ref.feature);
      if (!f) throw new Error(`Sistema de coordenadas "${featureName(ctx, ref.feature)}" indisponível`);
      return csysAxis(f, ref.name);
    }
    case "edge": {
      const [e] = edges(ctx, [ref.ref], report);
      if (!e) throw new Error("Aresta de eixo inexistente");
      const p = edgeProps(e.edge);
      if (p.type === "line" && p.dir) return { o: p.start, d: p.dir };
      if (p.type === "circle" && p.center && p.dir) return { o: p.center, d: p.dir };
      throw new Error("A aresta do eixo tem de ser reta ou circular");
    }
    case "sketchLine": {
      const s = ctx.sketches.get(ref.sketch);
      if (!s) throw new Error(`Esboço "${featureName(ctx, ref.sketch)}" indisponível`);
      const l = s.entities[ref.entity];
      if (l?.type !== "line") throw new Error(`"${ref.entity}" não é uma linha do esboço`);
      const p1 = s.entities[l.p1], p2 = s.entities[l.p2];
      if (p1?.type !== "point" || p2?.type !== "point") throw new Error("Linha de eixo inválida");
      const a = to3D(s.frame, [p1.x, p1.y]), b = to3D(s.frame, [p2.x, p2.y]);
      return { o: a, d: v3.norm(v3.sub(b, a)) };
    }
  }
}

/** Corpo e corpos de superfície juntos, para resolver referências em qualquer um deles. */
export function pool(ctx: Ctx): NamedBody {
  if (!ctx.body && !ctx.sheets.size) throw new Error("Ainda não existe corpo");
  if (!ctx.sheets.size) return ctx.body!;
  const all = [...(ctx.body ? [ctx.body] : []), ...ctx.sheets.values()];
  return { shape: all[0].shape, faces: all.flatMap((b) => b.faces) };
}

/** Dono de uma face: "body" (corpo sólido) ou o id do corpo de superfície. */
export function faceOwner(ctx: Ctx, face: TopoDS_Face): string | null {
  if (ctx.body?.faces.some((f) => f.face.IsSame(face))) return "body";
  for (const [id, b] of ctx.sheets) if (b.faces.some((f) => f.face.IsSame(face))) return id;
  return null;
}

export function sheetOf(ctx: Ctx, id: string): NamedBody {
  const b = ctx.sheets.get(id);
  if (!b) throw new Error(`Corpo de superfície "${featureName(ctx, id)}" indisponível (foi consumido por outra feature?)`);
  return b;
}

const howWarning = (r: TopoRef, how: string) =>
  how === "geometry" ? `Referência "${r.name}" reparada pela posição (o nome deixou de existir)` : undefined;

/** Resolve referências a faces. */
export function faces(ctx: Ctx, refs: TopoRef[], report: StepReport): NamedFace[] {
  const body = pool(ctx);
  const out: NamedFace[] = [];
  for (const r of refs) {
    const res = resolveFace(body, r);
    if (res.how === "missing") throw new Error(`Face "${r.name}" já não existe`);
    const w = howWarning(r, res.how);
    if (w) report.warnings.push(w);
    for (const f of res.items) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** Resolve referências a arestas; uma referência a face expande para todas as suas arestas. */
export function edges(ctx: Ctx, refs: TopoRef[], report: StepReport): NamedEdge[] {
  const body = pool(ctx);
  const all = namedEdges(body);
  const out: NamedEdge[] = [];
  const push = (e: NamedEdge) => { if (!out.some((o) => o.edge.IsSame(e.edge))) out.push(e); };
  for (const r of refs) {
    if (r.kind === "face") {
      // uma face seleciona as suas arestas vivas; as tangentes (concordâncias) são ignoradas
      let smooth = 0, found = 0;
      for (const f of faces(ctx, [r], report)) {
        for (const fe of explore(f.face, "edge")) {
          const ne = all.find((e) => e.edge.IsSame(fe));
          if (!ne) continue;
          const adj = ne.faces.map((n) => body.faces.find((x) => x.name === n)?.face).filter((x) => x !== undefined);
          if (adj.length === 2 && isSmoothEdge(ne.edge, adj[0], adj[1])) { smooth++; continue; }
          found++;
          push(ne);
        }
      }
      if (!found && smooth) throw new Error(`As arestas da face "${r.name}" são todas tangentes (sem canto vivo)`);
      if (smooth) report.warnings.push(`${smooth} aresta(s) tangente(s) da face ignorada(s)`);
      continue;
    }
    const res = resolveEdge(body, all, r);
    if (res.how === "missing") throw new Error(`Aresta "${r.name}" já não existe`);
    const w = howWarning(r, res.how);
    if (w) report.warnings.push(w);
    res.items.forEach(push);
  }
  return out;
}

/** Comprimento característico do modelo (para "através de tudo"). */
export function modelSize(ctx: Ctx, extra: Vec3[] = []): number {
  let size = 100;
  for (const b of [...(ctx.body ? [ctx.body] : []), ...ctx.sheets.values()]) {
    const { min, max } = bboxOf(b);
    size = Math.max(size, v3.dist(min, max));
    for (const p of extra) size = Math.max(size, v3.dist(p, min), v3.dist(p, max));
  }
  return size * 2;
}

export const bboxOf = (b: NamedBody) => bbox(b.shape);
