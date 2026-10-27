// Features que criam sólidos a partir de esboços: extrusão, revolução, varrimento, loft e nervura.
import type { EndCondition, ExtrudeFeature, Feature, LoftFeature, RegionRef, RevolveFeature, RibFeature, SweepFeature, Vec3 } from "../../doc/types.ts";
import { regionKey, resolveRegions } from "../regions.ts";
import { evalParam } from "../../doc/variables.ts";
import type { Region } from "../../sketch/profiles.ts";
import { type Ctx, type SketchResult, type StepReport, axisOf, faces as resolveFaces, featureName, modelSize } from "../context.ts";
import { type Frame, offsetFrame, rotateFrame, to3D } from "../frame.ts";
import { chainWire, loopWire, mapEdgesToEntities, regionFace } from "../sketch3d.ts";
import { type NamedBody, finalize, nameResult } from "../naming.ts";
import { T, type TopoDS_Face, type TopoDS_Shape, bbox, edgeProps, explore, faceProps, vertexAt, gpAx1, gpDir, gpPln, gpVec, isValid, listToArray, makeCompound, oc, v3, distance } from "../occ.ts";
import { applyOp } from "../boolean.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;

export function sketchOf(ctx: Ctx, id: string): SketchResult {
  const s = ctx.sketches.get(id);
  if (!s) throw new Error(`Esboço "${featureName(ctx, id)}" indisponível`);
  if (!s.solve.ok) throw new Error(`O esboço "${featureName(ctx, id)}" não está resolvido: ${s.solve.message}`);
  return s;
}

function closedRegions(ctx: Ctx, id: string): { s: SketchResult; regions: Region[] } {
  const s = sketchOf(ctx, id);
  if (s.profiles.errors.length) throw new Error(`Esboço "${featureName(ctx, id)}": ${s.profiles.errors[0]}`);
  if (!s.profiles.regions.length) throw new Error(`O esboço "${featureName(ctx, id)}" não tem contornos fechados`);
  return { s, regions: s.profiles.regions };
}

/** Faces geradas por um builder a partir de cada aresta (com nome da entidade de origem). */
function generatedNames(builder: { Generated(s: TopoDS_Shape): unknown }, edgeMap: Map<TopoDS_Shape, string>, prefix: string) {
  const out: { face: TopoDS_Shape; name: string }[] = [];
  for (const [edge, ent] of edgeMap) {
    for (const g of listToArray(builder.Generated(edge) as never)) out.push({ face: g, name: `${prefix}:${ent}` });
  }
  return out;
}

/**
 * Nomeia as faces de um sólido a partir de pares (face → nome) conhecidos; o resto fica com nomes de recurso.
 * `containing`: arestas de perfil cujo ponto médio está na face que geram (recurso quando o histórico
 * do OCC não as devolve, como as faces planas de uma revolução).
 */
function nameFrom(
  shape: TopoDS_Shape, fid: string, known: { face: TopoDS_Shape; name: string }[],
  capNamer?: (f: TopoDS_Face) => string | undefined,
  containing?: { edge: TopoDS_Shape; name: string }[],
): NamedBody {
  const fs = explore(shape, "face");
  const mids = containing?.map((c) => ({ v: vertexAt(edgeProps(c.edge).mid), name: c.name }));
  const names = fs.map((f) => {
    const n = known.filter((k) => k.face.IsSame(f)).map((k) => k.name);
    if (n.length) return n;
    const c = capNamer?.(f);
    if (c) return [c];
    const m = mids?.filter((x) => distance(x.v, f) < 1e-7).map((x) => x.name);
    return m?.length === 1 ? m : undefined;
  });
  return finalize(fs, names, shape, fid);
}

/** Tampas: faces planas coincidentes com o plano inicial (start) ou final (end). */
function capsByPlane(start: Frame, end: Frame | undefined, key: string, fid: string) {
  return (f: TopoDS_Face) => {
    const p = faceProps(f);
    if (p.type !== "plane" || !p.normal) return undefined;
    const on = (fr: Frame) => Math.abs(v3.dot(v3.sub(p.center, fr.o), fr.z)) < 1e-6 && Math.abs(Math.abs(v3.dot(p.normal!, fr.z)) - 1) < 1e-6;
    if (on(start)) return `${fid}:start:${key}`;
    if (end && on(end)) return `${fid}:end:${key}`;
    return undefined;
  };
}

