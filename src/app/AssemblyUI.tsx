// Interface da montagem: árvore (componentes e mates), painel de mate e painel de componente.
import { partKey } from "../doc/knowledge.ts";
import { useEffect, useState } from "preact/hooks";
import type { Component, Mate, MateKind, MateRef } from "../doc/project.ts";
import type { StdAxis, StdPlane } from "../doc/types.ts";
import { store, useStore } from "./store.ts";
import { Check, ExprInput, Field, Select, usePickTarget } from "./forms.tsx";

const fmt = (v: number, d = 2) => v.toLocaleString("pt-PT", { maximumFractionDigits: d });

export const MATE_LABELS: Record<MateKind, string> = {
  coincident: "Coincidente", concentric: "Concêntrico", parallel: "Paralelo", perpendicular: "Perpendicular",
  distance: "Distância", angle: "Ângulo", tangent: "Tangente", lock: "Fixar (bloquear)",
};
const MATE_ICONS: Record<MateKind, string> = { coincident: "⊼", concentric: "◎", parallel: "∥", perpendicular: "⟂", distance: "↔", angle: "∠", tangent: "◠", lock: "🔒" };
const STD: (StdPlane | StdAxis)[] = ["XY", "XZ", "YZ", "X", "Y", "Z"];

function compName(id: string) {
  if (id === "") return "Origem da montagem";
  return store.activeAssembly()?.components.find((c) => c.id === id)?.name ?? id;
}

export function refLabel(r: MateRef): string {
  const c = compName(r.component);
  if ("std" in r) return `${c} · ${r.std.length === 2 ? "plano" : "eixo"} ${r.std}`;
  return `${c} · ${r.ref.kind === "face" ? "face" : "aresta"} ${r.ref.name}`;
}

/** Árvore da montagem (FeatureManager da montagem). */
export function AssemblyTree() {
  const st = useStore();
  const a = store.activeAssembly();
  const [menu, setMenu] = useState(false);
  if (!a) return null;
  const r = st.asmResult;
  const p = st.project;
  const srcName = (c: Component) => (c.ref.kind === "part" ? p.parts : p.assemblies).find((x) => x.id === c.ref.id)?.name ?? "?";
  return (
    <div class="feature-tree assembly-tree" aria-label="Árvore da montagem">
      <div class="tree-head">
        <b>{a.name}</b>
        <span class={`muted ${r && !r.ok ? "err" : ""}`}>{r ? (r.ok ? (r.dof ? `${r.dof} grau(s) de liberdade livre(s)` : "Totalmente definida") : "Mates por resolver") : "…"}</span>
      </div>
      <div class="dropdown">
        <button class="small" onClick={() => setMenu(!menu)}>＋ Inserir componente</button>
        {menu && (
          <div class="menu" role="menu" onClick={() => setMenu(false)}>
            {p.parts.map((x) => <button role="menuitem" key={x.id} onClick={() => store.insertComponent({ kind: "part", id: x.id })}>▮ {x.name}</button>)}
            {p.assemblies.filter((x) => x.id !== a.id).map((x) => <button role="menuitem" key={x.id} onClick={() => store.insertComponent({ kind: "assembly", id: x.id })}>⧉ {x.name}</button>)}
          </div>
        )}
      </div>
      <h3>Componentes</h3>
      <ul class="tree">
        {a.components.map((c, i) => (
          <li key={c.id} class={`feat ${c.suppressed ? "suppressed" : ""} ${st.componentEdit === c.id ? "selected" : ""}`}
            onMouseEnter={() => store.set({ hoverFeature: `@${c.id}` })} onMouseLeave={() => store.set({ hoverFeature: null })}
            onDblClick={() => store.set({ componentEdit: c.id })}>
            <span class="ic">{c.ref.kind === "part" ? "▮" : "⧉"}</span>
            <span class="name">{(c.fixed ?? i === 0) ? "(f) " : ""}{c.name}</span>
            <span class="muted">{srcName(c)}{r?.partErrors[partKey(c)] ? " ⚠" : ""}</span>
            <span class="grow" />
            <button class="icon" title="Propriedades do componente" aria-label={`Propriedades de ${c.name}`} onClick={() => store.set({ componentEdit: c.id })}>⚙</button>
            {c.ref.kind === "part" && <button class="icon" title="Abrir a peça" aria-label={`Abrir ${srcName(c)}`} onClick={() => store.setActive({ kind: "part", id: c.ref.id })}>↗</button>}
          </li>
        ))}
        {!a.components.length && <li class="muted">Insira peças ou subconjuntos do projeto.</li>}
      </ul>
      <h3>Mates</h3>
      <ul class="tree">
        {a.mates.map((m) => {
          const s = r?.mates[m.id];
          return (
            <li key={m.id} class={`feat ${m.suppressed ? "suppressed" : s && !s.ok ? "error" : ""}`} title={s?.error ?? `${refLabel(m.a)}\n${refLabel(m.b)}`} onDblClick={() => store.editMate(m.id)}>
              <span class="ic">{MATE_ICONS[m.kind]}</span>
              <span class="name">{m.name}</span>
              {s && !s.ok && <span class="err">✕</span>}
              <span class="grow" />
              <button class="icon" title="Editar" aria-label={`Editar ${m.name}`} onClick={() => store.editMate(m.id)}>✎</button>
              <button class="icon" title={m.suppressed ? "Reativar" : "Suprimir"} aria-label={`Suprimir ${m.name}`} onClick={() => store.toggleMate(m.id)}>⏸</button>
              <button class="icon" title="Apagar" aria-label={`Apagar ${m.name}`} onClick={() => store.deleteMate(m.id)}>✕</button>
            </li>
          );
        })}
        {!a.mates.length && <li class="muted">Sem mates. Selecione duas faces/arestas e use Mate.</li>}
      </ul>
      {r?.messages.map((m, i) => <p key={i} class="warn">⚠ {m}</p>)}
      {st.interference && (
        <div class="interference">
          <h3>Interferências</h3>
          {st.interference.pairs.length ? st.interference.pairs.map((x, i) => (
            <p key={i} class="err">{compName(x.a.split("/")[0])} × {compName(x.b.split("/")[0])}: {fmt(x.volume / 1000, 3)} cm³</p>
          )) : <p class="muted">Sem interferências.</p>}
        </div>
      )}
    </div>
  );
}

