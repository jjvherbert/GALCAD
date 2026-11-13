// Editor de desenhos: painel lateral (folha, selo, vistas, anotações e lista de materiais).
import { useState } from "preact/hooks";
import { type Annotation, type DrawingDoc, type DrawingView, type GdtChar, type SheetSize, type StdView } from "../doc/project.ts";
import { primToSvg } from "../drawing/svg.ts";
import { GDT_LABELS, gdtSymbol } from "../drawing/prims.ts";
import { addView, autoBalloons, deleteView, importModelDims, importPmi } from "../drawing/edit.ts";
import { ISO_SCALES, autoLayout } from "../drawing/auto-layout.ts";
import { store, useStoreKeys } from "./store.ts";
import { Check, Field, Select } from "./forms.tsx";

export function rootAsmOf(d: DrawingDoc, v: DrawingView, depth = 0): string | null {
  if (v.kind === "model") return v.source.kind === "assembly" ? v.source.id : null;
  const p = d.views.find((x) => x.id === v.parent);
  return p && depth < 20 ? rootAsmOf(d, p, depth + 1) : null;
}

// ---------------------------------------------------------------------------
// Painel lateral
// ---------------------------------------------------------------------------

const SCALES: [string, string][] = ISO_SCALES.map(([n, m]) => [`${n}:${m}`, `${n}:${m}`]);
const ORIENT: [StdView, string][] = [["front", "Frente"], ["back", "Trás"], ["top", "Cima"], ["bottom", "Baixo"], ["left", "Esquerda"], ["right", "Direita"], ["iso", "Isométrica"]];

