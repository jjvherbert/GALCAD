// Catálogo de features: nomes, dependências e validação de ordem.
import type { AxisRef, CadDocument, CurveRef, EndCondition, Feature, FeatureType, PlaneRef, SurfaceTarget, SweepOptions, TopoRef } from "./types.ts";

export const FEATURE_LABELS: Record<FeatureType, string> = {
  sketch: "Esboço",
  extrude: "Extrusão",
  revolve: "Revolução",
  sweep: "Varrimento",
  loft: "Loft",
  hole: "Furo",
  fillet: "Filete",
  chamfer: "Chanfro",
  shell: "Casca",
  draft: "Inclinação",
  rib: "Nervura",
  linearPattern: "Padrão linear",
  circularPattern: "Padrão circular",
  mirror: "Espelho",
  plane: "Plano",
  axis: "Eixo",
  csys: "Sistema de coordenadas",
  import: "Importação",
  plugin: "Plugin",
  surfaceExtrude: "Superfície extrudida",
  surfaceRevolve: "Superfície de revolução",
  surfaceSweep: "Superfície varrida",
  surfaceLoft: "Superfície loft",
  fill: "Preenchimento",
  offsetSurface: "Superfície deslocada",
  knit: "Costura",
  thicken: "Espessar",
  trimSurface: "Aparar superfície",
  deleteFace: "Apagar face",
  curve: "Curva 3D",
  boundary: "Superfície limite",
  ruled: "Superfície regrada",
  untrim: "Desaparar superfície",
  replaceFace: "Substituir face",
  multiSection: "Multi-secção",
  blend: "Concordância",
  circleSweep: "Varrimento circular",
  extrapolate: "Extrapolar",
  heal: "Curar",
  freeform: "Forma livre (polos)",
};

export function featureLabel(f: Feature): string {
  if ((f.type === "extrude" || f.type === "revolve" || f.type === "sweep" || f.type === "loft") && f.op === "cut") {
    return { extrude: "Corte extrudido", revolve: "Corte por revolução", sweep: "Corte por varrimento", loft: "Corte por loft" }[f.type];
  }
  return FEATURE_LABELS[f.type];
}

/** Features cujo sólido-ferramenta pode ser repetido por padrões e espelho. */
export const TOOL_FEATURES: ReadonlySet<FeatureType> = new Set(["extrude", "revolve", "sweep", "loft", "hole", "rib"]);

/** Features do separador Superfícies (pela ordem da barra). */
export const SURFACE_TYPES: FeatureType[] = ["curve", "surfaceExtrude", "surfaceRevolve", "surfaceSweep", "surfaceLoft", "boundary", "fill", "ruled", "offsetSurface", "trimSurface", "untrim", "knit", "thicken", "replaceFace", "deleteFace", "multiSection", "blend", "circleSweep", "extrapolate", "heal", "freeform"];

/** Features que criam um corpo de superfície novo (com a chave do seu id). */
export const SHEET_SOURCES: FeatureType[] = ["surfaceExtrude", "surfaceRevolve", "surfaceSweep", "surfaceLoft", "boundary", "fill", "ruled", "offsetSurface", "untrim", "knit", "deleteFace", "linearPattern", "circularPattern", "mirror", "multiSection", "blend", "circleSweep", "extrapolate", "heal", "freeform"];

/** A feature cria um corpo de superfície com a chave do seu id (e não altera um existente)? */
export const createsSheet = (f: Feature) =>
  SHEET_SOURCES.includes(f.type) && !(f.type === "knit" && f.makeSolid) && !(f.type === "extrapolate" && f.assemble !== false);

export const FEATURE_ICONS: Record<FeatureType, string> = {
  sketch: "✎", extrude: "▮", revolve: "◐", sweep: "〰", loft: "⟁", hole: "⊚", fillet: "◜", chamfer: "◸", shell: "▢",
  draft: "⏢", rib: "⊿", linearPattern: "⁞", circularPattern: "✲", mirror: "⇋", plane: "▱", axis: "┆", csys: "⌖", import: "⇩", plugin: "⧉",
  surfaceExtrude: "⬒", surfaceRevolve: "◑", surfaceSweep: "≈", surfaceLoft: "⧖", fill: "⬠", offsetSurface: "⇶", knit: "⨝",
  thicken: "▤", trimSurface: "✂", deleteFace: "⌫", curve: "∿", boundary: "⬚", ruled: "⫼", untrim: "⤧", replaceFace: "⇄",
  multiSection: "⧗", blend: "⌒", circleSweep: "◯", extrapolate: "⇥", heal: "✚", freeform: "⌗",
};

