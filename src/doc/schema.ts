// Schemas zod de cada feature. Validam os dados ao abrir um documento.
// O tipo de FEATURE_SCHEMAS obriga a um schema por FeatureType, igual ao tipo em types.ts:
// uma feature nova sem schema, ou um campo diferente, não compila.
// Ficheiro à parte de features.ts para o núcleo não carregar o zod sem precisar.
import { z } from "zod";
import type { FeatureData, FeatureType } from "./types.ts";

const expr = z.union([z.number(), z.string()]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const expr3 = z.tuple([expr, expr, expr]);
const op = z.enum(["add", "cut", "intersect", "new"]);
const continuity = z.enum(["contact", "tangent", "curvature"]);
const stdPlane = z.enum(["XY", "XZ", "YZ"]);
const stdAxis = z.enum(["X", "Y", "Z"]);

const topoRef = z.object({
  kind: z.enum(["face", "edge"]),
  name: z.string(),
  hint: z.object({ c: vec3, n: vec3.optional() }).optional(),
});
const topoRefs = z.array(topoRef);

const planeRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("std"), name: stdPlane }),
  z.object({ kind: z.literal("datum"), feature: z.string() }),
  z.object({ kind: z.literal("csys"), feature: z.string(), name: stdPlane }),
  z.object({ kind: z.literal("face"), ref: topoRef }),
]);

const axisRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("std"), name: stdAxis }),
  z.object({ kind: z.literal("datum"), feature: z.string() }),
  z.object({ kind: z.literal("csys"), feature: z.string(), name: stdAxis }),
  z.object({ kind: z.literal("edge"), ref: topoRef }),
  z.object({ kind: z.literal("sketchLine"), sketch: z.string(), entity: z.string() }),
]);

const curveRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("curve"), feature: z.string() }),
  z.object({ kind: z.literal("edge"), ref: topoRef }),
  z.object({ kind: z.literal("sketch"), sketch: z.string() }),
]);

const surfaceTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plane"), plane: planeRef }),
  z.object({ kind: z.literal("sheet"), sheet: z.string() }),
  z.object({ kind: z.literal("faces"), faces: topoRefs }),
  z.object({ kind: z.literal("body") }),
]);

const regionRef = z.object({ sig: z.array(z.string()), seed: z.tuple([z.number(), z.number()]) });

const endCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blind"), depth: expr }),
  z.object({ type: z.literal("midplane"), depth: expr }),
  z.object({ type: z.literal("throughAll") }),
  z.object({ type: z.literal("upToFace"), face: topoRef, offset: expr.optional() }),
]);

const sweepOptions = {
  orientation: z.enum(["frenet", "fixed", "binormal", "support", "guide"]).optional(),
  binormal: axisRef.optional(),
  support: topoRefs.optional(),
  guide: curveRef.optional(),
  guideMode: z.enum(["orient", "contact", "border"]).optional(),
  scale: expr.optional(),
  scaleLaw: z.enum(["linear", "s"]).optional(),
};

const construction = z.boolean().optional();
const sketchEntity = z.discriminatedUnion("type", [
  z.object({ type: z.literal("point"), x: z.number(), y: z.number(), construction, fixed: z.boolean().optional() }),
  z.object({ type: z.literal("line"), p1: z.string(), p2: z.string(), construction, ext: topoRef.optional() }),
  z.object({ type: z.literal("circle"), c: z.string(), r: z.number(), construction, ext: topoRef.optional() }),
  z.object({
    type: z.literal("arc"),
    c: z.string(), s: z.string(), e: z.string(),
    r: z.number(), a0: z.number(), a1: z.number(),
    construction, ext: topoRef.optional(),
  }),
  z.object({ type: z.literal("spline"), pts: z.array(z.string()), construction }),
]);

const constraintType = z.enum([
  "coincident", "pointOn", "midpoint", "horizontal", "vertical", "parallel", "perpendicular",
  "collinear", "tangent", "equal", "concentric", "symmetric", "fix",
  "distance", "distanceX", "distanceY", "radius", "diameter", "angle",
]);
const sketchConstraint = z.object({
  id: z.string(),
  type: constraintType,
  refs: z.array(z.string()),
  value: expr.optional(),
  driven: z.boolean().optional(),
  pos: z.tuple([z.number(), z.number()]).optional(),
});

const curveDef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("points"), points: z.array(expr3), closed: z.boolean().optional() }),
  z.object({ kind: z.literal("projected"), sketch: z.string(), onto: surfaceTarget }),
  z.object({ kind: z.literal("intersection"), a: surfaceTarget, b: surfaceTarget }),
  z.object({ kind: z.literal("composite"), edges: topoRefs }),
  z.object({
    kind: z.literal("helix"),
    axis: axisRef, radius: expr, pitch: expr, height: expr,
    lefthand: z.boolean().optional(), startAngle: expr.optional(),
  }),
  z.object({
    kind: z.literal("extend"),
    curve: curveRef, start: expr.optional(), end: expr.optional(),
    continuity: z.enum(["tangent", "curvature"]).optional(),
  }),
]);

