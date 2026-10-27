// Arranque da aplicação e disposição geral.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { initSolver } from "../sketch/solver.ts";
import { store, useStore } from "./store.ts";
import { Viewport } from "./viewport.ts";
import { Toolbar } from "./Toolbar.tsx";
import { FeatureTree } from "./FeatureTree.tsx";
import { PropertyPanel } from "./PropertyPanel.tsx";
import { SketchEditor } from "./SketchEditor.tsx";
import { PlaneChooser, VariablesDialog } from "./Dialogs.tsx";
import { MassBlock, StatusBlock } from "./InfoPanel.tsx";
import { describeName } from "./forms.tsx";
import { handleKey, runCommand, setCommandViewport } from "./commands.ts";
import { ContextMenu, ContextToolbar, GestureHud, HeadsUpToolbar, OrientationMenu, ShortcutBar, featureOfPick } from "./Overlays.tsx";

const SURF: Record<string, string> = { plane: "plana", cylinder: "cilíndrica", cone: "cónica", sphere: "esférica", torus: "tórica", bspline: "livre (B-spline)", bezier: "livre (Bézier)", revolution: "de revolução", extrusion: "de extrusão" };
const CURVE: Record<string, string> = { line: "reta", circle: "circular", ellipse: "elíptica", bsplinecurve: "livre", beziercurve: "livre" };
import "./style.css";

function selectedKeys(): string[] {
  const { selection, edit } = store.state;
  const keys = selection.map((p) => (p.kind === "face" || p.kind === "edge" ? `${p.kind}:${p.name}` : `plane:${JSON.stringify(p.ref)}`));
  const d = edit?.draft as Record<string, unknown> | undefined;
  for (const field of ["refs", "faces"]) {
    const refs = d?.[field];
    if (Array.isArray(refs)) for (const r of refs as { kind: string; name: string }[]) keys.push(`${r.kind}:${r.name}`);
  }
  return keys;
}

function App() {
  const st = useStore();
  const host = useRef<HTMLDivElement>(null);
  const vp = useRef<Viewport | null>(null);
  const fitted = useRef(false);
  const [hover, setHover] = useState<{ kind: "face" | "edge" | "plane"; type: string; name: string } | null>(null);
  const [density, setDensity] = useState(() => { try { return Number(localStorage.getItem("cad-prototipo:density")) || 7.85; } catch { return 7.85; } });

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
      // duplo clique numa face/aresta: editar a feature que a criou
      const fid = featureOfPick(p);
      if (fid && !store.state.edit && !store.state.sketch) store.editFeature(fid);
    };
    vp.current = v;
    setCommandViewport(v);
  }, []);

  useEffect(() => {
    const v = vp.current;
    if (!v) return;
    v.update(st.result, store.displayDoc(), { hideSketch: st.sketch?.id, showPlanes: !st.result?.mesh || !!st.pickTarget?.accept.includes("plane") || st.choosingPlane });
    v.setSelected(selectedKeys());
    if (!fitted.current && st.result?.mesh) { v.view("iso", st.result); fitted.current = true; }
  }, [st.result, st.selection, st.edit, st.pickTarget, st.choosingPlane, st.sketch?.id]);

  useEffect(() => { vp.current?.setAccept(st.pickTarget?.accept ?? null); }, [st.pickTarget]);
  useEffect(() => { vp.current?.setFeatureHighlight(st.hoverFeature); }, [st.hoverFeature]);
  useEffect(() => { try { localStorage.setItem("cad-prototipo:density", String(density)); } catch { /* ignorar */ } }, [density]);

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
  const errors = r ? Object.values(r.status).filter((s) => s.state === "error").length : 0;

  return (
    <div class="app">
      <Toolbar />
      <div class="main">
        {!st.sketch && (
          <aside class="side">
            {st.choosingPlane ? <PlaneChooser /> : st.edit ? <PropertyPanel /> : (
              <>
                <FeatureTree />
                <div class="side-info">
                  {selFeature && <StatusBlock status={r?.status[selFeature.id]} title={selFeature.name} />}
                  <MassBlock mass={r?.mass ?? null} density={density} onDensity={setDensity} />
                  {st.selection.length > 0 && (
                    <p class="muted">{st.selection.length} selecionado(s) · os comandos usam a seleção (ex.: Filete com arestas, Esboço numa face).</p>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
        <section class="view">
          <div ref={host} class="viewport" />
          {!st.sketch && <HeadsUpToolbar />}
          {st.sketch && <SketchEditor key={st.sketch.id} result={r} />}
          {st.pickTarget && !st.sketch && <div class="pick-banner">Modo de seleção: {st.pickTarget.accept.map((a) => ({ face: "faces", edge: "arestas", plane: "planos", axis: "eixos" })[a]).join(" / ")} · Esc para terminar</div>}
        </section>
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
        <span class="muted">{st.doc.name}{st.dirty ? " •" : ""} · mm</span>
      </footer>
      {st.showVariables && <VariablesDialog />}
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
