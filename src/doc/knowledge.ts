// Knowledgeware (Fase 4.4), puro: tabela de configurações (famílias de peças), regras que atribuem
// variáveis, verificações avaliadas depois da reconstrução e templates de features (PowerCopy/UDF).
import { ExprError, evalExpr, exprIdentifiers, type Scope } from "./expr.ts";
import { resolveVariables, type ResolvedVariables } from "./variables.ts";
import type { CadDocument, Check, ConfigTable, Feature, Rule, Variable } from "./types.ts";
import type { Component, FeatureTemplate, PartProperties, TemplateInput } from "./project.ts";
import { idsInName } from "./features.ts";

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

export const SUPPRESS_COL = "$s:";
export const PROP_COL = "$p:";
const PROP_KEYS = ["number", "description", "material", "density", "finish", "supplier"] as const;

/** Chave de peça de um componente: o id da peça, mais "#configuração" quando a escolhe. */
export const partKey = (c: Pick<Component, "ref" | "config">) => (c.config ? `${c.ref.id}#${c.config}` : c.ref.id);
export const splitPartKey = (key: string) => { const k = key.indexOf("#"); return k < 0 ? { id: key, config: undefined } : { id: key.slice(0, k), config: key.slice(k + 1) }; };

const isSuppressed = (v: string) => /^(s|1|sim|suprimir|suprimida|suppressed|true)$/i.test(v.trim());

/**
 * Documento com a configuração aplicada: variáveis com o valor da tabela, features suprimidas ou
 * ativas conforme as colunas "$s:id" e propriedades da peça das colunas "$p:chave".
 */
export function configuredDoc<D extends CadDocument & { properties?: PartProperties }>(doc: D, name = doc.configurations?.active): D {
  const t = doc.configurations;
  if (!t || !name) return doc;
  const row = t.rows.find((r) => r.name === name);
  if (!row) return doc;
  const val = (k: string) => { const x = row.values[k]; return x === undefined || x.trim() === "" ? undefined : x.trim(); };
  const variables = doc.variables.map((v) => { const x = val(v.name); return x === undefined ? v : { ...v, expr: x }; });
  const features = doc.features.map((f) => { const x = val(`${SUPPRESS_COL}${f.id}`); return x === undefined ? f : { ...f, suppressed: isSuppressed(x) }; });
  let properties = doc.properties;
  for (const k of PROP_KEYS) {
    const x = val(`${PROP_COL}${k}`);
    if (x !== undefined) properties = { ...properties, [k]: k === "density" ? Number(x.replace(",", ".")) : x };
  }
  return { ...doc, variables, features, properties };
}

/** Rótulo legível de uma coluna da tabela. */
export function columnLabel(doc: CadDocument, col: string): string {
  if (col.startsWith(SUPPRESS_COL)) return `Suprimir: ${doc.features.find((f) => f.id === col.slice(SUPPRESS_COL.length))?.name ?? col}`;
  if (col.startsWith(PROP_COL)) return `Propriedade: ${col.slice(PROP_COL.length)}`;
  return col;
}

/** Tabela em CSV (separador ";", como o Excel em pt-PT). */
export function tableToCSV(t: ConfigTable): string {
  const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [["Configuração", ...t.columns], ...t.rows.map((r) => [r.name, ...t.columns.map((c) => r.values[c] ?? "")])];
  return lines.map((l) => l.map(q).join(";")).join("\r\n");
}

/** Lê uma tabela CSV (";" ou ","), com a primeira coluna = nome da configuração. */
export function tableFromCSV(text: string, active?: string): ConfigTable {
  const rows = parseCSV(text.replace(/^﻿/, ""));
  if (rows.length < 1 || rows[0].length < 1) throw new Error("Tabela vazia");
  const columns = rows[0].slice(1).map((c) => c.trim()).filter(Boolean);
  const out = rows.slice(1).filter((r) => r[0]?.trim()).map((r) => ({
    name: r[0].trim(),
    values: Object.fromEntries(columns.map((c, i) => [c, (r[i + 1] ?? "").trim()])),
  }));
  const names = new Set<string>();
  for (const r of out) { if (names.has(r.name)) throw new Error(`Configuração repetida: "${r.name}"`); names.add(r.name); }
  return { active: out.some((r) => r.name === active) ? active : out[0]?.name, columns, rows: out };
}

