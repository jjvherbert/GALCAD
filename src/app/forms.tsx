// Campos reutilizáveis do painel de propriedades.
import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { AxisRef, CadDocument, EndCondition, Expr, FeatureType, PlaneRef, TopoRef } from "../doc/types.ts";
import { evalExpr } from "../doc/expr.ts";
import { FEATURE_LABELS } from "../doc/features.ts";
import { type Pick, pickHandlers, store, useStore } from "./store.ts";

const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 4 });

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
  const st = useStore();
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
function usePickTarget(field: string, onPick: (p: Pick) => void) {
  pickHandlers.set(field, onPick);
  useEffect(() => () => {
    pickHandlers.delete(field);
    if (store.state.pickTarget?.field === field) store.set({ pickTarget: null });
  }, []);
}

/** Lista de referências a faces/arestas escolhidas no 3D. */
export function RefList({ field, label, accept, refs, onChange, single }: { field: string; label: string; accept: ("face" | "edge")[]; refs: TopoRef[]; onChange: (r: TopoRef[]) => void; single?: boolean }) {
  const st = useStore();
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => {
    if (p.kind !== "face" && p.kind !== "edge") return;
    const ref: TopoRef = { kind: p.kind, name: p.name, hint: p.hint };
    const has = refs.some((r) => r.name === p.name);
    onChange(single ? [ref] : has ? refs.filter((r) => r.name !== p.name) : [...refs, ref]);
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

/** Esboço de entrada (dropdown dos esboços anteriores). */
export function SketchSelect({ label, value, onChange, before }: { label: string; value: string; onChange: (v: string) => void; before: number }) {
  const st = useStore();
  const sketches = st.doc.features.slice(0, before).filter((f) => f.type === "sketch");
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">— escolher —</option>
        {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Field>
  );
}

const planeKey = (p: PlaneRef) => (p.kind === "std" ? `std:${p.name}` : p.kind === "datum" ? `datum:${p.feature}` : p.kind === "csys" ? `csys:${p.feature}:${p.name}` : "face");

export function PlaneSelect({ field, label, value, onChange, before }: { field: string; label: string; value: PlaneRef; onChange: (v: PlaneRef) => void; before: number }) {
  const st = useStore();
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => {
    if (p.kind === "plane") onChange(p.ref);
    else if (p.kind === "face") {
      if (p.type !== "plane") { store.set({ message: "Escolha uma face plana" }); return; }
      onChange({ kind: "face", ref: { kind: "face", name: p.name, hint: p.hint } });
    }
    store.set({ pickTarget: null });
  });
  const prior = st.doc.features.slice(0, before);
  const opts: [string, string, PlaneRef][] = [
    ...(["XY", "XZ", "YZ"] as const).map((n) => [`std:${n}`, `Plano ${n}`, { kind: "std", name: n }] as [string, string, PlaneRef]),
    ...prior.filter((f) => f.type === "plane").map((f) => [`datum:${f.id}`, f.name, { kind: "datum", feature: f.id }] as [string, string, PlaneRef]),
    ...prior.filter((f) => f.type === "csys").flatMap((f) => (["XY", "XZ", "YZ"] as const).map((n) => [`csys:${f.id}:${n}`, `${f.name} · ${n}`, { kind: "csys", feature: f.id, name: n }] as [string, string, PlaneRef])),
  ];
  const key = planeKey(value);
  return (
    <Field label={label}>
      <div class="row">
        <select value={key} onChange={(e) => { const o = opts.find((x) => x[0] === (e.target as HTMLSelectElement).value); if (o) onChange(o[2]); }}>
          {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          {value.kind === "face" && <option value="face">Face: {describeName(st.doc, value.ref.name)}</option>}
        </select>
        <button class={`small ${active ? "on" : ""}`} onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["face", "plane"] } })} title="Escolher uma face plana ou um plano no modelo">{active ? "…" : "Escolher"}</button>
      </div>
    </Field>
  );
}

