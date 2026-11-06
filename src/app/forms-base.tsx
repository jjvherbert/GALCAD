// Campos reutilizáveis do painel de propriedades: campos simples, nomes topológicos e seleção de referências.
import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { BodyOp, CadDocument, Expr, TopoRef } from "../doc/types.ts";
import { evalExpr } from "../doc/expr.ts";
import { type Pick, pickHandlers, store, useStoreKeys } from "./store.ts";

/** Operações booleanas de um corpo novo sobre o existente. */
export const OPS: [BodyOp, string][] = [["add", "Adicionar material"], ["cut", "Remover material (corte)"], ["intersect", "Intersetar"], ["new", "Corpo separado"]];

export const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 4 });

export function Field({ label, children, hint }: { label: string; children: ComponentChildren; hint?: string }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

/** Campo numérico que aceita expressões com variáveis ("L/2", "10 cm"). */
export function ExprInput({ label, value, onChange, unit = "mm", allowEmpty }: { label: string; value: Expr | undefined; onChange: (v: Expr | undefined) => void; unit?: string; allowEmpty?: boolean }) {
  const st = useStoreKeys("result");
  const text = value === undefined ? "" : String(value);
  let shown = "", err = "";
  if (text.trim()) {
    try {
      const v = evalExpr(typeof value === "number" ? value : text, (n) => st.result?.variables.values[n]);
      if (typeof value === "string" && !/^[-+]?[\d.]+$/.test(text)) shown = `= ${fmt(v)} ${unit}`;
    } catch (e) { err = (e as Error).message; }
  } else if (!allowEmpty) err = "Obrigatório";
  return (
    <Field label={label} hint={err || shown}>
      <div class={`expr ${err ? "invalid" : ""}`}>
        <input value={text} spellcheck={false} aria-invalid={!!err}
          onInput={(e) => {
            const t = (e.target as HTMLInputElement).value;
            const num = Number(t.replace(",", "."));
            onChange(t.trim() === "" ? (allowEmpty ? undefined : "") : /^[-+]?[\d.,]+$/.test(t.trim()) && Number.isFinite(num) ? num : t);
          }} />
        <span class="unit">{unit}</span>
      </div>
    </Field>
  );
}

export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value as T)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </Field>
  );
}

export function Check({ label, value, onChange }: { label: string; value: boolean | undefined; onChange: (v: boolean) => void }) {
  return (
    <label class="check">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      {label}
    </label>
  );
}

/** Nome legível de um nome topológico. */
export function describeName(doc: CadDocument, name: string): string {
  const fname = (id: string) => doc.features.find((f) => f.id === id)?.name ?? id;
  const edge = /^\{(.*)\}(#\d+)?$/.exec(name);
  if (edge) {
    const parts = splitTop(edge[1]).map((p) => describeName(doc, p));
    return `Aresta: ${parts.join(" / ")}`;
  }
  const m = /^(f\d+):(.*)$/.exec(name);
  if (!m) return name;
  const [, fid, rest] = m;
  const inst = /^i(\d+):(.*)$/.exec(rest);
  if (inst) return `${describeName(doc, inst[2])} (instância ${inst[1]} de ${fname(fid)})`;
  const role = rest.replace(/~\d+$/, "");
  const label =
    role.startsWith("side:") ? `lateral ${role.slice(5)}` :
    role.startsWith("end:") ? "topo" :
    role.startsWith("start:") ? "base" :
    role.startsWith("fil") ? "filete" :
    role.startsWith("ch") ? "chanfro" :
    role.startsWith("in:") ? "interior" :
    role.startsWith("rib") ? "nervura" :
    role.startsWith("imp") ? `importada ${role.slice(3)}` :
    /^p\d+:/.test(role) ? `furo ${role.split(":")[1]}` : role;
  return `${fname(fid)} · ${label}${/~\d+$/.test(rest) ? " (parte)" : ""}`;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let d = 0, cur = "";
  for (const ch of s) {
    if (ch === "{") d++;
    if (ch === "}") d--;
    if (ch === "&" && d === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Regista o handler de um campo de seleção no 3D; o campo fica ativo quando é o `pickTarget`. */
export function usePickTarget(field: string, onPick: (p: Pick) => void) {
  pickHandlers.set(field, onPick);
  useEffect(() => () => {
    pickHandlers.delete(field);
    if (store.state.pickTarget?.field === field) store.set({ pickTarget: null });
  }, []);
}

/** Lista de referências a faces/arestas escolhidas no 3D. */
export function RefList({ field, label, accept, refs, onChange, single }: { field: string; label: string; accept: ("face" | "edge")[]; refs: TopoRef[]; onChange: (r: TopoRef[]) => void; single?: boolean }) {
  const st = useStoreKeys("pickTarget", "doc");
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => {
    if (p.kind !== "face" && p.kind !== "edge") return;
    // na montagem, a face leva o caminho do componente: "c2/f2:side:l8" (estudos da montagem)
    const ref: TopoRef = { kind: p.kind, name: p.component ? `${p.component}/${p.name}` : p.name, hint: p.hint };
    const has = refs.some((r) => r.name === ref.name);
    onChange(single ? [ref] : has ? refs.filter((r) => r.name !== ref.name) : [...refs, ref]);
  });
  const what = accept.map((a) => (a === "face" ? "faces" : "arestas")).join(" ou ");
  return (
    <div class={`reflist ${active ? "active" : ""}`}>
      <div class="reflist-head">
        <span class="field-label">{label}</span>
        <button class="small" onClick={() => store.set({ pickTarget: active ? null : { field, accept } })}>{active ? "Concluir seleção" : `Selecionar ${what}`}</button>
      </div>
      {active && <p class="field-hint">Clique nas {what} no modelo (clique de novo para retirar).</p>}
      <ul>
        {refs.map((r) => (
          <li key={r.name} title={r.name}>
            <span>{describeName(st.doc, r.name)}</span>
            <button class="icon" aria-label="Retirar" onClick={() => onChange(refs.filter((x) => x !== r))}>✕</button>
          </li>
        ))}
        {!refs.length && <li class="muted">Nenhuma</li>}
      </ul>
    </div>
  );
}