function parseCSV(text: string): string[][] {
  const sep = (text.split(/\r?\n/)[0].match(/;/g)?.length ?? 0) >= (text.split(/\r?\n/)[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

export interface RuleStatus {
  name: string;
  /** true = condição verdadeira; false = falsa (aplicou o "senão", se houver); null = desativada. */
  fired: boolean | null;
  error?: string;
}

/**
 * Resolve as variáveis e aplica as regras por ordem, até ficarem estáveis: as variáveis atribuídas
 * por regras ficam com o valor imposto e as que dependem delas são recalculadas. Uma regra que leia
 * uma variável que outra regra altera vê o valor já propagado da iteração anterior.
 */
export function resolveWithRules(vars: Variable[], rules: Rule[] = []): ResolvedVariables & { rules: RuleStatus[] } {
  let res = resolveVariables(vars);
  if (!rules.length) return { ...res, rules: [] };
  const names = new Set(vars.map((v) => v.name));
  let prev = new Map<string, number>();
  let statuses: RuleStatus[] = [];
  for (let it = 0; it < 12; it++) {
    const over = new Map<string, number>();
    const scope: Scope = (n) => over.get(n) ?? res.values.get(n);
    statuses = rules.map((r) => {
      if (r.disabled) return { name: r.name, fired: null };
      try {
        const cond = r.condition?.trim() ? evalExpr(r.condition, scope) !== 0 : true;
        for (const a of cond ? r.assign : r.otherwise ?? []) {
          if (!names.has(a.variable)) throw new ExprError(`Variável desconhecida "${a.variable}"`, 0);
          over.set(a.variable, evalExpr(a.expr, scope));
        }
        return { name: r.name, fired: cond };
      } catch (e) {
        return { name: r.name, fired: null, error: (e as Error).message };
      }
    });
    res = resolveVariables(vars.map((v) => (over.has(v.name) ? { ...v, expr: String(over.get(v.name)) } : v)));
    const same = over.size === prev.size && [...over].every(([k, v]) => prev.has(k) && Math.abs(prev.get(k)! - v) <= 1e-12 * Math.max(1, Math.abs(v)));
    if (same) return { ...res, rules: statuses };
    prev = over;
  }
  return { ...res, rules: statuses.map((s) => (s.fired === null ? s : { ...s, error: "As regras não estabilizam (alternam entre valores)" })) };
}

// ---------------------------------------------------------------------------
// Verificações
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  severity: Check["severity"];
  message?: string;
  error?: string;
}

/** Medidas do modelo disponíveis nas verificações (mm, mm², mm³, g). */
export const MEASURE_NAMES = ["volume", "area", "massa", "dimX", "dimY", "dimZ"] as const;

export function runChecks(checks: Check[] = [], scope: Scope): CheckResult[] {
  return checks.map((c) => {
    try {
      return { name: c.name, ok: evalExpr(c.expr, scope) !== 0, severity: c.severity, message: c.message };
    } catch (e) {
      return { name: c.name, ok: false, severity: c.severity, message: c.message, error: (e as Error).message };
    }
  });
}

// ---------------------------------------------------------------------------
// Templates de features (PowerCopy / UDF)
// ---------------------------------------------------------------------------

type Json = unknown;
const isTopo = (x: Json): x is { kind: "face" | "edge"; name: string } =>
  !!x && typeof x === "object" && ((x as { kind?: string }).kind === "face" || (x as { kind?: string }).kind === "edge") && typeof (x as { name?: unknown }).name === "string";

/** Percorre os valores de um objeto JSON (chaves e pais incluídos), sem descer nos nomes topológicos. */
function walk(x: Json, visit: (v: Json, key: string, parent: Json) => void, key = "", parent: Json = null) {
  visit(x, key, parent);
  if (isTopo(x)) return;
  if (Array.isArray(x)) x.forEach((v, i) => walk(v, visit, String(i), x));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, visit, k, x);
}

/** Identificadores (variáveis) usados em textos que são expressões válidas. */
function exprNames(s: string): Set<string> {
  try { return exprIdentifiers(s); } catch { return new Set(); }
}

/**
 * Cria um template com as features escolhidas (pela ordem do documento): as referências a features
 * e a faces/arestas de fora do grupo passam a entradas; as variáveis usadas (e as de que dependem)
 * passam a parâmetros.
 */
export function makeTemplate(doc: CadDocument, ids: string[], name: string, id: string): FeatureTemplate {
  const features = doc.features.filter((f) => ids.includes(f.id));
  if (!features.length) throw new Error("Escolha as features do template");
  const inside = new Set(features.map((f) => f.id));
  const outside = new Map(doc.features.filter((f) => !inside.has(f.id)).map((f) => [f.id, f]));
  const inputs: TemplateInput[] = [];
  const add = (inp: TemplateInput) => { if (!inputs.some((x) => x.original === inp.original)) inputs.push(inp); };
  const used = new Set<string>();
  const varNames = new Set(doc.variables.map((v) => v.name));
  for (const f of features) {
    walk(f, (v, key, parent) => {
      if (isTopo(v)) {
        if ([...idsInName(v.name)].some((x) => !inside.has(x))) add({ key: `in${inputs.length + 1}`, label: `${v.kind === "face" ? "Face" : "Aresta"} ${v.name}`, kind: v.kind, original: v.name });
        return;
      }
      if (typeof v !== "string") return;
      if (parent === f && (key === "name" || key === "id")) return;
      const ext = outside.get(v);
      if (ext) { add({ key: `in${inputs.length + 1}`, label: `${ext.name}`, kind: "feature", type: ext.type, original: v }); return; }
      for (const n of exprNames(v)) if (varNames.has(n)) used.add(n);
    });
  }
  // dependências entre variáveis: o template leva tudo o que precisa
  const byName = new Map(doc.variables.map((v) => [v.name, v]));
  const queue = [...used];
  while (queue.length) {
    const n = queue.pop()!;
    for (const d of exprNames(byName.get(n)!.expr)) if (byName.has(d) && !used.has(d)) { used.add(d); queue.push(d); }
  }
  const parameters = doc.variables.filter((v) => used.has(v.name)).map((v) => ({ ...v }));
  return { id, name, features: JSON.parse(JSON.stringify(features)), inputs, parameters };
}

const wordRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "gu");

