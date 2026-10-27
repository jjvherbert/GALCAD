// Formato de projeto aberto (.cadp.json): o histórico de features em JSON legível.
import type { CadDocument, Feature, FeatureData, FeatureType } from "./types.ts";
import { FEATURE_LABELS } from "./features.ts";

export const FILE_EXTENSION = ".cadp.json";

export function newDocument(name = "Peça1"): CadDocument {
  return { format: "cadp", version: 1, name, units: "mm", variables: [], features: [] };
}

export function serialize(doc: CadDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function parseDocument(text: string): CadDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Ficheiro inválido: não é JSON (${(e as Error).message})`);
  }
  const d = raw as Partial<CadDocument>;
  if (!d || typeof d !== "object" || d.format !== "cadp") throw new Error("Ficheiro inválido: não é um projeto .cadp");
  if (d.version !== 1) throw new Error(`Versão de ficheiro não suportada: ${String(d.version)}`);
  if (!Array.isArray(d.features) || !Array.isArray(d.variables)) throw new Error("Ficheiro inválido: faltam features ou variáveis");
  const ids = new Set<string>();
  for (const f of d.features) {
    if (!f || typeof f.id !== "string" || !(f.type in FEATURE_LABELS)) throw new Error(`Feature inválida: ${JSON.stringify(f)?.slice(0, 80)}`);
    if (ids.has(f.id)) throw new Error(`Id de feature repetido: ${f.id}`);
    ids.add(f.id);
  }
  return { format: "cadp", version: 1, name: d.name ?? "Peça", units: "mm", variables: d.variables, features: d.features, rollback: d.rollback };
}

/** Próximo id de feature ("f1", "f2", …), nunca reutilizado dentro do documento. */
export function nextFeatureId(doc: CadDocument): string {
  const n = doc.features.reduce((m, f) => Math.max(m, Number(f.id.slice(1)) || 0), 0);
  return `f${n + 1}`;
}

/** Nome por defeito: "Extrusão3", contando as do mesmo tipo. */
export function defaultFeatureName(doc: CadDocument, type: FeatureType): string {
  // "Superfície de revolução" → "Superfície-revolução" (as palavras curtas caem, como no SolidWorks)
  const words = FEATURE_LABELS[type].split(/\s+/);
  const base = words.length > 1 ? words.filter((w, i) => i === 0 || w.length > 2).join("-") : words[0];
  const names = new Set(doc.features.map((f) => f.name));
  for (let i = 1; ; i++) if (!names.has(`${base}${i}`)) return `${base}${i}`;
}

/** Dados de uma feature nova (sem id; nome opcional). */
export type NewFeature = FeatureData & { name?: string; suppressed?: boolean };

export function addFeature(doc: CadDocument, f: NewFeature, index?: number): { doc: CadDocument; id: string } {
  const id = nextFeatureId(doc);
  const feature = { ...f, id, name: f.name ?? defaultFeatureName(doc, f.type) } as Feature;
  const features = doc.features.slice();
  const at = index ?? (doc.rollback !== undefined ? doc.rollback : features.length);
  features.splice(at, 0, feature);
  const rollback = doc.rollback !== undefined ? doc.rollback + 1 : undefined;
  return { doc: { ...doc, features, rollback }, id };
}

export function updateFeature(doc: CadDocument, id: string, patch: Partial<Feature>): CadDocument {
  return { ...doc, features: doc.features.map((f) => (f.id === id ? ({ ...f, ...patch } as Feature) : f)) };
}