/** Campo de referência de mate: escolhida no 3D (face/aresta de um componente) ou plano/eixo padrão. */
function MateRefField({ field, label, value, onChange }: { field: string; label: string; value: MateRef; onChange: (r: MateRef) => void }) {
  const st = useStore();
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => {
    const r = store.mateRefOf(p);
    if (r) { onChange(r); store.set({ pickTarget: field === "mateA" && st.mateEdit && !("ref" in st.mateEdit.draft.b) ? { field: "mateB", accept: ["face", "edge"] } : null }); }
  });
  const a = store.activeAssembly();
  return (
    <div class={`reflist ${active ? "active" : ""}`}>
      <div class="reflist-head">
        <span class="field-label">{label}</span>
        <button class="small" onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["face", "edge"] } })}>{active ? "Cancelar" : "Escolher no modelo"}</button>
      </div>
      <p class="ref-value" title={"ref" in value ? value.ref.name : ""}>{refLabel(value)}</p>
      <div class="row">
        <select aria-label={`${label}: plano/eixo padrão`} value={"std" in value ? `${value.component}:${value.std}` : ""} onChange={(e) => {
          const [component, std] = (e.target as HTMLSelectElement).value.split(":");
          if (std) onChange({ component, std: std as StdPlane });
        }}>
          <option value="">— ou plano/eixo padrão —</option>
          {[{ id: "", name: "Origem" }, ...(a?.components ?? [])].map((c) => STD.map((s) => <option key={`${c.id}:${s}`} value={`${c.id}:${s}`}>{c.name} · {s.length === 2 ? "plano" : "eixo"} {s}</option>))}
        </select>
      </div>
      {(() => {
        // publicações das peças dos componentes (nomes estáveis "@Nome")
        const opts = (a?.components ?? []).flatMap((c) => {
          const p = c.ref.kind === "part" ? st.project.parts.find((x) => x.id === c.ref.id) : undefined;
          return (p?.publications ?? []).filter((x) => x.ref.kind !== "body").map((x) => ({ c, x }));
        });
        if (!opts.length) return null;
        return (
          <div class="row">
            <select aria-label={`${label}: publicação`} value={"ref" in value && value.ref.name.startsWith("@") ? `${value.component}|${value.ref.name}` : ""} onChange={(e) => {
              const [component, name] = (e.target as HTMLSelectElement).value.split("|");
              if (name) onChange({ component, ref: { kind: "face", name } });
            }}>
              <option value="">— ou publicação —</option>
              {opts.map(({ c, x }) => <option key={`${c.id}|${x.name}`} value={`${c.id}|@${x.name}`}>{c.name} · {x.name}</option>)}
            </select>
          </div>
        );
      })()}
    </div>
  );
}