export function AxisSelect({ field, label, value, onChange, before, sketch }: { field: string; label: string; value: AxisRef; onChange: (v: AxisRef) => void; before: number; sketch?: string }) {
  const st = useStore();
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => {
    if (p.kind !== "edge") return;
    if (p.type !== "line" && p.type !== "circle") { store.set({ message: "Escolha uma aresta reta ou circular" }); return; }
    onChange({ kind: "edge", ref: { kind: "edge", name: p.name, hint: p.hint } });
    store.set({ pickTarget: null });
  });
  const prior = st.doc.features.slice(0, before);
  const opts: [string, string, AxisRef][] = [
    ...(["X", "Y", "Z"] as const).map((n) => [`std:${n}`, `Eixo ${n}`, { kind: "std", name: n }] as [string, string, AxisRef]),
    ...prior.filter((f) => f.type === "axis").map((f) => [`datum:${f.id}`, f.name, { kind: "datum", feature: f.id }] as [string, string, AxisRef]),
    ...prior.filter((f) => f.type === "csys").flatMap((f) => (["X", "Y", "Z"] as const).map((n) => [`csys:${f.id}:${n}`, `${f.name} · ${n}`, { kind: "csys", feature: f.id, name: n }] as [string, string, AxisRef])),
  ];
  // linhas do esboço (de construção primeiro), úteis para eixos de revolução
  for (const f of prior) {
    if (f.type !== "sketch" || (sketch && f.id !== sketch)) continue;
    for (const [id, e] of Object.entries(f.entities)) {
      if (e.type === "line") opts.push([`sk:${f.id}:${id}`, `${f.name} · linha ${id}${e.construction ? " (construção)" : ""}`, { kind: "sketchLine", sketch: f.id, entity: id }]);
    }
  }
  const key = value.kind === "std" ? `std:${value.name}` : value.kind === "datum" ? `datum:${value.feature}` : value.kind === "csys" ? `csys:${value.feature}:${value.name}` : value.kind === "sketchLine" ? `sk:${value.sketch}:${value.entity}` : "edge";
  return (
    <Field label={label}>
      <div class="row">
        <select value={key} onChange={(e) => { const o = opts.find((x) => x[0] === (e.target as HTMLSelectElement).value); if (o) onChange(o[2]); }}>
          {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          {value.kind === "edge" && <option value="edge">Aresta: {describeName(st.doc, value.ref.name)}</option>}
        </select>
        <button class={`small ${active ? "on" : ""}`} onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["edge"] } })} title="Escolher uma aresta reta ou circular">{active ? "…" : "Aresta"}</button>
      </div>
    </Field>
  );
}

/** Seleção múltipla de features anteriores (padrões, espelho, loft). */
export function FeatureChecklist({ label, value, onChange, before, types, ordered }: { label: string; value: string[]; onChange: (v: string[]) => void; before: number; types: FeatureType[]; ordered?: boolean }) {
  const st = useStore();
  const cands = st.doc.features.slice(0, before).filter((f) => types.includes(f.type) && !f.suppressed);
  return (
    <fieldset class="checklist">
      <legend class="field-label">{label}</legend>
      {cands.map((f) => (
        <label key={f.id} class="check">
          <input type="checkbox" checked={value.includes(f.id)} onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...value, f.id] : value.filter((x) => x !== f.id))} />
          {ordered && value.includes(f.id) ? <b>{value.indexOf(f.id) + 1}.</b> : null} {f.name} <span class="muted">({FEATURE_LABELS[f.type]})</span>
        </label>
      ))}
      {!cands.length && <p class="muted">Nenhuma disponível</p>}
    </fieldset>
  );
}

export function EndEditor({ label, value, onChange, field, allowMid = true, optional }: { label: string; value: EndCondition | undefined; onChange: (v: EndCondition | undefined) => void; field: string; allowMid?: boolean; optional?: boolean }) {
  const type = value?.type ?? "none";
  const opts: [string, string][] = [
    ...(optional ? [["none", "Nenhuma"] as [string, string]] : []),
    ["blind", "Cega (profundidade)"],
    ...(allowMid ? [["midplane", "Simétrica ao plano"] as [string, string]] : []),
    ["throughAll", "Através de tudo"],
    ["upToFace", "Até à face"],
  ];
  const depth = value && "depth" in value ? value.depth : 10;
  return (
    <div class="fgroup">
      <Select label={label} value={type} options={opts} onChange={(t) => {
        if (t === "none") onChange(undefined);
        else if (t === "blind" || t === "midplane") onChange({ type: t, depth });
        else if (t === "throughAll") onChange({ type: t });
        else onChange({ type: "upToFace", face: { kind: "face", name: "" } });
      }} />
      {(value?.type === "blind" || value?.type === "midplane") && <ExprInput label="Profundidade" value={value.depth} onChange={(d) => onChange({ ...value, depth: d ?? "" })} />}
      {value?.type === "upToFace" && (
        <>
          <RefList field={`${field}-face`} label="Face de fim (plana)" accept={["face"]} single refs={value.face.name ? [value.face] : []} onChange={(r) => onChange({ ...value, face: r[0] ?? { kind: "face", name: "" } })} />
          <ExprInput label="Desvio" value={value.offset} allowEmpty onChange={(o) => onChange({ ...value, offset: o })} />
        </>
      )}
    </div>
  );
}
