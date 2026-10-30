// Arranque da aplicação e disposição geral.
import { partDensity } from "../assembly/bom.ts";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { initSolver } from "../sketch/solver.ts";
import { store, useStore } from "./store.ts";
import { Viewport } from "./viewport.ts";
import { Toolbar } from "./Toolbar.tsx";
import { FeatureTree } from "./FeatureTree.tsx";
import { PropertyPanel } from "./PropertyPanel.tsx";
import { SketchEditor } from "./SketchEditor.tsx";
import { PlaneChooser, VariablesDialog } from "./Dialogs.tsx";
import { MassBlock, SheetsBlock, StatusBlock } from "./InfoPanel.tsx";
import { describeName } from "./forms.tsx";
import { handleKey, runCommand, setCommandViewport } from "./commands.ts";
import { DocTabs } from "./DocTabs.tsx";
import { BomPanel } from "./BomPanel.tsx";
import { KnowledgePanel } from "./KnowledgePanel.tsx";
import { SimPanel } from "./SimPanel.tsx";
import { conditionAtFace, conditionFaceColors } from "./sim-actions.ts";
import { SimBrowser } from "./SimBrowser.tsx";
import { AssemblyTree, ComponentPanel, MatePanel } from "./AssemblyUI.tsx";
import { DrawingEditor } from "./DrawingEditor.tsx";
import { PartPropertiesDialog } from "./PropertiesDialog.tsx";
import { assemblyMesh, meshNameOf } from "../assembly/combine.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import { DEFAULT_DENSITY, docName } from "../doc/project.ts";
import { AnalysisPanel, ContextMenu, ContextToolbar, GestureHud, HeadsUpToolbar, OrientationMenu, ShortcutBar, featureOfPick } from "./Overlays.tsx";

const SURF: Record<string, string> = { plane: "plana", cylinder: "cilíndrica", cone: "cónica", sphere: "esférica", torus: "tórica", bspline: "livre (B-spline)", bezier: "livre (Bézier)", revolution: "de revolução", extrusion: "de extrusão" };
const CURVE: Record<string, string> = { line: "reta", circle: "circular", ellipse: "elíptica", bsplinecurve: "livre", beziercurve: "livre" };
import { resultView } from "./sim-client.ts";
import { PmiPanel } from "./PmiPanel.tsx";
import { ScriptPanel } from "./ScriptPanel.tsx";
import { GalkeelPanel } from "./GalkeelPanel.tsx";
import { CalcPanel } from "./CalcPanel.tsx";
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/500.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "./style.css";

function selectedKeys(): string[] {
  const { selection, edit, mateEdit } = store.state;
  const keys = selection.map((p) => (p.kind === "face" || p.kind === "edge" ? `${p.kind}:${p.name}` : p.kind === "region" ? `region:${p.sig.join("+")}` : `plane:${JSON.stringify(p.ref)}`));
  const d = edit?.draft as Record<string, unknown> | undefined;
  for (const field of ["refs", "faces"]) {
    const refs = d?.[field];
    if (Array.isArray(refs)) for (const r of refs as { kind: string; name: string }[]) keys.push(`${r.kind}:${r.name}`);
  }
  if (mateEdit) for (const r of [mateEdit.draft.a, mateEdit.draft.b]) { const n = meshNameOf(r); if (n) keys.push(`${"ref" in r ? r.ref.kind : "face"}:${n}`); }
  const regions = d?.regions;
  if (Array.isArray(regions)) for (const r of regions as { sig: string[] }[]) keys.push(`region:${r.sig.join("+")}`);
  return keys;
}

