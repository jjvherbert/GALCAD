// Registo de features (A4): um builder por tipo. O tipo mapeado obriga o compilador a exigir um builder
// para cada tipo de `FeatureType` — acrescentar um tipo sem builder deixa de compilar.
import type { FeatureOf, FeatureType } from "../doc/types.ts";
import type { Ctx, StepReport } from "./context.ts";
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
import { pluginFeature } from "./features/plugin.ts";

export type Builder<K extends FeatureType> = (ctx: Ctx, f: FeatureOf<K>, report: StepReport) => Ctx | Promise<Ctx>;

export const BUILDERS: { readonly [K in FeatureType]: Builder<K> } = {
  sketch, extrude, revolve, sweep, loft, rib, hole,
  fillet, chamfer, shell, draft,
  linearPattern, circularPattern, mirror: mirrorFeature,
  plane, axis, csys, import: importFeature,
  surfaceExtrude, surfaceRevolve, surfaceSweep, surfaceLoft, fill, offsetSurface, knit, thicken, trimSurface, deleteFace,
  curve, boundary, ruled, untrim, replaceFace,
  multiSection, blend, circleSweep, extrapolate, heal,
  freeform, external, plugin: pluginFeature,
};

/** Corre o builder da feature; o cast junta a união à entrada do registo do mesmo tipo. */
export const buildFeature = (ctx: Ctx, f: FeatureOf<FeatureType>, report: StepReport) =>
  (BUILDERS[f.type] as Builder<FeatureType>)(ctx, f, report);