/** Face de perfil pronta a extrudir/revolver: a face, as arestas → entidade e a chave da região. */
interface ProfileFace { face: TopoDS_Shape; edgeMap: Map<TopoDS_Shape, string>; key: string }

/** Movimento rígido do plano do esboço para o início da operação (desvio ou rotação). */
type Move = { translate: Vec3 } | { rotate: { o: Vec3; d: Vec3; rad: number } } | null;

function moved(p: ProfileFace, mv: Move): ProfileFace {
  if (!mv) return p;
  const o = oc();
  const t = T(new o.gp_Trsf());
  if ("translate" in mv) t.SetTranslation(gpVec(mv.translate));
  else t.SetRotation(gpAx1(mv.rotate.o, mv.rotate.d), mv.rotate.rad);
  const mk = T(new o.BRepBuilderAPI_Transform(p.face, t, true, false));
  const edgeMap = new Map<TopoDS_Shape, string>();
  for (const [e, ent] of p.edgeMap) edgeMap.set(T(mk.ModifiedShape(e)), ent);
  return { face: T(mk.Shape()), edgeMap, key: p.key };
}

/**
 * Faces de perfil de um esboço: as regiões escolhidas (contornos selecionados) ou, sem escolha,
 * todos os contornos fechados. `mv` desloca/roda as faces a partir do plano do esboço.
 */
function profileFaces(ctx: Ctx, sketchId: string, refs: RegionRef[] | undefined, mv: Move, report: StepReport): { s: SketchResult; faces: ProfileFace[] } {
  const s = sketchOf(ctx, sketchId);
  if (refs?.length) {
    const { regions, warnings } = resolveRegions(s.regions, refs);
    report.warnings.push(...warnings);
    if (!regions.length) throw new Error("Nenhuma das regiões escolhidas existe no esboço");
    return { s, faces: regions.map((r) => moved({ face: r.face, edgeMap: r.edgeMap, key: regionKey(r) }, mv)) };
  }
  if (s.profiles.errors.length && s.regions.length) {
    throw new Error(`Esboço "${featureName(ctx, sketchId)}": ${s.profiles.errors[0]}. Escolha as regiões a usar (${s.regions.length} disponíveis)`);
  }
  const { regions } = closedRegions(ctx, sketchId);
  return {
    s,
    faces: regions.map((r) => {
      const face = regionFace(r, s.frame);
      const segs = [...r.outer.segs, ...r.holes.flatMap((h) => h.segs)];
      return moved({ face: face.wrapped, edgeMap: mapEdgesToEntities(face.wrapped, segs, s.frame) as Map<TopoDS_Shape, string>, key: r.key }, mv);
    }),
  };
}

/** Prisma nomeado de uma face de perfil ao longo de `vec`. */
function facePrism(p: ProfileFace, vec: Vec3, fid: string): NamedBody {
  const mk = T(new (oc().BRepPrimAPI_MakePrism)(p.face, gpVec(vec), false, true));
  const shape = T(mk.Shape());
  const known = [
    ...generatedNames(mk, p.edgeMap, `${fid}:side`),
    { face: T(mk.FirstShape()), name: `${fid}:start:${p.key}` },
    { face: T(mk.LastShape()), name: `${fid}:end:${p.key}` },
  ];
  return nameFrom(shape, fid, known);
}

/** Junta corpos-ferramenta: regiões adjacentes são fundidas (sem faces interiores). */
function fuseTools(bodies: NamedBody[], fid: string): NamedBody {
  if (bodies.length === 1) return bodies[0];
  let acc = bodies[0];
  for (const b of bodies.slice(1)) acc = applyOp({ body: acc } as Ctx, b, "add", fid);
  return acc;
}

function compoundBodies(bodies: NamedBody[]): NamedBody {
  if (bodies.length === 1) return bodies[0];
  return { shape: makeCompound(bodies.map((b) => b.shape)), faces: bodies.flatMap((b) => b.faces) };
}

