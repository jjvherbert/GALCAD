// Painel de propriedades da feature em edição (equivalente ao PropertyManager).
import { useEffect, useState } from "preact/hooks";
import type { CurveDef, Feature } from "../doc/types.ts";
import { FEATURE_LABELS, featureLabel } from "../doc/features.ts";
import type { CadProject } from "../doc/project.ts";
import { store, useStoreKeys } from "./store.ts";
import { HelpCard, helpForFeature } from "./featurehelp.tsx";
import { featureUi } from "./feature-ui.tsx";
import { AxisSelect, Check, CurveList, ExprInput, Field, OPS, PlaneSelect, PointsEditor, RefList, Select, SketchSelect, TargetEditor } from "./forms.tsx";
import { StatusBlock } from "./InfoPanel.tsx";

const CURVE_KINDS: [CurveDef["kind"], string][] = [["points", "Spline por pontos"], ["projected", "Esboço projetado em faces"], ["intersection", "Interseção de superfícies"], ["composite", "Curva composta (arestas)"], ["helix", "Hélice"], ["extend", "Curva prolongada (extrapolar)"]];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Instâncias de peças de uma montagem (com subconjuntos): caminho "c2/c1" e peça. */
function instancesOf(project: CadProject, asmId: string, prefix = "", names = "", depth = 0): { path: string; part: string; name: string }[] {
  const a = project.assemblies.find((x) => x.id === asmId);
  if (!a || depth > 16) return [];
  return a.components.filter((c) => !c.suppressed).flatMap((c) => {
    const path = prefix ? `${prefix}/${c.id}` : c.id;
    const name = names ? `${names} / ${c.name}` : c.name;
    return c.ref.kind === "part" ? [{ path, part: c.ref.id, name }] : instancesOf(project, c.ref.id, path, name, depth + 1);
  });
}

/** Escolha das instâncias de origem e desta peça numa montagem, e leitura da posição relativa. */
function PlacementPick({ insts, srcPart, thisPart, asmId, value }: { insts: { path: string; part: string; name: string }[]; srcPart: string; thisPart: string; asmId: string; value: { from?: string; to?: string } | undefined }) {
  const fromOpts = insts.filter((i) => i.part === srcPart), toOpts = insts.filter((i) => i.part === thisPart);
  const [from, setFrom] = useState(value?.from ?? fromOpts[0]?.path ?? "");
  const [to, setTo] = useState(value?.to ?? toOpts[0]?.path ?? "");
  if (!fromOpts.length || !toOpts.length) return <p class="muted">A montagem tem de conter as duas peças.</p>;
  return (
    <>
      <Field label="Instância da origem"><select value={from} onChange={(ev) => setFrom((ev.target as HTMLSelectElement).value)}>{fromOpts.map((i) => <option key={i.path} value={i.path}>{i.name}</option>)}</select></Field>
      <Field label="Instância desta peça"><select value={to} onChange={(ev) => setTo((ev.target as HTMLSelectElement).value)}>{toOpts.map((i) => <option key={i.path} value={i.path}>{i.name}</option>)}</select></Field>
      <button class="small" onClick={() => void store.readPlacement(asmId, from, to)}>Ler posição da montagem</button>
    </>
  );
}

function newCurveDef(kind: CurveDef["kind"]): CurveDef {
  switch (kind) {
    case "points": return { kind, points: [[0, 0, 0], [50, 20, 10], [100, 0, 0]] };
    case "projected": return { kind, sketch: "", onto: { kind: "faces", faces: [] } };
    case "intersection": return { kind, a: { kind: "sheet", sheet: "" }, b: { kind: "plane", plane: { kind: "std", name: "XY" } } };
    case "composite": return { kind, edges: [] };
    case "helix": return { kind, axis: { kind: "std", name: "Z" }, radius: 10, pitch: 5, height: 30 };
    case "extend": return { kind, curve: { kind: "curve", feature: "" }, end: 10, continuity: "tangent" };
  }
}

