// Auxiliares partilhados dos módulos de superfície: tipo de passo, cadeias de esboço, costura e sólidos a partir de cascas.
import type { Vec3 } from "../../doc/types.ts";
import type { Chain } from "../../sketch/profiles.ts";
import { type Ctx, type SketchResult, type StepReport, featureName } from "../context.ts";
import type { Frame } from "../frame.ts";
import { chainWire, mapEdgesToEntities } from "../sketch3d.ts";
import { type NamedBody, ShapeIndex } from "../naming.ts";
import { T, type TopoDS_Shape, explore, makeCompound, makeShell, oc, v3 } from "../occ.ts";
import { nameFrom, sketchOf } from "./solid.ts";

export type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

/** Cadeias (abertas ou fechadas) de um esboço, para superfícies. */
export function chainsOf(ctx: Ctx, id: string, report: StepReport): { s: SketchResult; chains: Chain[] } {
  const s = sketchOf(ctx, id);
  const chains = s.profiles.chains;
  const branched = s.profiles.errors.filter((e) => e.startsWith("Contorno ramificado"));
  if (!chains.length) throw new Error(`Esboço "${featureName(ctx, id)}": ${branched[0] ?? "sem entidades"}`);
  if (branched.length) report.warnings.push(`Esboço "${featureName(ctx, id)}": ${branched[0]} (ignorado)`);
  return { s, chains };
}

export function chainWithMap(c: Chain, frame: Frame) {
  const wire = chainWire(c, frame);
  return { wire: wire.wrapped as TopoDS_Shape, edgeMap: mapEdgesToEntities(wire.wrapped, c.segs, frame) as Map<TopoDS_Shape, string> };
}

export const shiftFrame = (f: Frame, d: Vec3): Frame => ({ ...f, o: v3.add(f.o, d) });
export const one = (shapes: TopoDS_Shape[]) => (shapes.length === 1 ? shapes[0] : makeCompound(shapes));

/** Junta várias peças de superfície num corpo nomeado. */
export function sheetFrom(parts: { shape: TopoDS_Shape; known: { face: TopoDS_Shape; name: string }[]; containing?: { edge: TopoDS_Shape; name: string }[] }[], fid: string): NamedBody {
  const shape = one(parts.map((p) => p.shape));
  const body = nameFrom(shape, fid, parts.flatMap((p) => p.known), undefined, parts.flatMap((p) => p.containing ?? []));
  if (!body.faces.length) throw new Error("A superfície não tem faces");
  return body;
}

/** Retira faces de um corpo de superfície (e apaga-o se ficar vazio). */
export function removeFromSheet(sheets: Map<string, NamedBody>, id: string, gone: ShapeIndex<true>) {
  const sh = sheets.get(id)!;
  const rest = sh.faces.filter((nf) => !gone.has(nf.face));
  if (rest.length) sheets.set(id, { shape: makeShell(rest.map((r) => r.face)), faces: rest });
  else sheets.delete(id);
}

/** Costura faces soltas numa casca (as arestas comuns ficam partilhadas), com o mapa face → face costurada. */
export function sew(shapes: TopoDS_Shape[], tol: number) {
  const s = T(new (oc().BRepBuilderAPI_Sewing)(tol, true, true, true, false));
  for (const x of shapes) s.Add(x);
  s.Perform();
  const shape = T(s.SewedShape());
  if (shape.IsNull()) throw new Error("A costura não produziu nenhuma forma");
  // as faces são subformas das formas costuradas: o histórico delas está em *SubShape
  const map = (face: TopoDS_Shape) => (s.IsModifiedSubShape(face) ? T(s.ModifiedSubShape(face)) : s.IsModified(face) ? T(s.Modified(face)) : face);
  return { shape, map, freeEdges: s.NbFreeEdges() };
}

/** Sólido(s) a partir das cascas fechadas de uma forma, com a matéria para dentro. */
export function solidsOf(shape: TopoDS_Shape): TopoDS_Shape {
  const o = oc();
  const solids = explore(shape, "shell").map((sh) => {
    const mk = T(new o.BRepBuilderAPI_MakeSolid(o.TopoDS.Shell(sh)));
    const solid = T(mk.Solid());
    if (!o.BRepLib.OrientClosedSolid(solid)) throw new Error("A casca costurada não é orientável (faces sobrepostas?)");
    return solid as TopoDS_Shape;
  });
  if (!solids.length) throw new Error("A costura não formou nenhuma casca");
  return one(solids);
}