/** Ids de features referidos num nome topológico (ex.: "f3:side:l2" → f3). */
export const idsInName = (name: string) => new Set(name.match(/\bf\d+(?=:)/g) ?? []);

const planeDeps = (p: PlaneRef | undefined, out: Set<string>) => {
  if (!p) return;
  if (p.kind === "datum" || p.kind === "csys") out.add(p.feature);
  else if (p.kind === "face") topoDeps(p.ref, out);
};
const axisDeps = (a: AxisRef | undefined, out: Set<string>) => {
  if (!a) return;
  if (a.kind === "datum" || a.kind === "csys") out.add(a.feature);
  else if (a.kind === "edge") topoDeps(a.ref, out);
  else if (a.kind === "sketchLine") out.add(a.sketch);
};
const topoDeps = (r: TopoRef | undefined, out: Set<string>) => { if (r) for (const id of idsInName(r.name)) out.add(id); };
const endDeps = (e: EndCondition | undefined, out: Set<string>) => { if (e?.type === "upToFace") topoDeps(e.face, out); };
const targetDeps = (t: SurfaceTarget, out: Set<string>) => {
  if (t.kind === "plane") planeDeps(t.plane, out);
  else if (t.kind === "sheet") out.add(t.sheet);
  else if (t.kind === "faces") t.faces.forEach((r) => topoDeps(r, out));
};
const curveDeps = (c: CurveRef | undefined, out: Set<string>) => {
  if (!c) return;
  if (c.kind === "curve") out.add(c.feature);
  else if (c.kind === "edge") topoDeps(c.ref, out);
  else out.add(c.sketch);
};

const sweepDeps = (f: SweepOptions, d: Set<string>) => {
  axisDeps(f.binormal, d);
  f.support?.forEach((r) => topoDeps(r, d));
  curveDeps(f.guide, d);
};

/** Features de que esta depende diretamente. */
export function dependencies(f: Feature): Set<string> {
  const d = new Set<string>();
  switch (f.type) {
    case "sketch":
      planeDeps(f.plane, d);
      for (const e of Object.values(f.entities)) if ("ext" in e) topoDeps(e.ext, d);
      break;
    case "extrude": d.add(f.sketch); endDeps(f.end, d); endDeps(f.end2, d); break;
    case "revolve": d.add(f.sketch); axisDeps(f.axis, d); break;
    case "sweep": d.add(f.profile); d.add(f.path); sweepDeps(f, d); break;
    case "loft": f.sections.forEach((s) => d.add(s)); break;
    case "hole": d.add(f.sketch); break;
    case "fillet": case "chamfer": f.refs.forEach((r) => topoDeps(r, d)); break;
    case "shell": f.faces.forEach((r) => topoDeps(r, d)); break;
    case "draft": f.faces.forEach((r) => topoDeps(r, d)); planeDeps(f.neutral, d); break;
    case "rib": d.add(f.sketch); break;
    case "linearPattern": f.features.forEach((x) => d.add(x)); axisDeps(f.direction, d); axisDeps(f.direction2, d); break;
    case "circularPattern": f.features.forEach((x) => d.add(x)); axisDeps(f.axis, d); break;
    case "mirror": f.features.forEach((x) => d.add(x)); planeDeps(f.plane, d); break;
    case "plane": planeDeps(f.base, d); axisDeps(f.axis, d); break;
    case "axis": f.planes?.forEach((p) => planeDeps(p, d)); topoDeps(f.edge, d); break;
    case "surfaceExtrude": d.add(f.sketch); break;
    case "surfaceRevolve": d.add(f.sketch); axisDeps(f.axis, d); break;
    case "surfaceSweep": d.add(f.profile); d.add(f.path); sweepDeps(f, d); break;
    case "surfaceLoft": f.sections.forEach((s) => d.add(s)); break;
    case "fill": f.edges.forEach((r) => topoDeps(r, d)); break;
    case "offsetSurface": case "deleteFace": f.faces.forEach((r) => topoDeps(r, d)); break;
    case "knit": f.sheets.forEach((s) => d.add(s)); break;
    case "thicken": d.add(f.sheet); break;
    case "trimSurface":
      d.add(f.sheet);
      if (f.tool.kind === "plane") planeDeps(f.tool.plane, d);
      else if (f.tool.kind === "sheet") d.add(f.tool.sheet);
      else d.add(f.tool.sketch);
      break;
    case "curve": {
      const c = f.def;
      if (c.kind === "projected") { d.add(c.sketch); targetDeps(c.onto, d); }
      else if (c.kind === "intersection") { targetDeps(c.a, d); targetDeps(c.b, d); }
      else if (c.kind === "composite") c.edges.forEach((r) => topoDeps(r, d));
      else if (c.kind === "helix") axisDeps(c.axis, d);
      else if (c.kind === "extend") curveDeps(c.curve, d);
      break;
    }
    case "boundary": [...f.dir1, ...f.dir2].forEach((c) => curveDeps(c, d)); break;
    case "ruled": f.edges.forEach((r) => topoDeps(r, d)); topoDeps(f.face, d); axisDeps(f.direction, d); break;
    case "untrim": f.faces.forEach((r) => topoDeps(r, d)); break;
    case "replaceFace": f.faces.forEach((r) => topoDeps(r, d)); d.add(f.sheet); break;
    case "multiSection":
      [...f.sections, ...(f.guides ?? [])].forEach((c) => curveDeps(c, d));
      curveDeps(f.spine, d); topoDeps(f.startTangent?.face, d); topoDeps(f.endTangent?.face, d);
      break;
    case "blend": for (const s of [f.side1, f.side2]) { curveDeps(s.curve, d); topoDeps(s.support, d); } break;
    case "circleSweep": f.guides.forEach((c) => curveDeps(c, d)); break;
    case "extrapolate": d.add(f.sheet); f.edges.forEach((r) => topoDeps(r, d)); break;
    case "heal": f.sheets.forEach((s) => d.add(s)); break;
    case "freeform": if (f.source.kind === "patch") planeDeps(f.source.plane, d); else topoDeps(f.source.face, d); break;
  }
  d.delete(f.id);
  return d;
}

