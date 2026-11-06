// Superfícies a partir de esboços: extrudir, revolver, varrer e loft.
import type { Feature, SurfaceExtrudeFeature, SurfaceLoftFeature, SurfaceRevolveFeature, SurfaceSweepFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { axisOf, featureName } from "../context.ts";
import { rotateFrame } from "../frame.ts";
import { T, type TopoDS_Shape, gpAx1, gpVec, oc, v3 } from "../occ.ts";
import { generatedNames } from "./solid.ts";
import { pathWire } from "./curve.ts";
import { setupPipe } from "./gsd.ts";
import { type Step, chainsOf, chainWithMap, shiftFrame, sheetFrom } from "./surface-common.ts";

export const surfaceExtrude: Step<SurfaceExtrudeFeature & Feature> = (ctx, f, report) => {
  const { s, chains } = chainsOf(ctx, f.sketch, report);
  const depth = evalParam(f.end.depth, ctx.scope, "Profundidade");
  if (depth <= 0) throw new Error("Profundidade: tem de ser positiva");
  const n = f.flip ? v3.mul(s.frame.z, -1) : s.frame.z;
  const frame = f.end.type === "midplane" ? shiftFrame(s.frame, v3.mul(n, -depth / 2)) : s.frame;
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, frame);
    const mk = T(new (oc().BRepPrimAPI_MakePrism)(wire, gpVec(v3.mul(n, depth)), false, true));
    return { shape: T(mk.Shape()), known: generatedNames(mk, edgeMap, `${f.id}:side`) };
  });
  ctx.sheets.set(f.id, sheetFrom(parts, f.id));
  return ctx;
};

export const surfaceRevolve: Step<SurfaceRevolveFeature & Feature> = (ctx, f, report) => {
  const { s, chains } = chainsOf(ctx, f.sketch, report);
  const axis = axisOf(ctx, f.axis, report);
  const angle = evalParam(f.angle, ctx.scope, "Ângulo");
  if (angle <= 0 || angle > 360) throw new Error("Ângulo: tem de estar entre 0 e 360°");
  const rad = (angle * Math.PI) / 180;
  const frame = f.midplane && angle < 360 ? rotateFrame(s.frame, axis, -rad / 2) : s.frame;
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, frame);
    const mk = T(new (oc().BRepPrimAPI_MakeRevol)(wire, gpAx1(axis.o, axis.d), rad, false));
    return {
      shape: T(mk.Shape()),
      known: generatedNames(mk, edgeMap, `${f.id}:side`),
      containing: [...edgeMap].map(([edge, ent]) => ({ edge, name: `${f.id}:side:${ent}` })),
    };
  });
  ctx.sheets.set(f.id, sheetFrom(parts, f.id));
  return ctx;
};

export const surfaceSweep: Step<SurfaceSweepFeature & Feature> = (ctx, f, report) => {
  const { s, chains } = chainsOf(ctx, f.profile, report);
  const spine = pathWire(ctx, f.path);
  const parts = chains.map((c) => {
    const { wire, edgeMap } = chainWithMap(c, s.frame);
    const mk = T(new (oc().BRepOffsetAPI_MakePipeShell)(oc().TopoDS.Wire(spine)));
    setupPipe(ctx, mk, f, wire, report);
    mk.Build();
    if (!mk.IsDone()) throw new Error("O varrimento falhou (perfil demasiado grande para a curvatura do caminho?)");
    return { shape: T(mk.Shape()), known: generatedNames(mk, edgeMap, `${f.id}:side`) };
  });
  ctx.sheets.set(f.id, sheetFrom(parts, f.id));
  return ctx;
};

export const surfaceLoft: Step<SurfaceLoftFeature & Feature> = (ctx, f, report) => {
  if (f.sections.length < 2) throw new Error("O loft precisa de pelo menos 2 secções");
  const mk = T(new (oc().BRepOffsetAPI_ThruSections)(false, !!f.ruled, 1e-6));
  let firstMap: Map<TopoDS_Shape, string> | undefined;
  let closed: boolean | undefined;
  for (const id of f.sections) {
    const { s, chains } = chainsOf(ctx, id, report);
    if (chains.length > 1) throw new Error(`Secção "${featureName(ctx, id)}": só uma cadeia por secção`);
    if (closed !== undefined && closed !== chains[0].closed) throw new Error("As secções têm de ser todas abertas ou todas fechadas");
    closed = chains[0].closed;
    const { wire, edgeMap } = chainWithMap(chains[0], s.frame);
    firstMap ??= edgeMap;
    mk.AddWire(oc().TopoDS.Wire(wire));
  }
  mk.CheckCompatibility(false);
  mk.Build();
  if (!mk.IsDone()) throw new Error("O loft falhou (secções incompatíveis?)");
  ctx.sheets.set(f.id, sheetFrom([{ shape: T(mk.Shape()), known: generatedNames(mk, firstMap!, `${f.id}:side`) }], f.id));
  return ctx;
};