/** Distância ao longo de n até ao fim, para cada condição. */
function endDistance(ctx: Ctx, e: EndCondition, frame: Frame, n: Vec3, report: StepReport, label: string): number {
  switch (e.type) {
    case "blind": return evalParam(e.depth, ctx.scope, `${label}: profundidade`);
    case "midplane": return evalParam(e.depth, ctx.scope, `${label}: profundidade`) / 2;
    case "throughAll": return modelSize(ctx, [frame.o]);
    case "upToFace": {
      const [face] = resolveFaces(ctx, [e.face], report);
      const p = faceProps(face.face);
      if (p.type !== "plane" || !p.normal) throw new Error(`${label}: "Até à face" só aceita faces planas`);
      const den = v3.dot(n, p.normal);
      if (Math.abs(den) < 1e-9) throw new Error(`${label}: a face é paralela à direção da extrusão`);
      const t = v3.dot(v3.sub(p.center, frame.o), p.normal) / den;
      const off = evalParam(e.offset, ctx.scope, `${label}: desvio`, 0);
      if (t - off <= 1e-9) throw new Error(`${label}: a face está do lado oposto da direção`);
      return t - off;
    }
  }
}

export const extrude: Step<ExtrudeFeature & Feature> = (ctx, f, report) => {
  const s = sketchOf(ctx, f.sketch);
  // ressalto: ao longo da normal do esboço; corte: para dentro do material (sentido oposto), como no SolidWorks
  const into = f.op === "cut" ? !f.flip : !!f.flip;
  const n = into ? v3.mul(s.frame.z, -1) : s.frame.z;
  let d1 = endDistance(ctx, f.end, s.frame, n, report, "Direção 1");
  let d2 = f.end.type === "midplane" ? d1 : 0;
  if (f.end2) d2 = endDistance(ctx, f.end2, s.frame, v3.mul(n, -1), report, "Direção 2");
  if (f.end.type === "throughAll" && f.op === "cut" && !f.end2) d1 = modelSize(ctx, [s.frame.o]);
  if (d1 + d2 <= 1e-9) throw new Error("Profundidade total nula");
  const { faces } = profileFaces(ctx, f.sketch, f.regions, d2 > 0 ? { translate: v3.mul(n, -d2) } : null, report);
  const prisms = faces.map((p) => facePrism(p, v3.mul(n, d1 + d2), f.id));
  let tool = f.regions?.length ? fuseTools(prisms, f.id) : compoundBodies(prisms);

  const draft = evalParam(f.draft, ctx.scope, "Inclinação", 0);
  if (Math.abs(draft) > 1e-9) tool = draftSides(tool, f.id, s.frame, n, draft);

  ctx.tools.set(f.id, { body: tool, op: f.op });
  const body = applyOp(ctx, tool, f.op, f.id);
  return { ...ctx, body };
};

/** Inclinação das faces laterais em relação ao plano do esboço (positivo = estreita ao afastar-se). */
function draftSides(tool: NamedBody, fid: string, frame: Frame, n: Vec3, angleDeg: number): NamedBody {
  const o = oc();
  const builder = T(new o.BRepOffsetAPI_DraftAngle(tool.shape));
  const sides = tool.faces.filter((x) => x.name.startsWith(`${fid}:side:`));
  for (const s of sides) builder.Add(s.face, gpDir(n), (-angleDeg * Math.PI) / 180, gpPln(frame.o, n), true);
  builder.Build();
  if (!builder.IsDone()) throw new Error("A inclinação das faces laterais falhou");
  return nameResult(builder, tool.faces, T(builder.Shape()), fid);
}

