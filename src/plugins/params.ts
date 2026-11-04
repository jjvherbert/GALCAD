// Schema dos parâmetros de plugin: avalia cada parâmetro declarado e verifica limites antes de construir.
import type { PluginKind } from "./types.ts";

const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 6 });

/** Valores numéricos dos parâmetros declarados em `kind` (os não declarados são ignorados). Erro claro se falhar o schema. */
export function evalPluginParams<V>(kind: PluginKind, raw: Record<string, V>, evaluate: (value: V | undefined, label: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, d] of Object.entries(kind.params)) {
    const v = evaluate(raw[key], d.label);
    const unit = d.unit ? ` ${d.unit}` : "";
    if (!Number.isFinite(v)) throw new Error(`${d.label}: valor inválido`);
    if (d.integer && !Number.isInteger(v)) throw new Error(`${d.label}: tem de ser inteiro (${fmt(v)})`);
    if (d.min !== undefined && v < d.min) throw new Error(`${d.label}: mínimo ${fmt(d.min)}${unit} (${fmt(v)}${unit})`);
    if (d.max !== undefined && v > d.max) throw new Error(`${d.label}: máximo ${fmt(d.max)}${unit} (${fmt(v)}${unit})`);
    out[key] = v;
  }
  return out;
}
