// Campos do painel de propriedades: regiões, corpos de superfície, pontos, curvas, caminhos e opções de varrimento.
import type { CadDocument, CurveRef, Expr, RegionRef, SurfaceTarget, SweepOptions, SweepOrientation, Vec3 } from "../doc/types.ts";
import { FEATURE_LABELS, createsSheet } from "../doc/features.ts";
import { store, useStoreKeys } from "./store.ts";
import { ExprInput, Field, RefList, Select, describeName, fmt, usePickTarget } from "./forms-base.tsx";
import { AxisSelect, PlaneSelect } from "./forms-select.tsx";

/** Regiões escolhidas de um esboço ("contornos selecionados"); vazio = todos os contornos fechados. */
export function RegionList({ sketch, value, onChange }: { sketch: string; value: RegionRef[] | undefined; onChange: (v: RegionRef[] | undefined) => void }) {
  const st = useStoreKeys("pickTarget", "result");
  const field = "regions";
  const active = st.pickTarget?.field === field;
  const sel = value ?? [];
  const view = st.result?.sketches[sketch];
  usePickTarget(field, (p) => {
    if (p.kind !== "region" || p.sketch !== sketch) return;
    const key = p.sig.join("+");
    const has = sel.some((r) => r.sig.join("+") === key);
    const next = has ? sel.filter((r) => r.sig.join("+") !== key) : [...sel, { sig: p.sig, seed: p.seed }];
    onChange(next.length ? next : undefined);
  });
  const fmtA = (a: number) => a.toLocaleString("pt-PT", { maximumFractionDigits: 1 });
  return (
    <div class={`reflist ${active ? "active" : ""}`}>
      <div class="reflist-head">
        <span class="field-label">Regiões (contornos selecionados)</span>
        <button class="small" disabled={!view?.regionList.length} onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["region"] } })}>{active ? "Concluir" : "Escolher regiões"}</button>
      </div>
      {active && <p class="field-hint">Clique nas regiões (a roxo) no modelo; clique de novo para retirar.</p>}
      <ul>
        {sel.map((r) => {
          const area = view?.regionList.find((x) => x.sig.join("+") === r.sig.join("+"))?.area;
          return (
            <li key={r.sig.join("+")} title={r.sig.join(" + ")}>
              <span>Região {r.sig.join(" + ")}{area !== undefined ? ` · ${fmtA(area)} mm²` : " · (por reencontrar)"}</span>
              <button class="icon" aria-label="Retirar" onClick={() => { const n = sel.filter((x) => x !== r); onChange(n.length ? n : undefined); }}>✕</button>
            </li>
          );
        })}
        {!sel.length && <li class="muted">Todos os contornos fechados{view ? ` · ${view.regionList.length} região(ões) no esboço` : ""}</li>}
      </ul>
    </div>
  );
}

/** Corpos de superfície criados antes de `before` (as features que os criam). */
function sheetCandidates(doc: CadDocument, before: number) {
  return doc.features.slice(0, before).filter((f) => createsSheet(f) && !f.suppressed);
}

/**
 * Escolha de corpos de superfície: lista das features que os criam, ou clique numa face do corpo no 3D.
 * `single`: um só corpo (lista pendente).
 */
export function SheetList({ field, label, value, onChange, before, single, exclude }: { field: string; label: string; value: string[]; onChange: (v: string[]) => void; before: number; single?: boolean; exclude?: string[] }) {
  const st = useStoreKeys("pickTarget", "doc");
  const active = st.pickTarget?.field === field;
  const cands = sheetCandidates(st.doc, before).filter((f) => !exclude?.includes(f.id));
  usePickTarget(field, (p) => {
    if (p.kind !== "face" || !p.body || !cands.some((c) => c.id === p.body)) return;
    onChange(single ? [p.body] : value.includes(p.body) ? value.filter((x) => x !== p.body) : [...value, p.body]);
  });
  const pickBtn = <button class="small" onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["face"] } })}>{active ? "Concluir" : "Selecionar no modelo"}</button>;
  if (single) {
    return (
      <Field label={label}>
        <div class="row">
          <select value={value[0] ?? ""} onChange={(e) => onChange([(e.target as HTMLSelectElement).value])}>
            <option value="">— escolher —</option>
            {cands.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {pickBtn}
        </div>
      </Field>
    );
  }
  return (
    <fieldset class={`checklist ${active ? "active" : ""}`}>
      <legend class="field-label">{label} {pickBtn}</legend>
      {cands.map((f) => (
        <label key={f.id} class="check">
          <input type="checkbox" checked={value.includes(f.id)} onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...value, f.id] : value.filter((x) => x !== f.id))} />
          {f.name} <span class="muted">({FEATURE_LABELS[f.type]})</span>
        </label>
      ))}
      {!cands.length && <p class="muted">Nenhum corpo de superfície antes desta feature</p>}
    </fieldset>
  );
}