export function MatePanel() {
  const st = useStore();
  const e = st.mateEdit!;
  const m = e.draft;
  const up = (patch: Partial<Mate>) => store.updateMateDraft(patch);
  const status = st.asmResult?.mates[m.id];
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") store.cancelMate(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const needsValue = m.kind === "distance" || m.kind === "angle";
  return (
    <div class="property-panel">
      <header>
        <h2>{e.isNew ? "Novo mate" : m.name}</h2>
        <div class="actions">
          <button class="primary" onClick={() => store.confirmMate()} title="Confirmar">✓ OK</button>
          <button onClick={() => store.cancelMate()} title="Cancelar (Esc)">✕</button>
        </div>
      </header>
      <Field label="Nome"><input value={m.name} onInput={(ev) => up({ name: (ev.target as HTMLInputElement).value })} /></Field>
      <Select<MateKind> label="Tipo" value={m.kind} options={(Object.keys(MATE_LABELS) as MateKind[]).map((k) => [k, `${MATE_ICONS[k]} ${MATE_LABELS[k]}`])}
        onChange={(kind) => up({ kind, value: kind === "distance" ? (m.value ?? 10) : kind === "angle" ? (m.value ?? 90) : undefined })} />
      <MateRefField field="mateA" label="Referência 1" value={m.a} onChange={(a) => up({ a })} />
      <MateRefField field="mateB" label="Referência 2" value={m.b} onChange={(b) => up({ b })} />
      {needsValue && <ExprInput label={m.kind === "angle" ? "Ângulo" : "Distância"} unit={m.kind === "angle" ? "°" : "mm"} value={m.value} onChange={(value) => up({ value })} />}
      {m.kind !== "lock" && m.kind !== "perpendicular" && (
        <Select label="Alinhamento" value={m.align ?? "default"} options={[["default", "Automático (faces frente a frente; eixos livres)"], ["anti", "Anti-alinhado"], ["aligned", "Alinhado"]]}
          onChange={(v) => up({ align: v === "default" ? undefined : (v as "aligned" | "anti") })} />
      )}
      {status && (status.ok ? <p class="ok">✓ Cumprido</p> : <p class="err" role="alert">✕ {status.error ?? `Não cumprido (resíduo ${fmt(status.residual, 4)})`}</p>)}
      <p class="field-hint">Faces planas dão planos; faces cilíndricas/cónicas e arestas circulares dão eixos (com raio, para tangente); arestas retas dão retas. O primeiro componente inserido fica fixo.</p>
    </div>
  );
}

export function ComponentPanel() {
  const st = useStore();
  const a = store.activeAssembly();
  const c = a?.components.find((x) => x.id === st.componentEdit);
  if (!a || !c) return null;
  const idx = a.components.indexOf(c);
  const set = (patch: Partial<Component>) => store.updateComponent(c.id, patch);
  const vec = (key: "t" | "r", k: number, v: string) => {
    const pl = structuredClone(c.placement);
    pl[key][k] = Number(v) || 0;
    set({ placement: pl });
  };
  return (
    <div class="property-panel">
      <header>
        <h2>{c.name}</h2>
        <div class="actions"><button class="primary" onClick={() => store.set({ componentEdit: null })}>✓ OK</button></div>
      </header>
      <Field label="Nome"><input value={c.name} onChange={(ev) => set({ name: (ev.target as HTMLInputElement).value })} /></Field>
      <Check label="Fixo (não se move com os mates)" value={c.fixed ?? idx === 0} onChange={(fixed) => set({ fixed })} />
      {(() => {
        const part = c.ref.kind === "part" ? st.project.parts.find((p) => p.id === c.ref.id) : undefined;
        const rows = part?.configurations?.rows ?? [];
        if (!rows.length) return null;
        return (
          <Field label="Configuração">
            <select value={c.config ?? ""} onChange={(ev) => set({ config: (ev.target as HTMLSelectElement).value || undefined })}>
              <option value="">Ativa da peça ({part!.configurations!.active ?? rows[0].name})</option>
              {rows.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
          </Field>
        );
      })()}
      <Check label="Suprimido" value={c.suppressed} onChange={(suppressed) => set({ suppressed })} />
      <fieldset class="checklist">
        <legend class="field-label">Posição inicial (o solver parte daqui)</legend>
        <div class="row3">{[0, 1, 2].map((k) => <Field key={k} label={`${"XYZ"[k]} (mm)`}><input type="number" value={c.placement.t[k]} onChange={(ev) => vec("t", k, (ev.target as HTMLInputElement).value)} /></Field>)}</div>
        <div class="row3">{[0, 1, 2].map((k) => <Field key={k} label={`Rot. ${"XYZ"[k]} (°)`}><input type="number" value={c.placement.r[k]} onChange={(ev) => vec("r", k, (ev.target as HTMLInputElement).value)} /></Field>)}</div>
      </fieldset>
      <button onClick={() => { if (confirm(`Apagar ${c.name}?`)) { store.set({ componentEdit: null }); store.deleteComponent(c.id); } }}>Apagar componente</button>
    </div>
  );
}