function App() {
  const st = useStore();
  const host = useRef<HTMLDivElement>(null);
  const vp = useRef<Viewport | null>(null);
  const fitted = useRef(false);
  const [hover, setHover] = useState<{ kind: "face" | "edge" | "plane"; type: string; name: string } | null>(null);
  const [showProps, setShowProps] = useState(false);
  const density = st.doc.properties?.density ?? DEFAULT_DENSITY;
  const setDensity = (d: number) => store.setPartProperties({ ...st.doc.properties, density: d });

  useEffect(() => {
    const v = new Viewport(host.current!, store.state.settings);
    v.onPick = (p, add, at) => {
      store.closeOverlays();
      store.pick(p, add);
      // barra de contexto junto à seleção (fora dos campos de seleção)
      if (!store.state.pickTarget && !add && store.state.selection.length === 1) store.set({ contextToolbar: { at, pick: p } });
    };
    v.onEmptyClick = () => { store.closeOverlays(); if (!store.state.pickTarget) store.clearSelection(); };
    v.onHover = setHover;
    v.onContextMenu = (at, pick) => store.set({ contextMenu: { at, pick }, contextToolbar: null });
    v.onGesture = (dir) => { store.set({ gesture: null }); runCommand(store.state.settings.gestures[dir]); };
    v.onGestureTrack = (dir, at) => store.set({ gesture: at ? { at, dir } : null });
    v.onBoxSelect = (picks, add) => store.setSelection(picks, add);
    v.onDoubleClick = (p) => {
      // espaços de simulação: duplo clique numa face com condição abre essa condição (nunca editar features às escuras)
      if (store.state.workspace === "fem" || store.state.workspace === "cfd") { conditionAtFace(p); return; }
      // duplo clique numa face/aresta: editar a feature que a criou
      if (store.state.active.kind === "assembly") {
        const name = p.kind === "face" || p.kind === "edge" ? p.name : "";
        if (name.includes("|")) store.set({ componentEdit: name.split("|")[0].split("/")[0] });
        return;
      }
      const fid = featureOfPick(p);
      if (fid && !store.state.edit && !store.state.sketch) store.editFeature(fid);
    };
    v.onPoleSelect = (i, j) => store.set({ poleSel: [i, j] });
    v.onPoleMoved = (i, j, d) => store.movePole(i, j, d);
    vp.current = v;
    setCommandViewport(v);
  }, []);

  // a montagem mostra-se como uma "peça" com a malha de todas as instâncias
  const asmView = useMemo<RebuildResponse | null>(() => {
    const r = st.asmResult;
    if (!r) return null;
    return { status: {}, variables: { values: {}, errors: {} }, ms: r.ms, reused: 0, mesh: assemblyMesh(r), sketches: {}, planes: {}, axes: {}, csys: {}, mass: r.mass, sheets: [] };
  }, [st.asmResult]);
  const lastKind = useRef(st.active.kind);
  useEffect(() => {
    const v = vp.current;
    if (!v) return;
    const kind = st.active.kind;
    if (kind !== lastKind.current) { fitted.current = false; lastKind.current = kind; }
    if (kind === "drawing") return;
    const result = kind === "assembly" ? asmView : st.result;
    const doc = kind === "assembly" ? { ...st.doc, features: [] } : store.displayDoc();
    v.update(result, doc, { hideSketch: st.sketch?.id, showPlanes: !st.sketch && (!result?.mesh || !!st.pickTarget?.accept.includes("plane") || st.choosingPlane) });
    v.setOverlay(kind === "assembly" ? st.interference?.pairs.map((x) => x.mesh) ?? [] : []);
    v.setSelected(selectedKeys());
    if (!fitted.current && result?.mesh) { v.view("iso", result, true); fitted.current = true; }
  }, [st.result, asmView, st.active, st.selection, st.edit, st.mateEdit, st.pickTarget, st.choosingPlane, st.sketch?.id, st.interference]);

  useEffect(() => { vp.current?.setAccept(st.pickTarget?.accept ?? null); }, [st.pickTarget]);
  useEffect(() => { vp.current?.setFeatureHighlight(st.hoverFeature); }, [st.hoverFeature]);
  useEffect(() => { vp.current?.setPreviewFeature(st.edit?.id ?? null); }, [st.edit?.id]);
  useEffect(() => { if (st.confirmed) vp.current?.flashFeature(st.confirmed.id); }, [st.confirmed]);
  // espaços FEM/CFD: o modelo mostra as faces com condições (apoios, cargas, entrada/saída)
  useEffect(() => { vp.current?.setConditionFaces(conditionFaceColors()); }, [st.workspace, st.simStudy, st.doc, st.project, st.active, st.result, st.asmResult]);
  useEffect(() => { vp.current?.setAnalysis(st.analysis); }, [st.analysis]);
  // resultados de simulação (FEM) no 3D
  useEffect(() => {
    const show = (st.workspace === "fem" || st.workspace === "cfd") && !st.simHidden && st.active.kind !== "drawing" && st.simResult?.doc === st.active.id;
    vp.current?.setSimResult(show ? resultView(st.simResult?.result) : null, st.simView);
  }, [st.simResult, st.simView, st.simHidden, st.workspace, st.active, st.result, st.asmResult]);
  // PMI 3D: rótulos no modelo (todos os itens com o painel aberto ou quando há uma vista de modelo aplicada)
  useEffect(() => {
    const v = vp.current;
    if (!v) return;
    v.onPmiClick = (id) => store.set({ sidePanel: "pmi", pmiSel: id });
    const doc = st.doc;
    const states = st.result?.pmi ?? [];
    const view = st.pmiView ? doc.modelViews?.find((x) => x.id === st.pmiView) : null;
    const show = st.active.kind === "part" && !st.sketch && (st.sidePanel === "pmi" || !!view) && states.length > 0;
    v.setPmi(show ? states.filter((x) => !view || view.items.includes(x.id)).map((x) => ({
      id: x.id, text: x.text, anchor: x.anchor, normal: x.normal, kind: doc.pmi?.find((p) => p.id === x.id)?.kind ?? "note", error: x.errors.length > 0, selected: st.pmiSel === x.id,
    })) : null);
  }, [st.result, st.sidePanel, st.pmiView, st.pmiSel, st.active, st.sketch]);
  // rede de controlo da forma livre em edição
  useEffect(() => {
    const d = st.edit?.draft;
    const net = d?.type === "freeform" ? st.result?.status[d.id]?.net ?? null : null;
    if (vp.current) { vp.current.poleAxis = st.poleAxis; vp.current.setPoleNet(net, st.poleSel); }
  }, [st.edit, st.result, st.poleSel, st.poleAxis]);
  // regiões do esboço da extrusão/revolução em edição, enquanto se escolhem ou se já há escolha
  useEffect(() => {
    const d = st.edit?.draft;
    const sk = d && (d.type === "extrude" || d.type === "revolve") ? d.sketch : null;
    const show = sk && (st.pickTarget?.field === "regions" || (d && "regions" in d && d.regions?.length));
    vp.current?.setRegions(show ? sk : null, show && sk ? st.result?.sketches[sk] ?? null : null);
    vp.current?.setSelected(selectedKeys());
  }, [st.edit, st.pickTarget, st.result]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT") return;
      // no esboço, o editor trata as suas teclas; aqui só as de ficheiro
      if (store.state.sketch && !((e.ctrlKey || e.metaKey) && ["s", "o", "n"].includes(e.key.toLowerCase()))) return;
      if (store.state.showVariables) return;
      handleKey(e);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!st.message) return;
    const t = setTimeout(() => store.set({ message: null }), 4000);
    return () => clearTimeout(t);
  }, [st.message]);

  const selFeature = st.selectedFeature ? st.doc.features.find((f) => f.id === st.selectedFeature) : undefined;
  const r = st.result;
  const kind = st.active.kind;
  // espaços de simulação: árvore do modelo à esquerda, editor da secção à direita
  const simWs = st.workspace === "fem" || st.workspace === "cfd";
  const errors = kind === "part" && r ? Object.values(r.status).filter((s) => s.state === "error").length : 0;

  return (
    <div class="app">
      <Toolbar />
      <DocTabs />
      <div class={`main ws-${st.workspace} ${kind === "drawing" ? "hidden-3d" : ""}`}>
        {kind === "drawing" && <DrawingEditor />}
        {simWs && kind !== "drawing" && <aside class="side ws-side" key={`ws-${st.workspace}`}><SimBrowser /></aside>}
        {!simWs && kind === "assembly" && (
          <aside class="side">
            {st.mateEdit ? <MatePanel /> : st.componentEdit ? <ComponentPanel /> : st.sidePanel === "bom" ? <BomPanel /> : (
              <>
                <AssemblyTree />
                <div class="side-info">
                  <MassBlock mass={st.asmResult?.mass ?? null} density={null} onDensity={() => {}}
                    totalMass={st.asmResult?.instances.reduce((m, i) => m + ((st.asmResult!.partMass[i.part]?.volume ?? 0) / 1000) * partDensity(st.project, i.part), 0)} />
                </div>
              </>
            )}
          </aside>
        )}
        {!simWs && kind === "part" && !st.sketch && (
          <aside class="side">
            {st.choosingPlane ? <PlaneChooser /> : st.edit ? <PropertyPanel /> : st.sidePanel === "knowledge" ? <KnowledgePanel /> : st.sidePanel === "sim" ? <SimPanel /> : st.sidePanel === "pmi" ? <PmiPanel /> : st.sidePanel === "script" ? <ScriptPanel /> : st.sidePanel === "galkeel" ? <GalkeelPanel /> : st.sidePanel === "calc" ? <CalcPanel /> : (
              <>
                <FeatureTree />
                <div class="side-info">
                  <button class="small" onClick={() => setShowProps(true)}>Propriedades da peça…</button>
                  {selFeature && <StatusBlock status={r?.status[selFeature.id]} title={selFeature.name} />}
                  <MassBlock mass={r?.mass ?? null} density={density} onDensity={setDensity} />
                  {r?.checks?.length ? (
                    <p class={r.checks.every((c) => c.ok) ? "muted" : "error-text"} role="status" aria-label="Verificações">
                      Verificações: {r.checks.filter((c) => c.ok).length}/{r.checks.length} cumpridas
                      {r.checks.filter((c) => !c.ok).map((c) => ` · ✗ ${c.name}`).join("")}
                      {r.config ? ` · configuração ${r.config}` : ""}
                    </p>
                  ) : r?.config ? <p class="muted">Configuração: {r.config}</p> : null}
                  <SheetsBlock sheets={r?.sheets ?? []} />
                  {st.selection.length > 0 && (
                    <p class="muted">{st.selection.length} selecionado(s) · os comandos usam a seleção (ex.: Filete com arestas, Esboço numa face).</p>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
        <section class="view" style={kind === "drawing" ? { display: "none" } : undefined}>
          <div ref={host} class="viewport" />
          {!st.sketch && <HeadsUpToolbar />}
          {kind === "assembly" && st.asmResult && !st.asmResult.instances.length && <div class="pick-banner">Insira componentes: ＋ Inserir componente (na árvore) ou separador Montagem</div>}
          {st.analysis && !st.sketch && <AnalysisPanel />}
          {st.sketch && <SketchEditor key={st.sketch.id} result={r} />}
          {st.pickTarget && !st.sketch && <div class="pick-banner">Modo de seleção: {st.pickTarget.accept.map((a) => ({ face: "faces", edge: "arestas", plane: "planos", axis: "eixos", region: "regiões" })[a]).join(" / ")} · Esc para terminar</div>}
        </section>
        {simWs && kind !== "drawing" && <aside class="side side-right ws-side" key={`ws-r-${st.workspace}`}><SimPanel /></aside>}
      </div>
      <footer class="statusbar">
        <span class={st.busy ? "busy" : ""}>{st.busy ? "A reconstruir…" : r ? `Reconstruído em ${r.ms} ms (${r.reused} da cache)` : "A carregar o núcleo geométrico…"}</span>
        {errors > 0 && <span class="err">{errors} feature(s) com erro</span>}
        {st.error && <span class="err" role="alert">{st.error}</span>}
        {st.message && <span class="msg">{st.message}</span>}
        <span class="grow" />
        {hover && (
          <span class="muted" title={hover.name}>
            {hover.kind === "plane" ? hover.name
              : hover.kind === "face" ? `Face ${SURF[hover.type] ?? hover.type} · ${describeName(st.doc, hover.name)}`
              : `Aresta ${CURVE[hover.type] ?? hover.type} · ${describeName(st.doc, hover.name).replace(/^Aresta: /, "")}`}
          </span>
        )}
        <span class="muted">{st.project.name} · {docName(st.project, st.active)}{st.dirty ? " •" : ""} · mm</span>
      </footer>
      {st.showVariables && <VariablesDialog />}
      {showProps && <PartPropertiesDialog onClose={() => setShowProps(false)} />}
      {(st.contextMenu || st.shortcutBar || st.orientationMenu) && <div class="overlay-catcher" onPointerDown={() => store.closeOverlays()} onContextMenu={(e) => { e.preventDefault(); store.closeOverlays(); }} />}
      {st.contextMenu && <ContextMenu />}
      {st.contextToolbar && !st.edit && !st.sketch && <ContextToolbar />}
      {st.shortcutBar && <ShortcutBar />}
      {st.orientationMenu && <OrientationMenu />}
      {st.gesture && <GestureHud />}
    </div>
  );
}

initSolver(gcsWasm).then(() => render(<App />, document.getElementById("root")!));
