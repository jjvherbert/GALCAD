// Curvas 3D: spline por pontos, projeção de esboço em faces, interseção, curva composta e hélice.
// Cada curva fica em ctx.curves com a chave do id da feature; as arestas chamam-se fN:c0, fN:c1, …
// (ordem geométrica) e podem ser usadas como caminho de varrimento, limite de superfícies ou referência.
import { makeHelix } from "replicad";
import type { CurveFeature, CurveRef, Feature, SurfaceTarget, Vec3 } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type NamedCurve, type StepReport, axisOf, edges as resolveEdges, faces as resolveFaces, featureName, modelSize, planeFrame, sheetOf } from "../context.ts";
import { type NamedEdge, sortByPosition } from "../naming.ts";
import { T, type TopoDS_Shape, edgeProps, explore, gpAx1, gpPln, gpVec, interpolateEdge, makeCompound, makeWire, oc, v3 } from "../occ.ts";
import { chainWire } from "../sketch3d.ts";
import { sketchOf } from "./solid.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

/** Curva nomeada a partir de arestas (num contorno, se ligarem). */
export function namedCurve(edges: TopoDS_Shape[], fid: string): NamedCurve {
  if (!edges.length) throw new Error("A curva não tem arestas");
  const wire = edges.length > 1 ? makeWire(edges) : null;
  const shape = edges.length === 1 ? edges[0] : wire ?? makeCompound(edges);
  const sorted = sortByPosition(explore(shape, "edge"), (e) => edgeProps(e).mid);
  return { shape, edges: sorted.map((edge, k) => ({ edge, name: `${fid}:c${k}`, faces: [] })) };
}

/** Forma de um alvo de interseção/projeção. */
export function targetShape(ctx: Ctx, t: SurfaceTarget, report: StepReport): TopoDS_Shape {
  switch (t.kind) {
    case "plane": {
      const fr = planeFrame(ctx, t.plane, report);
      const far = modelSize(ctx);
      return T(T(new (oc().BRepBuilderAPI_MakeFace)(gpPln(fr.o, fr.z), -far, far, -far, far)).Face());
    }
    case "sheet": return sheetOf(ctx, t.sheet).shape;
    case "faces": {
      const fs = resolveFaces(ctx, t.faces, report);
      if (!fs.length) throw new Error("Escolha as faces");
      return fs.length === 1 ? fs[0].face : makeCompound(fs.map((x) => x.face));
    }
    case "body":
      if (!ctx.body) throw new Error("Ainda não existe corpo sólido");
      return ctx.body.shape;
  }
}

