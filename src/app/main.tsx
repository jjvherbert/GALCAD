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
    const v = new Viewport(host.current!);
    v.onPick = (p, add) => store.pick(p, add);
    v.onEmptyClick = () => { if (!store.state.pickTarget) store.clearSelection(); };
    v.onHover = setHover;
    vp.current = v;
  }, []);

  useEffect(() => {
    const v = vp.current;
    if (!v) return;
    v.update(st.result, store.displayDoc(), { hideSketch: st.sketch?.id, showPlanes: !st.result?.mesh || !!st.pickTarget?.accept.includes("plane") || st.choosingPlane });
    v.setSelected(selectedKeys());
    if (!fitted.current && st.result?.mesh) { v.view("iso", st.result); fitted.current = true; }
  }, [st.result, st.selection, st.edit, st.pickTarget, st.choosingPlane, st.sketch?.id]);

  useEffect(() => { vp.current?.setAccept(st.pickTarget?.accept ?? null); }, [st.pickTarget]);
  useEffect(() => { try { localStorage.setItem("cad-prototipo:density", String(density)); } catch { /* ignorar */ } }, [density]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (store.state.sketch || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT") return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); store.undo(); }
      else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); store.redo(); }
      else if (k === "escape") { if (store.state.pickTarget) store.set({ pickTarget: null }); else if (store.state.edit) store.cancelEdit(); else store.clearSelection(); }
      else if (k === "enter" && store.state.edit) store.confirmEdit();
      else if (k === "f") vp.current?.fit(store.state.result);
      else if ((k === "delete") && store.state.selectedFeature && !store.state.edit) store.deleteFeature(store.state.selectedFeature);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!st.message) return;
    const t = setTimeout(() => store.set({ message: null }), 4000);
    return () => clearTimeout(t);
  }, [st.message]);

  const onView = (name: "iso" | "front" | "top" | "right" | "fit") => {
    const v = vp.current;
    if (!v) return;
    if (name === "fit") v.fit(st.result); else v.view(name, st.result);
  };

  const selFeature = st.selectedFeature ? st.doc.features.find((f) => f.id === st.selectedFeature) : undefined;
  const r = st.result;
  const errors = r ? Object.values(r.status).filter((s) => s.state === "error").length : 0;

  return (
    <div class="app">
      <Toolbar onView={onView} />
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
    </div>
  );
}

initSolver(gcsWasm).then(() => render(<App />, document.getElementById("root")!));