/**
 * Dependências efetivas de cada feature, pela ordem do documento: as diretas e, para cada corpo de
 * superfície que consome, os aparares desse corpo que a precedem (o aparar mantém a chave do corpo).
 */
export function effectiveDependencies(features: Feature[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const trims = new Map<string, string[]>(); // corpo → aparares até aqui
  for (const f of features) {
    const d = dependencies(f);
    for (const x of [...d]) for (const t of trims.get(x) ?? []) if (t !== f.id) d.add(t);
    out.set(f.id, d);
    if (f.type === "trimSurface") {
      for (const key of f.mutual && f.tool.kind === "sheet" ? [f.sheet, f.tool.sheet] : [f.sheet]) trims.set(key, [...(trims.get(key) ?? []), f.id]);
    }
    // extrapolar (junto ao corpo) também altera o corpo mantendo a chave
    if (f.type === "extrapolate" && f.assemble !== false) trims.set(f.sheet, [...(trims.get(f.sheet) ?? []), f.id]);
  }
  return out;
}

/** Features que dependem (direta ou indiretamente) de `id`. */
export function dependents(doc: CadDocument, id: string): string[] {
  const deps = effectiveDependencies(doc.features);
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of doc.features) {
      if (out.has(f.id)) continue;
      if ([...deps.get(f.id)!].some((d) => out.has(d))) { out.add(f.id); grew = true; }
    }
  }
  out.delete(id);
  return [...out];
}

/** Valida a ordem: cada feature só pode depender de features anteriores. Devolve a lista de problemas. */
export function orderProblems(features: Feature[], deps = effectiveDependencies(features)): string[] {
  const seen = new Set<string>();
  const all = new Map(features.map((f) => [f.id, f]));
  const problems: string[] = [];
  for (const f of features) {
    for (const d of deps.get(f.id) ?? dependencies(f)) {
      if (all.has(d) && !seen.has(d)) problems.push(`"${f.name}" depende de "${all.get(d)!.name}", que vem depois`);
    }
    seen.add(f.id);
  }
  return problems;
}

/** Move uma feature para outro índice, se a ordem resultante for válida (com as dependências da ordem atual). */
export function moveFeature(doc: CadDocument, id: string, toIndex: number): CadDocument | string[] {
  const features = doc.features.slice();
  const from = features.findIndex((f) => f.id === id);
  if (from < 0) return ["Feature inexistente"];
  const deps = effectiveDependencies(features);
  const [f] = features.splice(from, 1);
  features.splice(Math.max(0, Math.min(toIndex, features.length)), 0, f);
  const problems = orderProblems(features, deps);
  return problems.length ? problems : { ...doc, features };
}
