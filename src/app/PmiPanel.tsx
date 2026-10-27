// Painel PMI da peça (Fase 5): referências, cotas com tolerância ou ajustamento ISO 286, quadros de
// tolerância geométrica ISO 1101, estados de superfície e notas ligados às faces; vistas de modelo
// (orientação + PMI mostrados) e atributos (tags) pesquisáveis em todo o projeto, exportáveis em CSV.
import { useState } from "preact/hooks";
import { type Attribute, GDT, type GdtCharacteristic, type ModelView, type PmiItem, attributesCSV, fit, fitDeviation, nextDatumLabel, searchAttributes, targetLabel } from "../doc/pmi.ts";
import type { TopoRef } from "../doc/types.ts";
import { store, useStore } from "./store.ts";
import { Check, Field, RefList, Select } from "./forms.tsx";
import { commandViewport } from "./commands.ts";
import { download } from "./fileio.ts";

const KIND_LABEL: Record<PmiItem["kind"], string> = { datum: "Referência", dimension: "Cota", gdt: "Tolerância geométrica", roughness: "Estado de superfície", note: "Nota" };
const num = (s: string) => Number(s.replace(",", "."));

function newItem(kind: PmiItem["kind"], id: string, used: string[]): PmiItem {
  switch (kind) {
    case "datum": return { kind, id, label: nextDatumLabel(used), face: { kind: "face", name: "" } };
    case "dimension": return { kind, id, type: "distance", faces: [], tol: { kind: "deviation", upper: 0.1, lower: -0.1 } };
    case "gdt": return { kind, id, characteristic: "flatness", faces: [], value: 0.05, datums: [] };
    case "roughness": return { kind, id, faces: [], ra: 3.2, process: "remove" };
    case "note": return { kind, id, faces: [], text: "" };
  }
}