export function PropertyPanel() {
  const st = useStoreKeys("edit", "result", "poleSel", "poleAxis", "project", "doc", "busy");
  const e = st.edit!;
  const f = e.draft;
  const up = (patch: Partial<Feature>) => store.updateDraft(patch);
  const before = e.index;
  const status = st.result?.status[f.id];

  // feature nova sem referências: ativar logo a seleção no 3D (como no SolidWorks)
  useEffect(() => {
    if (!e.isNew) return;
    if ((f.type === "fillet" || f.type === "chamfer") && !f.refs.length) store.set({ pickTarget: { field: "refs", accept: ["edge", "face"] } });
    if ((f.type === "shell" || f.type === "draft" || f.type === "offsetSurface" || f.type === "deleteFace") && !f.faces.length) store.set({ pickTarget: { field: "faces", accept: ["face"] } });
    if ((f.type === "fill" || f.type === "ruled" || f.type === "extrapolate") && !f.edges.length) store.set({ pickTarget: { field: "edges", accept: ["edge"] } });
    if ((f.type === "untrim" || f.type === "replaceFace") && !f.faces.length) store.set({ pickTarget: { field: "faces", accept: ["face"] } });
    // esboço com contornos sobrepostos: pedir logo as regiões (como no SolidWorks)
    if ((f.type === "extrude" || f.type === "revolve") && f.sketch && st.result?.sketches[f.sketch]?.profiles.errors.length) store.set({ pickTarget: { field: "regions", accept: ["region"] } });
  }, [e.id]);

  const Ui = featureUi(f.type);
  let body;
  if (Ui) body = <Ui f={f} up={up} before={before} />;
  else switch (f.type) {
    case "curve": {
      const c = f.def;
      const set = (def: CurveDef) => up({ def });
      body = (
        <>
          <Select label="Tipo de curva" value={c.kind} options={CURVE_KINDS} onChange={(k) => set(newCurveDef(k))} />
          {c.kind === "points" && (
            <>
              <PointsEditor value={c.points} onChange={(points) => set({ ...c, points })} />
              <Check label="Fechada" value={c.closed} onChange={(closed) => set({ ...c, closed })} />
            </>
          )}
          {c.kind === "projected" && (
            <>
              <SketchSelect label="Esboço a projetar" value={c.sketch} before={before} onChange={(sketch) => set({ ...c, sketch })} />
              <TargetEditor field="onto" label="Projetar em" value={c.onto} before={before} onChange={(onto) => set({ ...c, onto })} />
              <p class="field-hint">Projeção segundo a normal do plano do esboço.</p>
            </>
          )}
          {c.kind === "intersection" && (
            <>
              <TargetEditor field="ta" label="Superfície A" value={c.a} before={before} onChange={(a) => set({ ...c, a })} />
              <TargetEditor field="tb" label="Superfície B" value={c.b} before={before} onChange={(b) => set({ ...c, b })} />
            </>
          )}
          {c.kind === "composite" && <RefList field="edges" label="Arestas (encadeadas)" accept={["edge"]} refs={c.edges} onChange={(edges) => set({ ...c, edges })} />}
          {c.kind === "helix" && (
            <>
              <AxisSelect field="axis" label="Eixo" value={c.axis} before={before} onChange={(axis) => set({ ...c, axis })} />
              <ExprInput label="Raio" value={c.radius} onChange={(radius) => set({ ...c, radius: radius ?? "" })} />
              <ExprInput label="Passo" value={c.pitch} onChange={(pitch) => set({ ...c, pitch: pitch ?? "" })} />
              <ExprInput label="Altura" value={c.height} onChange={(height) => set({ ...c, height: height ?? "" })} />
              <ExprInput label="Ângulo inicial" unit="°" allowEmpty value={c.startAngle} onChange={(startAngle) => set({ ...c, startAngle })} />
              <Check label="Esquerda (anti-horária)" value={c.lefthand} onChange={(lefthand) => set({ ...c, lefthand })} />
            </>
          )}
          {c.kind === "extend" && (
            <>
              <CurveList field="extend" single label="Curva a prolongar" value={[c.curve]} before={before} onChange={([curve]) => set({ ...c, curve })} />
              <ExprInput label="Prolongamento no início" allowEmpty value={c.start} onChange={(start) => set({ ...c, start })} />
              <ExprInput label="Prolongamento no fim" allowEmpty value={c.end} onChange={(end) => set({ ...c, end })} />
              <Select label="Continuidade" value={c.continuity ?? "tangent"} options={[["tangent", "Tangente (reta)"], ["curvature", "Curvatura (parábola osculadora)"]]} onChange={(continuity) => set({ ...c, continuity })} />
            </>
          )}
          <p class="field-hint">As curvas 3D servem de caminho de varrimento, limites de superfícies e arestas de referência.</p>
        </>
      );
      break;
    }
    case "freeform": {
      const src = f.source;
      const net = status?.net;
      const sel = st.poleSel && net && st.poleSel[0] < net.nu && st.poleSel[1] < net.nv ? st.poleSel : null;
      const mv = sel ? f.moves.find((m) => m.i === sel[0] && m.j === sel[1]) : undefined;
      const d = mv?.d ?? [0, 0, 0];
      body = (
        <>
          <Select label="Origem" value={src.kind} options={[["patch", "Patch novo num plano"], ["face", "Converter uma face"]]}
            onChange={(kind) => up({ source: kind === "patch" ? { kind, plane: { kind: "std", name: "XY" }, width: 100, height: 100, nu: 5, nv: 5 } : { kind, face: { kind: "face", name: "" } }, moves: [] })} />
          {src.kind === "patch" && (
            <>
              <PlaneSelect field="plane" label="Plano (centro = origem do plano)" value={src.plane} before={before} onChange={(plane) => up({ source: { ...src, plane } })} />
              <ExprInput label="Largura" value={src.width} onChange={(width) => up({ source: { ...src, width: width ?? "" } })} />
              <ExprInput label="Altura" value={src.height} onChange={(height) => up({ source: { ...src, height: height ?? "" } })} />
              <div class="row">
                <Field label="Polos em U"><input type="number" min="2" max="30" value={src.nu} onChange={(ev) => up({ source: { ...src, nu: Number((ev.target as HTMLInputElement).value) || 2 } })} /></Field>
                <Field label="Polos em V"><input type="number" min="2" max="30" value={src.nv} onChange={(ev) => up({ source: { ...src, nv: Number((ev.target as HTMLInputElement).value) || 2 } })} /></Field>
                <Field label="Grau"><input type="number" min="1" max="5" value={src.degree ?? 3} onChange={(ev) => up({ source: { ...src, degree: Number((ev.target as HTMLInputElement).value) || 3 } })} /></Field>
              </div>
            </>
          )}
          {src.kind === "face" && <RefList field="face" single label="Face a converter" accept={["face"]} refs={src.face.name ? [src.face] : []} onChange={(r) => up({ source: { ...src, face: r[0] ?? { kind: "face", name: "" } }, moves: [] })} />}
          <Select label="Arrastar polos" value={st.poleAxis} options={[["free", "Livre (plano do ecrã)"], ["X", "Só em X"], ["Y", "Só em Y"], ["Z", "Só em Z"]]} onChange={(poleAxis) => store.set({ poleAxis })} />
          {sel ? (
            <div class="kw-item">
              <span class="field-label">Polo ({sel[0] + 1}, {sel[1] + 1}) — deslocamento</span>
              <div class="row3">
                {[0, 1, 2].map((k) => (
                  <Field key={k} label={"dXdYdZ".slice(k * 2, k * 2 + 2)}>
                    <input type="number" step="0.5" value={d[k]} onChange={(ev) => { const n = [...d] as [number, number, number]; n[k] = Number((ev.target as HTMLInputElement).value) || 0; store.movePole(sel[0], sel[1], n, true); }} />
                  </Field>
                ))}
              </div>
              <button class="small" onClick={() => store.movePole(sel[0], sel[1], [0, 0, 0], true)}>Repor este polo</button>
            </div>
          ) : <p class="field-hint">Arraste os polos (roxo) no 3D; um clique seleciona o polo para editar o deslocamento.</p>}
          <p class="muted">{f.moves.length} polo(s) deslocado(s){net ? ` · rede ${net.nu} × ${net.nv}` : ""}</p>
          {f.moves.length > 0 && <button class="small" onClick={() => up({ moves: [] })}>Repor todos os polos</button>}
        </>
      );
      break;
    }
    case "external": {
      const others = st.project.parts.filter((p) => p.id !== st.doc.id);
      const src = st.project.parts.find((p) => p.id === f.part);
      const pubs = src?.publications ?? [];
      const asms = st.project.assemblies;
      const pl = f.placement;
      const asmId = pl?.assembly ?? asms[0]?.id ?? "";
      const insts = asmId ? instancesOf(st.project, asmId) : [];
      body = (
        <>
          <Field label="Peça de origem">
            <select value={f.part} onChange={(ev) => up({ part: (ev.target as HTMLSelectElement).value, publication: "" })}>
              <option value="">— escolher —</option>
              {others.map((p) => <option key={p.id} value={p.id}>{p.name}{p.publications?.length ? ` (${p.publications.length} publicações)` : " (sem publicações)"}</option>)}
            </select>
          </Field>
          <Field label="Publicação">
            <select value={f.publication} onChange={(ev) => up({ publication: (ev.target as HTMLSelectElement).value })}>
              <option value="">— escolher —</option>
              {pubs.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.ref.kind === "feature" ? "feature" : p.ref.kind === "body" ? "corpo" : p.ref.kind === "face" ? "face" : "aresta"})</option>)}
            </select>
          </Field>
          {src && !pubs.length && <p class="field-hint">Publique primeiro a geometria na peça de origem (Conhecimento → Publicações).</p>}
          <p class="muted">Estado: {f.mode === "frozen" ? "congelada (não acompanha a origem)" : "ligada (atualiza com a origem)"}</p>
          <div class="row">
            {f.mode === "linked"
              ? <button class="small" disabled={!f.part || !f.publication} onClick={() => void store.freezeExternal()}>Congelar agora</button>
              : <button class="small" onClick={() => up({ mode: "linked", frozen: undefined })}>Voltar a ligar</button>}
          </div>
          <Select label="Corpo publicado: operação" value={f.op ?? "new"} options={OPS} onChange={(op) => up({ op })} />
          <fieldset class="checklist">
            <legend class="field-label">Posição</legend>
            <p class="muted">{pl ? `Matriz lida${pl.assembly ? ` de "${asms.find((a) => a.id === pl.assembly)?.name ?? pl.assembly}"` : ""}` : "Mesma origem da peça de origem"}</p>
            {asms.length > 0 && (
              <>
                <Field label="Montagem"><select value={asmId} onChange={(ev) => up({ placement: { m: pl?.m ?? IDENTITY, assembly: (ev.target as HTMLSelectElement).value } })}>{asms.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
                <PlacementPick insts={insts} srcPart={f.part} thisPart={st.doc.id} asmId={asmId} value={pl} />
              </>
            )}
            {pl && <button class="small" onClick={() => up({ placement: undefined })}>Usar a mesma origem</button>}
          </fieldset>
          <p class="field-hint">A cópia fica nesta peça: planos e eixos publicados servem de referência para esboços; faces e superfícies passam a corpo de superfície; arestas e esboços a curva 3D; o corpo junta-se com a operação escolhida.</p>
        </>
      );
      break;
    }
    default:
      body = <p>Sem propriedades.</p>;
  }

  return (
    <div class="property-panel">
      <header>
        <h2>{e.isNew ? `Nova ${featureLabel(f).toLowerCase()}` : featureLabel(f)}</h2>
        <div class="actions">
          <button class="primary" onClick={() => store.confirmEdit()} disabled={st.busy && !st.result} title="Confirmar (Enter)">✓ OK</button>
          <button onClick={() => store.cancelEdit()} title="Cancelar (Esc)">✕</button>
        </div>
      </header>
      {helpForFeature(f) && <HelpCard h={helpForFeature(f)!} />}
      <Field label="Nome"><input value={f.name} onInput={(ev) => up({ name: (ev.target as HTMLInputElement).value })} /></Field>
      {body}
      <StatusBlock status={status} title={FEATURE_LABELS[f.type]} />
    </div>
  );
}