/** Arestas da interseção de duas formas. */
function section(a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape[] {
  const s = T(new (oc().BRepAlgoAPI_Section)(a, b, false));
  s.Approximation(true);
  s.Build();
  if (!s.IsDone() || s.HasErrors()) throw new Error("A interseção falhou");
  return explore(T(s.Shape()), "edge");
}

export const curve: Step<CurveFeature & Feature> = (ctx, f, report) => {
  const c = f.def;
  let edges: TopoDS_Shape[];
  switch (c.kind) {
    case "points": {
      const pts = c.points.map((p, i) => p.map((x, k) => evalParam(x, ctx.scope, `Ponto ${i + 1} ${"XYZ"[k]}`)) as Vec3);
      if (pts.length < 2) throw new Error("São precisos pelo menos 2 pontos");
      edges = [interpolateEdge(pts, !!c.closed)];
      break;
    }
    case "projected": {
      // o esboço é extrudido nos dois sentidos da sua normal e intersetado com as faces
      const s = sketchOf(ctx, c.sketch);
      if (!s.profiles.chains.length) throw new Error(`O esboço "${featureName(ctx, c.sketch)}" está vazio`);
      const onto = targetShape(ctx, c.onto, report);
      const far = modelSize(ctx, [s.frame.o]);
      const o = oc();
      edges = s.profiles.chains.flatMap((ch) => {
        const w = chainWire(ch, { ...s.frame, o: v3.add(s.frame.o, v3.mul(s.frame.z, -far)) }).wrapped;
        const sheet = T(T(new o.BRepPrimAPI_MakePrism(w, gpVec(v3.mul(s.frame.z, 2 * far)), false, true)).Shape());
        return section(sheet, onto);
      });
      if (!edges.length) throw new Error("A projeção não atinge as faces escolhidas");
      break;
    }
    case "intersection": {
      edges = section(targetShape(ctx, c.a, report), targetShape(ctx, c.b, report));
      if (!edges.length) throw new Error("As duas superfícies não se intersetam");
      break;
    }
    case "composite": {
      const es = resolveEdges(ctx, c.edges, report).map((e) => e.edge);
      if (!es.length) throw new Error("Escolha as arestas");
      if (es.length > 1 && !makeWire(es)) throw new Error("As arestas não formam uma cadeia contínua");
      edges = es;
      break;
    }
    case "helix": {
      const ax = axisOf(ctx, c.axis, report);
      const r = evalParam(c.radius, ctx.scope, "Raio");
      const pitch = evalParam(c.pitch, ctx.scope, "Passo");
      const h = evalParam(c.height, ctx.scope, "Altura");
      if (r <= 0 || pitch <= 0 || h <= 0) throw new Error("Raio, passo e altura têm de ser positivos");
      const w = makeHelix(pitch, h, r, ax.o, ax.d, !!c.lefthand);
      T(w);
      let shape = w.wrapped as TopoDS_Shape;
      const a0 = evalParam(c.startAngle, ctx.scope, "Ângulo inicial", 0);
      if (Math.abs(a0) > 1e-9) {
        const t = T(new (oc().gp_Trsf)());
        t.SetRotation(gpAx1(ax.o, ax.d), (a0 * Math.PI) / 180);
        shape = T(T(new (oc().BRepBuilderAPI_Transform)(shape, t, true, false)).Shape());
      }
      edges = explore(shape, "edge");
      break;
    }
  }
  ctx.curves.set(f.id, namedCurve(edges, f.id));
  return ctx;
};

/** Arestas de uma curva de entrada (curva 3D, aresta do modelo ou esboço com uma cadeia). */
export function curveRefEdges(ctx: Ctx, c: CurveRef, report: StepReport): NamedEdge[] {
  switch (c.kind) {
    case "curve": {
      const k = ctx.curves.get(c.feature);
      if (!k) throw new Error(`Curva "${featureName(ctx, c.feature)}" indisponível`);
      return k.edges;
    }
    case "edge": return resolveEdges(ctx, [c.ref], report);
    case "sketch": {
      const s = sketchOf(ctx, c.sketch);
      if (s.profiles.chains.length !== 1) throw new Error(`Esboço "${featureName(ctx, c.sketch)}": tem de ter uma só cadeia`);
      const w = chainWire(s.profiles.chains[0], s.frame).wrapped;
      return explore(w, "edge").map((edge, k) => ({ edge, name: `${c.sketch}:s${k}`, faces: [] }));
    }
  }
}

/** Caminho de varrimento: curva 3D ou esboço (uma cadeia). */
export function pathWire(ctx: Ctx, id: string): TopoDS_Shape {
  const k = ctx.curves.get(id);
  if (k) {
    const es = k.edges.map((e) => e.edge);
    const w = es.length === 1 ? T(T(new (oc().BRepBuilderAPI_MakeWire)(oc().TopoDS.Edge(es[0]))).Wire()) : makeWire(es);
    if (!w) throw new Error(`A curva "${featureName(ctx, id)}" não é contínua`);
    return w;
  }
  const path = sketchOf(ctx, id);
  if (path.profiles.chains.length !== 1) throw new Error(`O caminho "${featureName(ctx, id)}" tem de ser uma única cadeia de entidades`);
  return chainWire(path.profiles.chains[0], path.frame).wrapped;
}