export const revolve: Step<RevolveFeature & Feature> = (ctx, f, report) => {
  const s = sketchOf(ctx, f.sketch);
  const axis = axisOf(ctx, f.axis, report);
  let angle = evalParam(f.angle, ctx.scope, "Ângulo");
  if (angle <= 0 || angle > 360) throw new Error("Ângulo: tem de estar entre 0 e 360°");
  if (f.flip) angle = -angle;
  const full = Math.abs(Math.abs(angle) - 360) < 1e-9;
  const frame = f.midplane && !full ? rotateFrame(s.frame, axis, (-angle / 2) * (Math.PI / 180)) : s.frame;
  const endFrame = rotateFrame(frame, axis, (angle * Math.PI) / 180);
  const mv: Move = frame === s.frame ? null : { rotate: { o: axis.o, d: axis.d, rad: (-angle / 2) * (Math.PI / 180) } };
  const { faces } = profileFaces(ctx, f.sketch, f.regions, mv, report);
  const parts = faces.map((pf) => {
    const { face, edgeMap } = pf;
    const mk = T(new (oc().BRepPrimAPI_MakeRevol)(face, gpAx1(axis.o, axis.d), (angle * Math.PI) / 180, false));
    const shape = T(mk.Shape());
    if (!isValid(shape)) throw new Error("A revolução gerou um sólido inválido (o eixo interseta o perfil?)");
    const known = generatedNames(mk, edgeMap, `${f.id}:side`);
    const containing = [...edgeMap].map(([edge, ent]) => ({ edge, name: `${f.id}:side:${ent}` }));
    return nameFrom(shape, f.id, known, full ? undefined : capsByPlane(frame, endFrame, pf.key, f.id), containing);
  });
  const tool = f.regions?.length ? fuseTools(parts, f.id) : compoundBodies(parts);
  ctx.tools.set(f.id, { body: tool, op: f.op });
  return { ...ctx, body: applyOp(ctx, tool, f.op, f.id) };
};

export const sweep: Step<SweepFeature & Feature> = (ctx, f) => {
  const { s, regions } = closedRegions(ctx, f.profile);
  const path = sketchOf(ctx, f.path);
  const chain = path.profiles.chains[0];
  if (!chain) throw new Error(`O esboço de caminho "${featureName(ctx, f.path)}" está vazio`);
  if (path.profiles.chains.length > 1) throw new Error("O caminho tem de ser uma única cadeia de entidades");
  const spine = chainWire(chain, path.frame);
  const o = oc();
  const sweepLoop = (segs: Region["outer"]["segs"], key: string) => {
    const wire = loopWire(segs, s.frame);
    const edgeMap = mapEdgesToEntities(wire.wrapped, segs, s.frame) as Map<TopoDS_Shape, string>;
    const mk = T(new o.BRepOffsetAPI_MakePipeShell(spine.wrapped));
    mk.SetMode(f.orientation !== "fixed");
    mk.Add(wire.wrapped, false, false);
    mk.Build();
    if (!mk.IsDone()) throw new Error("O varrimento falhou (perfil demasiado grande para a curvatura do caminho?)");
    mk.MakeSolid();
    const shape = T(mk.Shape());
    const known = generatedNames(mk, edgeMap, `${f.id}:side`);
    const startFrame = s.frame;
    return nameFrom(shape, f.id, known, (face) => {
      const p = faceProps(face);
      if (p.type !== "plane") return undefined;
      const onStart = Math.abs(v3.dot(v3.sub(p.center, startFrame.o), startFrame.z)) < 1e-6;
      return onStart ? `${f.id}:start:${key}` : `${f.id}:end:${key}`;
    });
  };
  const parts = regions.map((r) => {
    let body = sweepLoop(r.outer.segs, r.key);
    for (const h of r.holes) {
      const hole = sweepLoop(h.segs, h.segs.map((x) => x.entity).sort()[0]);
      body = applyOp({ ...ctx, body }, hole, "cut", f.id);
    }
    return body;
  });
  const tool = compoundBodies(parts);
  ctx.tools.set(f.id, { body: tool, op: f.op });
  return { ...ctx, body: applyOp(ctx, tool, f.op, f.id) };
};

export const loft: Step<LoftFeature & Feature> = (ctx, f, report) => {
  if (f.sections.length < 2) throw new Error("O loft precisa de pelo menos 2 secções");
  const o = oc();
  const mk = T(new o.BRepOffsetAPI_ThruSections(true, !!f.ruled, 1e-6));
  let firstMap: Map<TopoDS_Shape, string> | undefined;
  const frames: Frame[] = [];
  for (const id of f.sections) {
    const { s, regions } = closedRegions(ctx, id);
    if (regions.length > 1) throw new Error(`Secção "${featureName(ctx, id)}": só um contorno por secção`);
    if (regions[0].holes.length) report.warnings.push(`Secção "${featureName(ctx, id)}": os furos são ignorados no loft`);
    const wire = loopWire(regions[0].outer.segs, s.frame);
    firstMap ??= mapEdgesToEntities(wire.wrapped, regions[0].outer.segs, s.frame) as Map<TopoDS_Shape, string>;
    frames.push(s.frame);
    mk.AddWire(wire.wrapped);
  }
  mk.CheckCompatibility(false);
  mk.Build();
  if (!mk.IsDone()) throw new Error("O loft falhou (secções incompatíveis?)");
  const shape = T(mk.Shape());
  const known = generatedNames(mk, firstMap!, `${f.id}:side`);
  const tool = nameFrom(shape, f.id, known, capsByPlane(frames[0], frames.at(-1), "s", f.id));
  ctx.tools.set(f.id, { body: tool, op: f.op });
  return { ...ctx, body: applyOp(ctx, tool, f.op, f.id) };
};