const sectionTangent = z.object({ face: topoRef, weight: expr.optional(), flip: z.boolean().optional() });
const blendSide = z.object({
  curve: curveRef,
  support: topoRef.optional(),
  continuity,
  tension: expr.optional(),
  flip: z.boolean().optional(),
});
const frame = z.object({ o: vec3, x: vec3, y: vec3, z: vec3 });

const flip = z.boolean().optional();
const ids = z.array(z.string());

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Data<K extends FeatureType> = Extract<FeatureData, { type: K }>;
type Schemas = { [K in FeatureType]: z.ZodType };

// Cada chave tem de ter um schema cujo resultado é exatamente o tipo da feature.
// Se não for, o erro aparece nessa chave.
function exact<S extends Schemas>(s: S & { [K in FeatureType]: Same<z.output<S[K]>, Data<K>> extends true ? unknown : "schema diferente do tipo" }): S {
  return s;
}

export const FEATURE_SCHEMAS = exact({
  sketch: z.object({
    type: z.literal("sketch"),
    plane: planeRef,
    entities: z.record(z.string(), sketchEntity),
    constraints: z.array(sketchConstraint),
  }),
  extrude: z.object({
    type: z.literal("extrude"),
    sketch: z.string(), regions: z.array(regionRef).optional(), op,
    end: endCondition, end2: endCondition.optional(), flip, draft: expr.optional(),
  }),
  revolve: z.object({
    type: z.literal("revolve"),
    sketch: z.string(), regions: z.array(regionRef).optional(), axis: axisRef, op,
    angle: expr, midplane: z.boolean().optional(), flip,
  }),
  sweep: z.object({ type: z.literal("sweep"), profile: z.string(), path: z.string(), op, ...sweepOptions }),
  loft: z.object({ type: z.literal("loft"), sections: ids, op, ruled: z.boolean().optional() }),
  hole: z.object({
    type: z.literal("hole"),
    sketch: z.string(),
    kind: z.enum(["simple", "clearance", "tapped"]),
    size: z.string().optional(),
    diameter: expr.optional(),
    fit: z.enum(["close", "normal", "loose"]).optional(),
    head: z.enum(["none", "counterbore", "countersink"]).optional(),
    headDiameter: expr.optional(), headDepth: expr.optional(), headAngle: expr.optional(),
    end: z.discriminatedUnion("type", [
      z.object({ type: z.literal("blind"), depth: expr }),
      z.object({ type: z.literal("throughAll") }),
    ]),
    tipAngle: expr.optional(), threadDepth: expr.optional(), flip,
  }),
  fillet: z.object({ type: z.literal("fillet"), refs: topoRefs, radius: expr }),
  chamfer: z.object({ type: z.literal("chamfer"), refs: topoRefs, distance: expr, distance2: expr.optional() }),
  shell: z.object({ type: z.literal("shell"), faces: topoRefs, thickness: expr, outward: z.boolean().optional() }),
  draft: z.object({ type: z.literal("draft"), faces: topoRefs, neutral: planeRef, angle: expr, flip }),
  rib: z.object({ type: z.literal("rib"), sketch: z.string(), thickness: expr, flip }),
  linearPattern: z.object({
    type: z.literal("linearPattern"),
    features: ids, direction: axisRef, count: expr, spacing: expr, flip,
    direction2: axisRef.optional(), count2: expr.optional(), spacing2: expr.optional(), flip2: z.boolean().optional(),
  }),
  circularPattern: z.object({ type: z.literal("circularPattern"), features: ids, axis: axisRef, count: expr, angle: expr }),
  mirror: z.object({ type: z.literal("mirror"), features: ids, plane: planeRef }),
  plane: z.object({ type: z.literal("plane"), base: planeRef, offset: expr, angle: expr.optional(), axis: axisRef.optional(), flip }),
  axis: z.object({
    type: z.literal("axis"),
    mode: z.enum(["twoPlanes", "edge", "twoPoints"]),
    planes: z.tuple([planeRef, planeRef]).optional(),
    edge: topoRef.optional(),
    points: z.tuple([vec3, vec3]).optional(),
  }),
  csys: z.object({ type: z.literal("csys"), origin: expr3, rotation: expr3 }),
  import: z.object({ type: z.literal("import"), format: z.literal("step"), fileName: z.string(), data: z.string(), op }),
  plugin: z.object({ type: z.literal("plugin"), plugin: z.string(), kind: z.string(), params: z.record(z.string(), expr), op }),
  surfaceExtrude: z.object({
    type: z.literal("surfaceExtrude"),
    sketch: z.string(),
    end: z.discriminatedUnion("type", [
      z.object({ type: z.literal("blind"), depth: expr }),
      z.object({ type: z.literal("midplane"), depth: expr }),
    ]),
    flip,
  }),
  surfaceRevolve: z.object({ type: z.literal("surfaceRevolve"), sketch: z.string(), axis: axisRef, angle: expr, midplane: z.boolean().optional() }),
  surfaceSweep: z.object({ type: z.literal("surfaceSweep"), profile: z.string(), path: z.string(), ...sweepOptions }),
  surfaceLoft: z.object({ type: z.literal("surfaceLoft"), sections: ids, ruled: z.boolean().optional() }),
  fill: z.object({ type: z.literal("fill"), edges: topoRefs, continuity }),
  offsetSurface: z.object({ type: z.literal("offsetSurface"), faces: topoRefs, distance: expr }),
  knit: z.object({
    type: z.literal("knit"),
    sheets: ids, makeSolid: z.boolean().optional(), op: op.optional(), tolerance: expr.optional(),
    checkConnected: z.boolean().optional(), checkTangency: z.boolean().optional(), simplify: z.boolean().optional(),
  }),
  thicken: z.object({ type: z.literal("thicken"), sheet: z.string(), thickness: expr, side: z.enum(["front", "back", "both"]), op }),
  trimSurface: z.object({
    type: z.literal("trimSurface"),
    sheet: z.string(),
    tool: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("plane"), plane: planeRef }),
      z.object({ kind: z.literal("sheet"), sheet: z.string() }),
      z.object({ kind: z.literal("sketch"), sketch: z.string() }),
    ]),
    keep: z.array(vec3),
    mutual: z.boolean().optional(),
  }),
  deleteFace: z.object({ type: z.literal("deleteFace"), faces: topoRefs, mode: z.enum(["delete", "patch"]).optional(), continuity: continuity.optional() }),
  curve: z.object({ type: z.literal("curve"), def: curveDef }),
  boundary: z.object({
    type: z.literal("boundary"),
    dir1: z.array(curveRef), dir2: z.array(curveRef), cont1: continuity.optional(), cont2: continuity.optional(),
  }),
  ruled: z.object({
    type: z.literal("ruled"),
    edges: topoRefs,
    mode: z.enum(["normal", "tangent", "direction", "angle"]),
    angle: expr.optional(), face: topoRef.optional(), direction: axisRef.optional(),
    distance: expr, flip,
  }),
  untrim: z.object({ type: z.literal("untrim"), faces: topoRefs }),
  replaceFace: z.object({ type: z.literal("replaceFace"), faces: topoRefs, sheet: z.string() }),
  multiSection: z.object({
    type: z.literal("multiSection"),
    sections: z.array(curveRef), guides: z.array(curveRef).optional(), spine: curveRef.optional(),
    startTangent: sectionTangent.optional(), endTangent: sectionTangent.optional(),
  }),
  blend: z.object({ type: z.literal("blend"), side1: blendSide, side2: blendSide }),
  circleSweep: z.object({
    type: z.literal("circleSweep"),
    mode: z.enum(["threeGuides", "twoGuidesRadius", "centerRadius"]),
    guides: z.array(curveRef), radius: expr.optional(), flip, long: z.boolean().optional(),
  }),
  extrapolate: z.object({
    type: z.literal("extrapolate"),
    sheet: z.string(), edges: topoRefs, length: expr,
    continuity: z.enum(["tangent", "curvature"]), assemble: z.boolean().optional(),
  }),
  heal: z.object({ type: z.literal("heal"), sheets: ids, distance: expr, tangency: expr.optional(), simplify: z.boolean().optional() }),
  freeform: z.object({
    type: z.literal("freeform"),
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("patch"),
        plane: planeRef, width: expr, height: expr, nu: z.number(), nv: z.number(), degree: z.number().optional(),
      }),
      z.object({ kind: z.literal("face"), face: topoRef, nu: z.number().optional(), nv: z.number().optional() }),
    ]),
    moves: z.array(z.object({ i: z.number(), j: z.number(), d: vec3 })),
  }),
  external: z.object({
    type: z.literal("external"),
    part: z.string(),
    publication: z.string(),
    mode: z.enum(["linked", "frozen"]),
    placement: z.object({
      m: z.array(z.number()),
      assembly: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    }).optional(),
    frozen: z.object({
      revision: z.string(),
      brep: z.string().optional(),
      frame: frame.optional(),
      axis: z.object({ o: vec3, d: vec3 }).optional(),
    }).optional(),
    op: op.optional(),
  }),
});

const common = z.object({ id: z.string(), name: z.string(), suppressed: z.boolean().optional() });

// Valida uma feature já com tipo conhecido. Devolve a mensagem de erro, ou null se for válida.
// Não altera o objeto: as chaves desconhecidas ficam (documentos de versões mais novas).
export function featureError(f: { id: string; type: FeatureType; name?: unknown }): string | null {
  const schema: z.ZodType = FEATURE_SCHEMAS[f.type];
  const r = common.safeParse(f);
  const s = r.success ? schema.safeParse(f) : r;
  if (s.success) return null;
  const issue = s.error.issues[0];
  const where = issue.path.length ? issue.path.join(".") : "raiz";
  const label = typeof f.name === "string" ? `${f.id} (${f.name})` : f.id;
  return `Feature ${label} inválida em ${where}: ${issue.message}`;
}