export function PmiPanel() {
  const st = useStore();
  const [tab, setTab] = useState<"pmi" | "views" | "attrs">("pmi");
  return (
    <div class="knowledge-panel pmi-panel">
      <div class="tree-head">
        <b>PMI — {st.doc.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null, pmiSel: null, pmiView: null })}>← Árvore</button>
      </div>
      <div class="row tabs-small" role="tablist">
        {([["pmi", "Anotações"], ["views", "Vistas de modelo"], ["attrs", "Atributos"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} class={`small ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "pmi" && <Annotations />}
      {tab === "views" && <Views />}
      {tab === "attrs" && <Attributes />}
      <p class="field-hint">Indicações GPS (ISO 1101, 5459, 286, 21920) com as faces pelo nome topológico. O PMI documenta requisitos de projeto; não é inspeção, certificação nem decisão de uma autoridade ou de um organismo notificado.</p>
    </div>
  );
}

function Annotations() {
  const st = useStore();
  const items = st.doc.pmi ?? [];
  const states = new Map((st.result?.pmi ?? []).map((x) => [x.id, x]));
  const save = (next: PmiItem[], label = "PMI") => store.commitDoc("part", { ...st.doc, pmi: next }, label, true);
  const up = (id: string, patch: Partial<PmiItem>) => save(items.map((x) => (x.id === id ? ({ ...x, ...patch } as PmiItem) : x)));
  const add = (kind: PmiItem["kind"]) => {
    const n = items.reduce((m, x) => Math.max(m, Number(x.id.slice(3)) || 0), 0) + 1;
    const it = newItem(kind, `pmi${n}`, items.flatMap((x) => (x.kind === "datum" ? [x.label] : [])));
    save([...items, it], `Novo ${KIND_LABEL[kind].toLowerCase()}`);
    store.set({ pmiSel: it.id });
  };
  const errors = items.filter((x) => states.get(x.id)?.errors.length).length;
  return (
    <>
      <select aria-label="Acrescentar PMI" value="" onChange={(e) => { const k = (e.target as HTMLSelectElement).value as PmiItem["kind"]; if (k) add(k); }}>
        <option value="">+ anotação…</option>
        {(Object.keys(KIND_LABEL) as PmiItem["kind"][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      {items.length > 0 && <p class={errors ? "error-text" : "muted"} role="status" aria-label="Estado do PMI">{items.length} anotações{errors ? ` · ${errors} com erros` : " · todas válidas"}</p>}
      {items.map((it) => {
        const s = states.get(it.id);
        const open = st.pmiSel === it.id;
        return (
          <div key={it.id} class={`kw-item ${s?.errors.length ? "bad" : "ok"}`}>
            <div class="row">
              <button class="link pmi-head" onClick={() => store.set({ pmiSel: open ? null : it.id })}><span class="pmi-kind">{KIND_LABEL[it.kind]}</span> <code>{s?.text ?? "…"}</code></button>
              <button class="icon" aria-label={`Apagar ${it.id}`} onClick={() => { save(items.filter((x) => x.id !== it.id), "Apagar PMI"); store.set({ pmiSel: null }); }}>✕</button>
            </div>
            {s?.errors.map((e) => <p key={e} class="error-text">{e}</p>)}
            {open && <ItemEditor it={it} items={items} nominal={s?.nominal} up={(p) => up(it.id, p)} />}
          </div>
        );
      })}
      {!items.length && <p class="field-hint">Acrescente referências (A, B, C), cotas com tolerância ou ajustamento, quadros de tolerância geométrica, rugosidade e notas. Ficam ligados às faces e seguem as alterações do modelo; o STEP AP242 leva-os como PMI semântico.</p>}
    </>
  );
}

function ItemEditor({ it, items, nominal, up }: { it: PmiItem; items: PmiItem[]; nominal?: number; up: (p: Partial<PmiItem>) => void }) {
  const datums = items.flatMap((x) => (x.kind === "datum" ? [x.label] : []));
  const faces = (refs: TopoRef[], single = false, label = "Faces") => <RefList field={`pmi.${it.id}`} label={label} accept={["face"]} single={single} refs={refs.filter((r) => r.name)} onChange={(r) => up(it.kind === "datum" ? { face: r[0] ?? { kind: "face", name: "" } } : { faces: r } as Partial<PmiItem>)} />;
  switch (it.kind) {
    case "datum":
      return (
        <>
          <Field label="Letra (ISO 5459)"><input value={it.label} maxLength={2} onChange={(e) => up({ label: (e.target as HTMLInputElement).value.toUpperCase() })} /></Field>
          {faces([it.face], true, "Face de referência")}
        </>
      );
    case "dimension": {
      const tol = it.tol;
      let fitInfo = "";
      if (tol?.kind === "fit" && nominal !== undefined) {
        try {
          const d = fitDeviation(tol.code, it.type === "radius" ? 2 * nominal : nominal);
          fitInfo = `${tol.code}: ${(d.upper * 1000).toFixed(1)} / ${(d.lower * 1000).toFixed(1)} µm`;
        } catch (e) { fitInfo = (e as Error).message; }
      }
      return (
        <>
          <Select label="Tipo" value={it.type} options={[["distance", "Distância entre faces planas"], ["diameter", "Diâmetro"], ["radius", "Raio"], ["angle", "Ângulo entre faces planas"]]} onChange={(type) => up({ type })} />
          {faces(it.faces)}
          <p class="muted">Valor no modelo: {nominal === undefined ? "—" : `${+nominal.toFixed(4)}${it.type === "angle" ? "°" : " mm"}`}</p>
          <Select label="Tolerância" value={tol?.kind ?? "none"} options={[["none", "Nenhuma (geral)"], ["deviation", "Afastamentos"], ["fit", "Classe ISO 286 (ex. H7, g6)"]]}
            onChange={(k) => up({ tol: k === "none" ? undefined : k === "fit" ? { kind: "fit", code: it.type === "diameter" ? "H7" : "js9" } : { kind: "deviation", upper: 0.1, lower: -0.1 } })} />
          {tol?.kind === "deviation" && (
            <div class="row">
              <Field label="Superior"><input value={tol.upper} onChange={(e) => up({ tol: { ...tol, upper: num((e.target as HTMLInputElement).value) } })} /></Field>
              <Field label="Inferior"><input value={tol.lower} onChange={(e) => up({ tol: { ...tol, lower: num((e.target as HTMLInputElement).value) } })} /></Field>
            </div>
          )}
          {tol?.kind === "fit" && (
            <>
              <Field label="Classe"><input value={tol.code} onChange={(e) => up({ tol: { kind: "fit", code: (e.target as HTMLInputElement).value.trim() } })} /></Field>
              {fitInfo && <p class="muted">{fitInfo}</p>}
              <FitHelper d={nominal} code={tol.code} />
            </>
          )}
        </>
      );
    }
    case "gdt": {
      const g = GDT[it.characteristic];
      const needsDatum = g.family === "orientation" || g.family === "runout" || g.family === "location";
      return (
        <>
          <Select label="Característica (ISO 1101)" value={it.characteristic} options={(Object.keys(GDT) as GdtCharacteristic[]).map((k) => [k, `${GDT[k].symbol}  ${GDT[k].label}`])}
            onChange={(characteristic) => up({ characteristic, datums: GDT[characteristic].family === "form" ? [] : it.datums })} />
          {faces(it.faces)}
          <div class="row">
            <Field label="Tolerância (mm)"><input value={it.value} onChange={(e) => up({ value: num((e.target as HTMLInputElement).value) })} /></Field>
            <Select label="Modificador" value={it.modifier ?? ""} options={[["", "—"], ["M", "Ⓜ máximo material"], ["L", "Ⓛ mínimo material"]]} onChange={(m) => up({ modifier: (m || undefined) as "M" | "L" | undefined })} />
          </div>
          <Check label="Zona cilíndrica (⌀)" value={it.diameter} onChange={(diameter) => up({ diameter })} />
          {g.family !== "form" && (
            <div class="row3">
              {["Primária", "Secundária", "Terciária"].map((l, k) => (
                <Field key={l} label={l}>
                  <select value={it.datums[k] ?? ""} onChange={(e) => { const d = [...it.datums]; d[k] = (e.target as HTMLSelectElement).value; up({ datums: d.slice(0, d.findIndex((x) => !x) < 0 ? 3 : d.findIndex((x) => !x)) }); }}>
                    <option value="">—</option>
                    {datums.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          )}
          {needsDatum && !datums.length && <p class="field-hint">Defina primeiro uma referência (Acrescentar → Referência).</p>}
        </>
      );
    }
    case "roughness":
      return (
        <>
          {faces(it.faces)}
          <div class="row">
            <Field label="Ra (µm)"><input value={it.ra} onChange={(e) => up({ ra: num((e.target as HTMLInputElement).value) })} /></Field>
            <Select label="Remoção de material" value={it.process} options={[["remove", "Obrigatória"], ["noremove", "Proibida"], ["any", "Qualquer processo"]]} onChange={(process) => up({ process })} />
          </div>
        </>
      );
    case "note":
      return (
        <>
          {faces(it.faces)}
          <Field label="Texto"><input value={it.text} onChange={(e) => up({ text: (e.target as HTMLInputElement).value })} /></Field>
        </>
      );
  }
}

/** Ajustamento furo/veio para a cota (verificação rápida da folga ou aperto). */
function FitHelper({ d, code }: { d?: number; code: string }) {
  const [other, setOther] = useState(code === code.toUpperCase() ? "g6" : "H7");
  if (d === undefined) return null;
  const hole = code === code.toUpperCase();
  let txt: string;
  try {
    const f = hole ? fit(code, other, d) : fit(other, code, d);
    const T = { clearance: "com folga", transition: "incerto", interference: "com aperto" }[f.type];
    txt = `Ajustamento ${hole ? code : other}/${hole ? other : code} ${T}: folga ${(f.minClearance * 1000).toFixed(1)} a ${(f.maxClearance * 1000).toFixed(1)} µm`;
  } catch (e) { txt = (e as Error).message; }
  return (
    <div class="row">
      <Field label={hole ? "Veio" : "Furo"}><input value={other} onChange={(e) => setOther((e.target as HTMLInputElement).value.trim())} /></Field>
      <p class="muted">{txt}</p>
    </div>
  );
}

function Views() {
  const st = useStore();
  const views = st.doc.modelViews ?? [];
  const items = st.doc.pmi ?? [];
  const [name, setName] = useState("");
  const save = (next: ModelView[], label = "Vistas de modelo") => store.commitDoc("part", { ...st.doc, modelViews: next }, label, true);
  const capture = () => {
    const v = commandViewport();
    if (!v) return;
    const n = views.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1;
    const cur = st.pmiView ? views.find((x) => x.id === st.pmiView)?.items : null;
    const { dir, up } = v.cameraView();
    save([...views, { id: `v${n}`, name: name.trim() || `Vista ${n}`, dir, up, items: cur ?? items.map((x) => x.id) }], "Nova vista de modelo");
    setName("");
  };
  const apply = (mv: ModelView) => { commandViewport()?.setCameraView(mv.dir, mv.up); store.set({ pmiView: mv.id }); };
  return (
    <>
      <div class="row">
        <input aria-label="Nome da vista" placeholder="Nome da vista" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="small" onClick={capture}>Guardar vista atual</button>
      </div>
      {st.pmiView && <button class="small" onClick={() => store.set({ pmiView: null })}>Mostrar todo o PMI</button>}
      {views.map((mv) => (
        <div key={mv.id} class={`kw-item ${st.pmiView === mv.id ? "ok" : ""}`}>
          <div class="row">
            <button class="link" onClick={() => apply(mv)}><b>{mv.name}</b> <span class="muted">· {mv.items.length} PMI</span></button>
            <button class="icon" aria-label={`Apagar vista ${mv.name}`} onClick={() => { save(views.filter((x) => x.id !== mv.id)); if (st.pmiView === mv.id) store.set({ pmiView: null }); }}>✕</button>
          </div>
          {st.pmiView === mv.id && (
            <fieldset class="checklist">
              <legend class="field-label">PMI nesta vista</legend>
              {items.map((it) => (
                <Check key={it.id} label={st.result?.pmi?.find((x) => x.id === it.id)?.text ?? it.id} value={mv.items.includes(it.id)}
                  onChange={(on) => save(views.map((x) => (x.id === mv.id ? { ...x, items: on ? [...x.items, it.id] : x.items.filter((y) => y !== it.id) } : x)))} />
              ))}
            </fieldset>
          )}
        </div>
      ))}
      {!views.length && <p class="field-hint">Uma vista de modelo guarda a orientação da câmara e o PMI a mostrar (MBD, ISO 16792): oriente o modelo e guarde.</p>}
    </>
  );
}

function Attributes() {
  const st = useStore();
  const attrs = st.doc.attributes ?? [];
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<"body" | "feature" | "face">("body");
  const [feature, setFeature] = useState("");
  const [face, setFace] = useState<TopoRef[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const save = (next: Attribute[], label = "Atributos") => store.commitDoc("part", { ...st.doc, attributes: next }, label, true);
  const add = () => {
    if (!key.trim()) return;
    const t: Attribute["target"] = target === "feature" ? { kind: "feature", feature } : target === "face" && face[0] ? { kind: "face", ref: face[0] } : { kind: "body" };
    save([...attrs, { target: t, key: key.trim(), value: value.trim() }], "Novo atributo");
    setKey(""); setValue("");
  };
  // pesquisa no projeto inteiro (o documento ativo com as alterações por gravar)
  const docs = st.project.parts.map((p) => (p.id === st.doc.id ? { ...p, attributes: st.doc.attributes } : p));
  const hits = searchAttributes(docs, q);
  return (
    <>
      <table class="info-table">
        {attrs.map((a, i) => (
          <tr key={i}>
            <td>{targetLabel(a.target)}</td>
            <td><b>{a.key}</b> = {a.value} <button class="icon" aria-label={`Apagar atributo ${a.key}`} onClick={() => save(attrs.filter((_, k) => k !== i))}>✕</button></td>
          </tr>
        ))}
      </table>
      <fieldset class="checklist">
        <legend class="field-label">Novo atributo</legend>
        <Select label="Alvo" value={target} options={[["body", "Corpo (peça)"], ["feature", "Feature"], ["face", "Face"]]} onChange={setTarget} />
        {target === "feature" && (
          <select aria-label="Feature" value={feature} onChange={(e) => setFeature((e.target as HTMLSelectElement).value)}>
            <option value="">— escolher —</option>
            {st.doc.features.map((f) => <option key={f.id} value={f.id}>{f.name ?? f.id}</option>)}
          </select>
        )}
        {target === "face" && <RefList field="attr.face" label="Face" accept={["face"]} single refs={face} onChange={setFace} />}
        <div class="row">
          <input aria-label="Atributo" placeholder="Atributo (ex. Processo)" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          <input aria-label="Valor" placeholder="Valor" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        </div>
        <button class="small" disabled={!key.trim() || (target === "feature" && !feature) || (target === "face" && !face.length)} onClick={add}>Acrescentar</button>
      </fieldset>
      <h3>Pesquisar no projeto</h3>
      <div class="row">
        <input aria-label="Pesquisar atributos" placeholder="material, processo, fornecedor…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="small" disabled={!hits.length} onClick={() => download("atributos.csv", attributesCSV(hits), "text/csv")}>CSV</button>
      </div>
      <table class="info-table attr-hits">
        {hits.map((h, i) => <tr key={i}><td>{h.docName}</td><td>{h.target} · <b>{h.key}</b> = {h.value}</td></tr>)}
      </table>
      {!hits.length && <p class="muted">Sem resultados.</p>}
    </>
  );
}