/**
 * Nervura: o contorno aberto ganha espessura (simétrica ao plano do esboço) e é prolongado,
 * no plano do esboço, até encontrar o corpo. Só a parte entre o contorno e o corpo é adicionada.
 * O lado do material é escolhido automaticamente (o que fecha contra o corpo); `flip` troca a preferência.
 */
export const rib: Step<RibFeature & Feature> = (ctx, f) => {
  if (!ctx.body) throw new Error("A nervura precisa de um corpo existente");
  const s = sketchOf(ctx, f.sketch);
  const chain = s.profiles.chains.find((c) => !c.closed);
  if (!chain) throw new Error("A nervura precisa de um contorno aberto");
  const t = evalParam(f.thickness, ctx.scope, "Espessura");
  if (t <= 0) throw new Error("Espessura: tem de ser positiva");
  const first = chain.segs[0], last = chain.segs[chain.segs.length - 1];
  const endPt = (seg: typeof first, end: boolean): [number, number] =>
    seg.kind === "line" ? (end ? seg.b : seg.a) : seg.kind === "arc" ? (end ? seg.to : seg.from) : seg.kind === "spline" ? (end ? seg.beziers.at(-1)![3] : seg.beziers[0][0]) : seg.c;
  const a = endPt(first, false), b = endPt(last, true);
  const L2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L2 < 1e-9) throw new Error("Contorno da nervura degenerado");
  const perp: [number, number] = [-(b[1] - a[1]) / L2, (b[0] - a[0]) / L2];
  const far = modelSize(ctx, [s.frame.o]);
  const o = oc();
  const bodyShape = ctx.body.shape;
  const contour = chainWire(chain, s.frame);
  const wire = chainWire(chain, offsetFrame(s.frame, -t / 2));

  const attempt = (sign: number): TopoDS_Shape[] => {
    const dir = v3.mul(v3.sub(to3D(s.frame, perp), s.frame.o), sign);
    const sheet = T(T(new o.BRepPrimAPI_MakePrism(wire.wrapped, gpVec(v3.mul(dir, far)), false, true)).Shape());
    const slab = T(T(new o.BRepPrimAPI_MakePrism(sheet, gpVec(v3.mul(s.frame.z, t)), false, true)).Shape());
    const cut = T(new o.BRepAlgoAPI_Cut(slab, bodyShape));
    cut.Build();
    if (!cut.IsDone()) return [];
    // fica a parte que toca no contorno e no corpo, e que não foge até ao infinito
    return explore(T(cut.Shape()), "solid").filter((p) => {
      if (distance(p, contour.wrapped) > 1e-6 || distance(p, bodyShape) > 1e-6) return false;
      const { min, max } = bbox(p);
      const reach = Math.max(...[min, max].flatMap((x) => [min, max].map((y) => [x[0], y[1], x[2]] as Vec3)).map((c) => v3.dot(v3.sub(c, s.frame.o), dir)));
      return reach < far * 0.5;
    });
  };
  const order = f.flip ? [-1, 1] : [1, -1];
  let pieces = attempt(order[0]);
  if (!pieces.length) pieces = attempt(order[1]);
  if (!pieces.length) throw new Error("A nervura não fecha contra o corpo em nenhum dos lados");
  const shape = pieces.length === 1 ? pieces[0] : makeCompound(pieces);
  const tool = nameFrom(shape, f.id, []);
  for (const nf of tool.faces) nf.name = nf.name.replace(`${f.id}:u`, `${f.id}:rib`);
  ctx.tools.set(f.id, { body: tool, op: "add" });
  return { ...ctx, body: applyOp(ctx, tool, "add", f.id) };
};

export { compoundBodies, nameFrom, generatedNames };
