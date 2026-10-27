// Catálogo de features: nomes, dependências e validação de ordem.
import type { AxisRef, CadDocument, EndCondition, Feature, FeatureType, PlaneRef, TopoRef } from "./types.ts";

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
};

export function featureLabel(f: Feature): string {
  if ((f.type === "extrude" || f.type === "revolve" || f.type === "sweep" || f.type === "loft") && f.op === "cut") {
    return { extrude: "Corte extrudido", revolve: "Corte por revolução", sweep: "Corte por varrimento", loft: "Corte por loft" }[f.type];
  }
  return FEATURE_LABELS[f.type];
}

/** Features cujo sólido-ferramenta pode ser repetido por padrões e espelho. */
export const TOOL_FEATURES: ReadonlySet<FeatureType> = new Set(["extrude", "revolve", "sweep", "loft", "hole", "rib"]);

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
    case "sweep": d.add(f.profile); d.add(f.path); break;
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
  }
  d.delete(f.id);
  return d;
}

/** Features que dependem (direta ou indiretamente) de `id`. */
export function dependents(doc: CadDocument, id: string): string[] {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of doc.features) {
      if (out.has(f.id)) continue;
      if ([...dependencies(f)].some((d) => out.has(d))) { out.add(f.id); grew = true; }
    }
  }
  out.delete(id);
  return [...out];
}

/** Valida a ordem: cada feature só pode depender de features anteriores. Devolve a lista de problemas. */
export function orderProblems(features: Feature[]): string[] {
  const seen = new Set<string>();
  const all = new Map(features.map((f) => [f.id, f]));
  const problems: string[] = [];
  for (const f of features) {
    for (const d of dependencies(f)) {
      if (all.has(d) && !seen.has(d)) problems.push(`"${f.name}" depende de "${all.get(d)!.name}", que vem depois`);
    }
    seen.add(f.id);
  }
  return problems;
}

/** Move uma feature para outro índice, se a ordem resultante for válida. */
export function moveFeature(doc: CadDocument, id: string, toIndex: number): CadDocument | string[] {
  const features = doc.features.slice();
  const from = features.findIndex((f) => f.id === id);
  if (from < 0) return ["Feature inexistente"];
  const [f] = features.splice(from, 1);
  features.splice(Math.max(0, Math.min(toIndex, features.length)), 0, f);
  const problems = orderProblems(features);
  return problems.length ? problems : { ...doc, features };
}