/** Pontos escolhidos no 3D (partes a manter ao aparar). Enquanto se escolhe, mostra-se a superfície inteira. */
export function PointList({ field, label, value, onChange }: { field: string; label: string; value: Vec3[]; onChange: (v: Vec3[]) => void }) {
  const st = useStoreKeys("pickTarget");
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => { if (p.kind === "face" && p.point) onChange([...value, p.point.map((x) => Math.round(x * 1e3) / 1e3) as Vec3]); });
  const toggle = () => { store.set({ pickTarget: active ? null : { field, accept: ["face"] } }); store.rebuild(0); };
  return (
    <div class={`reflist ${active ? "active" : ""}`}>
      <div class="reflist-head">
        <span class="field-label">{label}</span>
        <button class="small" onClick={toggle}>{active ? "Concluir seleção" : "Selecionar partes"}</button>
      </div>
      {active && <p class="field-hint">Clique nas partes da superfície a manter (a superfície aparece inteira enquanto escolhe).</p>}
      <ul>
        {value.map((p, i) => (
          <li key={i}><span>Parte {i + 1} · ({p.map(fmt).join("; ")})</span><button class="icon" aria-label="Retirar" onClick={() => onChange(value.filter((_, k) => k !== i))}>✕</button></li>
        ))}
        {!value.length && <li class="muted">Nenhuma</li>}
      </ul>
    </div>
  );
}

/** Alvo de interseção/projeção: plano, corpo de superfície, faces ou o corpo sólido. */
export function TargetEditor({ field, label, value, onChange, before }: { field: string; label: string; value: SurfaceTarget; onChange: (v: SurfaceTarget) => void; before: number }) {
  return (
    <fieldset class="checklist">
      <legend class="field-label">{label}</legend>
      <select aria-label={`${label}: tipo`} value={value.kind} onChange={(e) => {
        const k = (e.target as HTMLSelectElement).value as SurfaceTarget["kind"];
        onChange(k === "plane" ? { kind: k, plane: { kind: "std", name: "XY" } } : k === "sheet" ? { kind: k, sheet: "" } : k === "faces" ? { kind: k, faces: [] } : { kind: "body" });
      }}>
        <option value="plane">Plano</option><option value="sheet">Corpo de superfície</option><option value="faces">Faces</option><option value="body">Corpo sólido</option>
      </select>
      {value.kind === "plane" && <PlaneSelect field={`${field}.plane`} label="Plano" value={value.plane} before={before} onChange={(plane) => onChange({ kind: "plane", plane })} />}
      {value.kind === "sheet" && <SheetList field={`${field}.sheet`} single label="Corpo" value={value.sheet ? [value.sheet] : []} before={before} onChange={([sheet]) => onChange({ kind: "sheet", sheet: sheet ?? "" })} />}
      {value.kind === "faces" && <RefList field={`${field}.faces`} label="Faces" accept={["face"]} refs={value.faces} onChange={(faces) => onChange({ kind: "faces", faces })} />}
    </fieldset>
  );
}

/** Curva já escolhida (as features novas começam com referências vazias). */
const validCurve = (c: CurveRef) => (c.kind === "edge" ? !!c.ref.name : c.kind === "curve" ? !!c.feature : !!c.sketch);

const curveLabel = (doc: CadDocument, c: CurveRef) =>
  c.kind === "edge" ? describeName(doc, c.ref.name) : doc.features.find((f) => f.id === (c.kind === "curve" ? c.feature : c.sketch))?.name ?? "?";

