// Campos do painel de propriedades: seleção de esboços, planos, eixos, features e condições de fim.
import type { AxisRef, EndCondition, FeatureType, PlaneRef } from "../doc/types.ts";
import { FEATURE_LABELS } from "../doc/features.ts";
import { store, useStoreKeys } from "./store.ts";
import { ExprInput, Field, RefList, Select, describeName, usePickTarget } from "./forms-base.tsx";

/** Esboço de entrada (dropdown dos esboços anteriores). */
export function SketchSelect({ label, value, onChange, before }: { label: string; value: string; onChange: (v: string) => void; before: number }) {
  const st = useStoreKeys("doc");
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
  const st = useStoreKeys("pickTarget", "doc", "result");
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
    ...prior.filter((f) => f.type === "plane" || (f.type === "external" && st.result?.planes[f.id])).map((f) => [`datum:${f.id}`, f.name, { kind: "datum", feature: f.id }] as [string, string, PlaneRef]),
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
  const st = useStoreKeys("pickTarget", "doc", "result");
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
    ...prior.filter((f) => f.type === "axis" || (f.type === "external" && st.result?.axes[f.id])).map((f) => [`datum:${f.id}`, f.name, { kind: "datum", feature: f.id }] as [string, string, AxisRef]),
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
  const st = useStoreKeys("doc");
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