export function DrawingPanel({ d }: { d: DrawingDoc }) {
  const st = useStoreKeys("drawingSel", "project", "drawingTool", "drawingResult");
  const [tab, setTab] = useState<"sheet" | "title">("sheet");
  const up = (patch: Partial<DrawingDoc>, label = "Desenho") => store.commitDrawing({ ...d, ...patch }, label);
  const sel = st.drawingSel;
  const selView = sel?.kind === "view" ? d.views.find((v) => v.id === sel.id) : undefined;
  const selAnn = sel?.kind === "ann" ? d.annotations.find((a) => a.id === sel.id) : undefined;
  const [src, setSrc] = useState<string>(() => (st.project.assemblies[0] ? `assembly:${st.project.assemblies[0].id}` : `part:${st.project.parts[0].id}`));
  const [orient, setOrient] = useState<StdView>("front");
  const tool = st.drawingTool;
  return (
    <div class="drawing-panel">
      <div class="tree-head"><b>{d.name}</b><span class="muted">{d.sheet.size} {d.sheet.orientation === "landscape" ? "horizontal" : "vertical"} · {d.sheet.scale.join(":")}</span></div>
      <fieldset class="checklist">
        <legend class="field-label">Vista de modelo</legend>
        <select aria-label="Modelo" value={src} onChange={(e) => setSrc((e.target as HTMLSelectElement).value)}>
          {st.project.parts.map((p) => <option key={p.id} value={`part:${p.id}`}>▮ {p.name}</option>)}
          {st.project.assemblies.map((a) => <option key={a.id} value={`assembly:${a.id}`}>⧉ {a.name}</option>)}
        </select>
        <select aria-label="Orientação" value={orient} onChange={(e) => setOrient((e.target as HTMLSelectElement).value as StdView)}>
          {ORIENT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button class={`small ${tool?.kind === "modelView" ? "on" : ""}`} onClick={() => { const [kind, id] = src.split(":"); store.set({ drawingTool: { kind: "modelView", source: { kind: kind as "part" | "assembly", id }, orientation: orient } }); }}>Colocar vista</button>
        <button class="small" title="Frente, cima, lateral e isométrica no método de projeção da folha, com escala automática" onClick={() => {
          const [kind, id] = src.split(":");
          const source = { kind: kind as "part" | "assembly", id };
          // com a caixa da última reconstrução: escala normalizada e vistas centradas; sem ela, posições fixas
          const box = store.modelBoxes.get(id);
          if (box) { store.commitDrawing(autoLayout(d, source, box), "Três vistas"); return; }
          const [w, h] = d.sheet.orientation === "landscape" ? [420, 297] : [297, 420];
          const k = d.sheet.size === "A4" ? 0.7 : 1;
          let doc = d;
          const r1 = addView(doc, { kind: "model", source, orientation: "front", at: [w * 0.3 * k, h * 0.62 * k] }); doc = r1.doc;
          const first = d.sheet.projection === "first";
          doc = addView(doc, { kind: "projected", parent: r1.id, side: first ? "below" : "above", at: [w * 0.3 * k, h * (first ? 0.3 : 0.85) * k] }).doc;
          doc = addView(doc, { kind: "projected", parent: r1.id, side: "right", at: [w * 0.62 * k, h * 0.62 * k] }).doc;
          doc = addView(doc, { kind: "model", source, orientation: "iso", at: [w * 0.75 * k, h * 0.82 * k] }).doc;
          store.commitDrawing(doc, "Três vistas");
        }}>3 vistas + iso</button>
      </fieldset>
      <nav class="tabs small-tabs">
        <button class={tab === "sheet" ? "on" : ""} onClick={() => setTab("sheet")}>Folha</button>
        <button class={tab === "title" ? "on" : ""} onClick={() => setTab("title")}>Legenda</button>
      </nav>
      {tab === "sheet" ? (
        <div>
          <Select<SheetSize> label="Formato (ISO 216)" value={d.sheet.size} options={(["A4", "A3", "A2", "A1", "A0"] as SheetSize[]).map((s) => [s, s])} onChange={(size) => up({ sheet: { ...d.sheet, size } })} />
          <Select label="Orientação" value={d.sheet.orientation} options={[["landscape", "Horizontal"], ["portrait", "Vertical"]]} onChange={(orientation) => up({ sheet: { ...d.sheet, orientation } })} />
          <Select label="Método de projeção" value={d.sheet.projection} options={[["first", "1.º diedro (ISO, Europa)"], ["third", "3.º diedro (ASME, EUA)"]]} onChange={(projection) => up({ sheet: { ...d.sheet, projection } })} />
          <Select label="Escala da folha" value={d.sheet.scale.join(":")} options={SCALES} onChange={(s) => up({ sheet: { ...d.sheet, scale: s.split(":").map(Number) as [number, number] } })} />
        </div>
      ) : (
        <div>
          {(["title", "number", "company", "author", "checker", "approver", "date", "revision", "material", "generalTolerance", "sheet"] as const).map((k) => (
            <Field key={k} label={{ title: "Título (vazio = descrição da peça)", number: "N.º do desenho (vazio = n.º da peça)", company: "Proprietário", author: "Desenhou", checker: "Verificou", approver: "Aprovou", date: "Data", revision: "Revisão", material: "Material (vazio = da peça)", generalTolerance: "Tolerâncias gerais", sheet: "Folha" }[k]}>
              <input value={d.title[k]} onChange={(e) => up({ title: { ...d.title, [k]: (e.target as HTMLInputElement).value } }, "Legenda")} />
            </Field>
          ))}
        </div>
      )}
      <h3>Vistas</h3>
      <ul class="tree">
        {d.views.map((v) => (
          <li key={v.id} class={`feat ${sel?.id === v.id ? "selected" : ""} ${st.drawingResult?.views[v.id] && !st.drawingResult.views[v.id].ok ? "error" : ""}`} onClick={() => store.set({ drawingSel: { kind: "view", id: v.id } })} title={st.drawingResult?.views[v.id]?.error ?? ""}>
            <span class="ic">▭</span><span class="name">{v.name}</span><span class="muted">{v.kind === "model" ? ORIENT.find((o) => o[0] === v.orientation)?.[1] : { projected: "projetada", section: "corte", detail: "pormenor", auxiliary: "auxiliar" }[v.kind]}</span>
          </li>
        ))}
        {!d.views.length && <li class="muted">Sem vistas. Escolha o modelo e use "Colocar vista" ou "3 vistas + iso".</li>}
      </ul>
      {selView && <ViewProps d={d} v={selView} />}
      {selAnn && <AnnProps d={d} a={selAnn} />}
      <h3>Anotações ({d.annotations.length})</h3>
      <p class="field-hint">Arraste vistas e anotações; Delete apaga; roda = zoom; botão do meio (ou Shift+arrastar) = deslocar; F ou duplo clique = ajustar.</p>
    </div>
  );
}

function ViewProps({ d, v }: { d: DrawingDoc; v: DrawingView }) {
  const st = useStoreKeys("drawingResult", "project");
  const set = (patch: Partial<DrawingView>, label = "Vista") => store.commitDrawing({ ...d, views: d.views.map((x) => (x.id === v.id ? ({ ...x, ...patch } as DrawingView) : x)) }, label);
  const r = st.drawingResult?.views[v.id];
  return (
    <div class="property-panel inline">
      <h3>Vista: {v.name}</h3>
      {r && !r.ok && <p class="err">✕ {r.error}</p>}
      <Field label="Nome"><input value={v.name} onChange={(e) => set({ name: (e.target as HTMLInputElement).value })} /></Field>
      {v.kind === "model" && <Select<StdView> label="Orientação" value={v.orientation} options={ORIENT} onChange={(orientation) => set({ orientation } as Partial<DrawingView>)} />}
      <Select label="Escala" value={v.scale === undefined ? "inherit" : String(v.scale)} options={[["inherit", v.kind === "model" ? "Da folha" : "Da vista-mãe"], ["5", "5:1"], ["2", "2:1"], ["1", "1:1"], ["0.5", "1:2"], ["0.2", "1:5"], ["0.1", "1:10"]]}
        onChange={(s) => set({ scale: s === "inherit" ? undefined : Number(s) })} />
      <Check label="Linhas ocultas (tracejadas)" value={v.hidden} onChange={(hidden) => set({ hidden })} />
      <Check label="Arestas tangentes" value={v.tangent !== "none"} onChange={(on) => set({ tangent: on ? undefined : "none" })} />
      <Check label="Marcas e linhas de centro" value={v.centerMarks !== false} onChange={(on) => set({ centerMarks: on ? undefined : false })} />
      {(v.kind === "section" || v.kind === "detail") && <Field label="Letra"><input value={v.label} onChange={(e) => set({ label: (e.target as HTMLInputElement).value.toUpperCase().slice(0, 2) } as Partial<DrawingView>)} /></Field>}
      {(v.kind === "section" || v.kind === "auxiliary") && <Check label="Inverter sentido de observação" value={v.flip} onChange={(flip) => set({ flip } as Partial<DrawingView>)} />}
      <div class="row">
        <button class="small" onClick={() => { const r2 = importModelDims(d, st.drawingResult, v.id); store.commitDrawing(r2.doc, "Importar cotas"); store.set({ message: `${r2.count} cota(s) importada(s) do modelo` }); }}>Importar cotas do modelo</button>
        <button class="small" onClick={() => { const r2 = importPmi(d, st.drawingResult, v.id); store.commitDrawing(r2.doc, "Importar PMI"); store.set({ message: `${r2.count} item(ns) PMI importado(s)` }); }}>Importar PMI</button>
        {rootAsmOf(d, v) && <button class="small" onClick={() => { const r2 = autoBalloons(d, st.project, st.drawingResult, v.id); store.commitDrawing(r2.doc, "Balões"); store.set({ message: `${r2.count} balão(ões)` }); }}>Balões automáticos</button>}
      </div>
      <button class="small" onClick={() => { store.commitDrawing(deleteView(d, v.id), "Apagar vista"); store.set({ drawingSel: null }); }}>Apagar vista</button>
    </div>
  );
}

const GDT_CHARS = Object.keys(GDT_LABELS) as GdtChar[];

function AnnProps({ d, a }: { d: DrawingDoc; a: Annotation }) {
  const set = (patch: Partial<Annotation>) => store.commitDrawing({ ...d, annotations: d.annotations.map((x) => (x.id === a.id ? ({ ...x, ...patch } as Annotation) : x)) }, "Anotação");
  const text = (label: string, value: string | undefined, key: string) => <Field label={label}><input value={value ?? ""} onChange={(e) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<Annotation>)} /></Field>;
  return (
    <div class="property-panel inline">
      <h3>{{ dim: "Cota", note: "Nota", gdt: "Tolerância geométrica", datum: "Referência", surface: "Estado de superfície", weld: "Soldadura", balloon: "Balão", bom: "Tabela de BOM" }[a.kind]}</h3>
      {a.kind === "dim" && (
        <>
          {!a.model && a.type !== "radius" && a.type !== "diameter" && a.type !== "angle" && <Select label="Tipo" value={a.type} options={[["horizontal", "Horizontal"], ["vertical", "Vertical"], ["aligned", "Alinhada"]]} onChange={(type) => set({ type })} />}
          {a.model && <p class="muted">Cota do modelo (segue o esboço {a.model.feature}).</p>}
          {text("Prefixo", a.prefix, "prefix")}
          <Field label="Casas decimais"><input type="number" min="0" max="4" value={a.precision ?? 2} onChange={(e) => set({ precision: Number((e.target as HTMLInputElement).value) })} /></Field>
          <div class="row3">
            <Field label="Tol. +"><input value={a.tol?.plus ?? ""} placeholder="+0,1" onChange={(e) => set({ tol: { ...a.tol, plus: (e.target as HTMLInputElement).value || undefined } })} /></Field>
            <Field label="Tol. −"><input value={a.tol?.minus ?? ""} placeholder="-0,1" onChange={(e) => set({ tol: { ...a.tol, minus: (e.target as HTMLInputElement).value || undefined } })} /></Field>
            <Field label="Ajuste ISO 286"><input value={a.tol?.fit ?? ""} placeholder="H7" onChange={(e) => set({ tol: { ...a.tol, fit: (e.target as HTMLInputElement).value || undefined } })} /></Field>
          </div>
        </>
      )}
      {a.kind === "note" && (
        <>
          <Field label="Texto"><textarea rows={4} value={a.text} onChange={(e) => set({ text: (e.target as HTMLTextAreaElement).value })} /></Field>
          <Field label="Altura (mm)"><input type="number" step="0.5" value={a.height ?? 3.5} onChange={(e) => set({ height: Number((e.target as HTMLInputElement).value) || 3.5 })} /></Field>
        </>
      )}
      {a.kind === "gdt" && (
        <>
          <label class="field">
            <span class="field-label">Característica (ISO 1101)</span>
            <div class="gdt-grid">
              {GDT_CHARS.map((c) => (
                <button key={c} class={`small ${a.char === c ? "on" : ""}`} title={GDT_LABELS[c]} aria-label={GDT_LABELS[c]} onClick={() => set({ char: c })}>
                  <svg viewBox="-5 -5 10 10" width="18" height="18" dangerouslySetInnerHTML={{ __html: gdtSymbol(c, [0, 0], 10).map((p) => primToSvg(p, 0)).join("") }} />
                </button>
              ))}
            </div>
          </label>
          {text("Tolerância", a.tol, "tol")}
          <Check label="Zona cilíndrica (⌀)" value={a.dia} onChange={(dia) => set({ dia })} />
          <Select label="Modificador" value={a.modifier ?? ""} options={[["", "Nenhum"], ["M", "Ⓜ Máximo material"], ["L", "Ⓛ Mínimo material"]]} onChange={(m) => set({ modifier: (m || undefined) as "M" | "L" | undefined })} />
          <Field label="Referências (ex.: A B C)"><input value={a.datums.join(" ")} onChange={(e) => set({ datums: (e.target as HTMLInputElement).value.split(/\s+/).filter(Boolean) })} /></Field>
        </>
      )}
      {a.kind === "datum" && text("Letra", a.letter, "letter")}
      {a.kind === "surface" && (
        <>
          <Select label="Processo" value={a.process} options={[["any", "Qualquer"], ["removal", "Com remoção de material"], ["noRemoval", "Sem remoção de material"]]} onChange={(process) => set({ process })} />
          {text("Requisito (ex.: Ra 3,2)", a.value, "value")}
        </>
      )}
      {a.kind === "weld" && (
        <>
          <Select label="Símbolo (ISO 2553)" value={a.symbol} options={[["fillet", "Ângulo (filete)"], ["butt", "Topo a topo (I)"], ["v", "Em V"], ["spot", "Por pontos"]]} onChange={(symbol) => set({ symbol })} />
          {text("Dimensão (ex.: a5)", a.size, "size")}
          {text("Comprimento", a.length, "length")}
          <Check label="Do outro lado" value={a.otherSide} onChange={(otherSide) => set({ otherSide })} />
          <Check label="Toda a volta" value={a.allAround} onChange={(allAround) => set({ allAround })} />
        </>
      )}
      {a.kind === "bom" && <BomProps a={a} set={set} />}
      <button class="small" onClick={() => { store.commitDrawing({ ...d, annotations: d.annotations.filter((x) => x.id !== a.id) }, "Apagar anotação"); store.set({ drawingSel: null }); }}>Apagar</button>
    </div>
  );
}

function BomProps({ a, set }: { a: Extract<Annotation, { kind: "bom" }>; set: (p: Partial<Annotation>) => void }) {
  const st = useStoreKeys("project");
  return (
    <>
      <Select label="Montagem" value={a.source} options={st.project.assemblies.map((x) => [x.id, x.name])} onChange={(source) => set({ source })} />
      <Select label="Tipo de BOM" value={a.mode} options={[["top", "Só o nível de topo"], ["parts", "Só peças (achatada)"], ["indented", "Indentada"]]} onChange={(mode) => set({ mode })} />
      <p class="field-hint">Os balões usam a numeração do nível de topo. Massas a partir do volume e da massa volúmica de cada peça.</p>
    </>
  );
}