/** Lista ordenada de curvas (curvas 3D, esboços ou arestas escolhidas no 3D). */
export function CurveList({ field, label, value, onChange, before, single }: { field: string; label: string; value: CurveRef[]; onChange: (v: CurveRef[]) => void; before: number; single?: boolean }) {
  const st = useStoreKeys("pickTarget", "doc");
  const active = st.pickTarget?.field === field;
  const push = (c: CurveRef) => onChange(single ? [c] : [...value, c]);
  usePickTarget(field, (p) => { if (p.kind === "edge") push({ kind: "edge", ref: { kind: "edge", name: p.name, hint: p.hint } }); });
  const cands = st.doc.features.slice(0, before).filter((f) => (f.type === "curve" || f.type === "sketch" || f.type === "external") && !f.suppressed);
  return (
    <div class={`reflist ${active ? "active" : ""}`}>
      <div class="reflist-head">
        <span class="field-label">{label}</span>
        <button class="small" onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["edge"] } })}>{active ? "Concluir" : "Arestas no modelo"}</button>
      </div>
      <select aria-label={`${label}: acrescentar`} value="" onChange={(e) => {
        const id = (e.target as HTMLSelectElement).value;
        const f = cands.find((x) => x.id === id);
        if (f) push(f.type === "sketch" ? { kind: "sketch", sketch: id } : { kind: "curve", feature: id });
      }}>
        <option value="">{single ? "escolher curva ou esboço…" : "+ acrescentar curva ou esboço…"}</option>
        {cands.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <ul>
        {value.filter(validCurve).map((c, i) => (
          <li key={i}><span>{single ? "" : <b>{i + 1}. </b>}{curveLabel(st.doc, c)}</span><button class="icon" aria-label="Retirar" onClick={() => onChange(value.filter((_, k) => k !== i))}>✕</button></li>
        ))}
        {!value.length && <li class="muted">Nenhuma</li>}
      </ul>
    </div>
  );
}

/** Caminho de varrimento: esboço ou curva 3D. */
export function PathSelect({ label, value, onChange, before }: { label: string; value: string; onChange: (v: string) => void; before: number }) {
  const st = useStoreKeys("doc");
  const cands = st.doc.features.slice(0, before).filter((f) => f.type === "sketch" || f.type === "curve" || f.type === "external");
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">— escolher —</option>
        {cands.map((s) => <option key={s.id} value={s.id}>{s.name} ({FEATURE_LABELS[s.type]})</option>)}
      </select>
    </Field>
  );
}

/** Tabela de pontos 3D (expressões), com acrescentar/retirar. */
export function PointsEditor({ value, onChange }: { value: [Expr, Expr, Expr][]; onChange: (v: [Expr, Expr, Expr][]) => void }) {
  return (
    <div class="points-editor">
      {value.map((p, i) => (
        <div class="row3" key={i}>
          {[0, 1, 2].map((k) => (
            <ExprInput key={k} label={`P${i + 1} ${"XYZ"[k]}`} value={p[k]} onChange={(v) => { const n = value.map((q) => [...q] as [Expr, Expr, Expr]); n[i][k] = v ?? 0; onChange(n); }} />
          ))}
          <button class="icon" aria-label={`Retirar ponto ${i + 1}`} disabled={value.length <= 2} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button class="small" onClick={() => { const l = value.at(-1) ?? [0, 0, 0]; onChange([...value, [Number(l[0]) + 20 || 0, l[1], l[2]]]); }}>+ ponto</button>
    </div>
  );
}

/** Opções avançadas de varrimento (orientação do perfil, guia, lei de escala). */
export function SweepOptionsEditor({ value, onChange, before }: { value: SweepOptions; onChange: (v: Partial<SweepOptions>) => void; before: number }) {
  const o = value.orientation ?? "frenet";
  return (
    <>
      <Select<SweepOrientation> label="Orientação do perfil" value={o} onChange={(orientation) => onChange({ orientation })}
        options={[["frenet", "Segue o caminho (Frenet)"], ["fixed", "Constante"], ["binormal", "Binormal fixa (direção)"], ["support", "Normal das faces de suporte"], ["guide", "Curva guia"]]} />
      {o === "binormal" && <AxisSelect field="binormal" label="Direção da binormal" value={value.binormal ?? { kind: "std", name: "Z" }} before={before} onChange={(binormal) => onChange({ binormal })} />}
      {o === "support" && <RefList field="support" label="Faces de suporte do caminho" accept={["face"]} refs={value.support ?? []} onChange={(support) => onChange({ support })} />}
      {o === "guide" && (
        <>
          <CurveList field="guide" single label="Curva guia" value={value.guide ? [value.guide] : []} before={before} onChange={([guide]) => onChange({ guide })} />
          <Select label="Papel da guia" value={value.guideMode ?? "orient"} onChange={(guideMode) => onChange({ guideMode })}
            options={[["orient", "Só orienta (roda o perfil)"], ["contact", "Contacto (largura constante)"], ["border", "Bordo (a largura varia até à guia)"]]} />
        </>
      )}
      <ExprInput label="Escala no fim do caminho" unit="×" allowEmpty value={value.scale} onChange={(scale) => onChange({ scale })} />
      {value.scale !== undefined && value.scale !== "" && Number(value.scale) !== 1 && (
        <Select label="Lei de escala" value={value.scaleLaw ?? "linear"} options={[["linear", "Linear"], ["s", "Em S (tangente nula nas pontas)"]]} onChange={(scaleLaw) => onChange({ scaleLaw })} />
      )}
    </>
  );
}