/**
 * Instancia um template num documento: novas ids para as features, entradas substituídas pelas
 * escolhas (`bindings`: chave da entrada → id de feature ou nome topológico) e parâmetros criados
 * como variáveis novas (com sufixo se o nome já existir), com os valores dados.
 */
export function instantiateTemplate(
  doc: CadDocument, tpl: FeatureTemplate, bindings: Record<string, string>, values: Record<string, string> = {},
): { doc: CadDocument; created: string[] } {
  for (const inp of tpl.inputs) if (!bindings[inp.key]) throw new Error(`Falta escolher a entrada "${inp.label}"`);
  let n = doc.features.reduce((m, f) => Math.max(m, Number(/^f(\d+)$/.exec(f.id)?.[1] ?? 0)), 0);
  const idMap = new Map(tpl.features.map((f) => [f.id, `f${++n}`]));
  // parâmetros: nomes únicos no documento
  const taken = new Set(doc.variables.map((v) => v.name));
  const rename = new Map<string, string>();
  for (const p of tpl.parameters) {
    let nm = p.name, k = 2;
    while (taken.has(nm)) nm = `${p.name}_${k++}`;
    taken.add(nm);
    rename.set(p.name, nm);
  }
  const renameExpr = (s: string) => {
    let out = s;
    for (const [a, b] of rename) if (a !== b) out = out.replace(wordRe(a), b);
    return out;
  };
  const newVars: Variable[] = tpl.parameters.map((p) => ({ ...p, name: rename.get(p.name)!, expr: renameExpr(values[p.name]?.trim() || p.expr) }));
  const inputByOriginal = new Map(tpl.inputs.map((i) => [i.original, bindings[i.key]]));
  const remapName = (name: string) => inputByOriginal.get(name) ?? name.replace(/\bf\d+(?=:)/g, (m) => idMap.get(m) ?? m);
  const count = doc.features.filter((f) => f.name.includes(`(${tpl.name}`)).length;
  const suffix = ` (${tpl.name} ${Math.floor(count / Math.max(1, tpl.features.length)) + 1})`;
  const clone = (x: Json, key: string): Json => {
    if (isTopo(x)) {
      const name = remapName(x.name);
      const out: Record<string, unknown> = { ...x, name };
      if (name !== x.name && inputByOriginal.has(x.name)) delete out.hint; // a pista geométrica era da referência original
      return out;
    }
    if (Array.isArray(x)) return x.map((v, i) => clone(v, String(i)));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clone(v, k)]));
    if (typeof x !== "string") return x;
    if (key === "name") return x;
    if (inputByOriginal.has(x)) return inputByOriginal.get(x)!;
    if (idMap.has(x)) return idMap.get(x)!;
    return rename.size && exprNames(x).size ? renameExpr(x) : x;
  };
  const features = tpl.features.map((f) => ({ ...(clone(f, "") as Feature), id: idMap.get(f.id)!, name: `${f.name}${suffix}` }));
  return { doc: { ...doc, variables: [...doc.variables, ...newVars], features: [...doc.features, ...features], rollback: undefined }, created: features.map((f) => f.id) };
}
