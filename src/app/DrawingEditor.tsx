// Editor de desenhos 2D: folha, vistas e ferramentas de anotação (o painel lateral está em drawing-panel.tsx).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type DrawingDoc, type NewAnnotation } from "../doc/project.ts";
import { renderDrawing, pickEdge, toView, type Layout } from "../drawing/render.ts";
import { primToSvg } from "../drawing/svg.ts";
import { addAnnotation, addView, deleteView, moveAnnotation, moveView, nextLetter, sideOf, smartDimension } from "../drawing/edit.ts";
import { curvePoints } from "../drawing/geom2d.ts";
import { type DrawingTool, store, useStoreKeys } from "./store.ts";
import { DrawingPanel, rootAsmOf } from "./drawing-panel.tsx";

type P = [number, number];

const TOOL_HINT: Record<string, string> = {
  modelView: "Clique na folha para colocar a vista.",
  projected: "Clique numa vista-mãe e depois ao lado dela (direita, esquerda, cima ou baixo).",
  section: "Clique numa vista-mãe; depois dois pontos da linha de corte; depois o sítio da vista.",
  detail: "Clique numa vista-mãe no centro do pormenor; depois o raio; depois o sítio da vista.",
  auxiliary: "Clique numa aresta reta de uma vista; depois o sítio da vista auxiliar.",
  dim: "Clique numa ou duas arestas; depois o sítio da cota. Círculo → diâmetro, arco → raio, reta → comprimento.",
  note: "Clique numa aresta (para ter linha de chamada) ou diretamente na folha.",
  gdt: "Clique na aresta a tolerar; depois o sítio do quadro.",
  datum: "Clique na aresta de referência; depois o sítio da letra.",
  surface: "Clique na aresta (superfície) onde assenta o símbolo.",
  weld: "Clique na junta (aresta); depois o sítio da linha de referência.",
  balloon: "Clique numa aresta de um componente numa vista de montagem; depois o sítio do balão.",
  bom: "Clique na folha para colocar o canto superior esquerdo da tabela.",
};

export function DrawingEditor() {
  useStoreKeys("active", "project"); // subscreve o store: re-renderiza quando o desenho ativo muda
  const d = store.activeDrawing();
  if (!d) return null;
  return (
    <div class="drawing-mode">
      <aside class="side"><DrawingPanel d={d} /></aside>
      <SheetCanvas d={d} />
    </div>
  );
}

function SheetCanvas({ d }: { d: DrawingDoc }) {
  const st = useStoreKeys("drawingResult", "project", "drawingTool", "drawingSel", "active");
  const res = st.drawingResult;
  const layout = useMemo<Layout>(() => renderDrawing(d, st.project, res), [d, st.project, res]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<{ x: number; y: number; w: number } | null>(null);
  const [hover, setHover] = useState<{ view: string; edge: string; pts: P[] } | null>(null);
  const [ghost, setGhost] = useState<P | null>(null);
  const drag = useRef<{ kind: "pan" | "move"; start: P; last: P; moved: boolean; client: [number, number] } | null>(null);
  const tool = st.drawingTool;
  const H = layout.h;

  const [, force] = useState(0);
  useEffect(() => { setVb(null); }, [d.sheet.size, d.sheet.orientation]);
  useEffect(() => { const ro = new ResizeObserver(() => force((x) => x + 1)); if (svgRef.current) ro.observe(svgRef.current); return () => ro.disconnect(); }, []);
  const el = svgRef.current;
  const aspect = el && el.clientWidth ? el.clientHeight / el.clientWidth : layout.h / layout.w;
  // ajustar: a folha inteira à vista, com margem
  const fitW = Math.max(layout.w + 10, (layout.h + 10) / aspect);
  const view = vb ?? { x: (layout.w - fitW) / 2, y: (layout.h - fitW * aspect) / 2, w: fitW };
  const vh = view.w * aspect;

  /** Ponto da folha (mm, y para cima) sob o rato. */
  const sheetPt = (e: { clientX: number; clientY: number }): P => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = view.x + ((e.clientX - r.left) / r.width) * view.w;
    const ySvg = view.y + ((e.clientY - r.top) / r.height) * vh;
    return [x, H - ySvg];
  };
  const tol = view.w / 150;

  const viewAt = (q: P) => d.views.find((v) => { const b = layout.views[v.id]?.box; return b && q[0] >= b[0] - 3 && q[0] <= b[2] + 3 && q[1] >= b[1] - 3 && q[1] <= b[3] + 3; });
  const annAt = (q: P) => [...d.annotations].reverse().find((a) => { const b = layout.ann[a.id]; return b && q[0] >= b[0] - 1.5 && q[0] <= b[2] + 1.5 && q[1] >= b[1] - 1.5 && q[1] <= b[3] + 1.5; });

  const commit = (doc: DrawingDoc, label: string, merge = false) => store.commitDrawing(doc, label, merge);
  const setTool = (t: DrawingTool | null) => store.set({ drawingTool: t });

  const needsEdge = tool && ["auxiliary", "dim", "note", "gdt", "datum", "surface", "weld", "balloon"].includes(tool.kind);

  const onClick = (q: P) => {
    if (!tool) {
      const a = annAt(q);
      if (a) { store.set({ drawingSel: { kind: "ann", id: a.id } }); return; }
      const v = viewAt(q);
      store.set({ drawingSel: v ? { kind: "view", id: v.id } : null });
      return;
    }
    const edge = pickEdge(res, layout.views, q, tol * 1.5);
    switch (tool.kind) {
      case "modelView": {
        const r = addView(d, { kind: "model", source: tool.source, orientation: tool.orientation, at: q });
        commit(r.doc, "Vista de modelo"); setTool(null); store.set({ drawingSel: { kind: "view", id: r.id } });
        return;
      }
      case "projected": {
        if (!tool.parent) { const v = viewAt(q); if (v) setTool({ ...tool, parent: v.id }); return; }
        const pp = layout.views[tool.parent];
        if (!pp) return;
        const r = addView(d, { kind: "projected", parent: tool.parent, side: sideOf(pp, q), at: q });
        commit(r.doc, "Vista projetada"); setTool({ kind: "projected", parent: tool.parent });
        return;
      }
      case "section": case "detail": {
        if (!tool.parent) { const v = viewAt(q); if (v) setTool({ ...tool, parent: v.id, points: [] }); return; }
        const pp = layout.views[tool.parent];
        const pts = tool.points ?? [];
        if (pts.length < 2) {
          let lp = toView(pp, q);
          // linha de corte: fica horizontal/vertical se estiver quase
          if (tool.kind === "section" && pts.length === 1) {
            const dx = lp[0] - pts[0][0], dy = lp[1] - pts[0][1];
            if (Math.abs(dy) < Math.abs(dx) * 0.1) lp = [lp[0], pts[0][1]]; else if (Math.abs(dx) < Math.abs(dy) * 0.1) lp = [pts[0][0], lp[1]];
          }
          setTool({ ...tool, points: [...pts, lp] });
          return;
        }
        const label = nextLetter(d);
        const r = tool.kind === "section"
          ? addView(d, { kind: "section", parent: tool.parent, a: pts[0], b: pts[1], label, at: q, name: `Corte ${label}-${label}` })
          : addView(d, { kind: "detail", parent: tool.parent, center: pts[0], radius: Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), label, at: q, name: `Pormenor ${label}`, scale: (pp?.s ?? 1) * 2 });
        commit(r.doc, tool.kind === "section" ? "Corte" : "Pormenor"); setTool(null); store.set({ drawingSel: { kind: "view", id: r.id } });
        return;
      }
      case "auxiliary": {
        if (!tool.edge) { if (edge && edge.curve.k === "l") setTool({ ...tool, parent: edge.view, edge: edge.edge }); else store.set({ message: "Escolha uma aresta reta" }); return; }
        const r = addView(d, { kind: "auxiliary", parent: tool.parent!, edge: tool.edge, at: q });
        commit(r.doc, "Vista auxiliar"); setTool(null);
        return;
      }
      case "bom": {
        const asm = d.views.map((v) => rootAsmOf(d, v)).find(Boolean) ?? st.project.assemblies[0]?.id;
        if (!asm) { store.set({ error: "Não há montagens no projeto" }); return; }
        const r = addAnnotation(d, { kind: "bom", at: q, source: asm, mode: "top" });
        commit(r.doc, "Tabela de BOM"); setTool(null); store.set({ drawingSel: { kind: "ann", id: r.id } });
        return;
      }
      default: {
        const picks = tool.picks ?? [];
        const max = tool.kind === "dim" ? 2 : 1;
        if (edge && picks.length < max && !(picks.length && tool.kind !== "dim")) {
          if (tool.kind === "balloon" && !res?.views[edge.view]?.edgeComponent?.[edge.edge]) { store.set({ message: "Escolha uma aresta de um componente (vista de montagem)" }); return; }
          setTool({ ...tool, picks: [...picks, { view: edge.view, edge: edge.edge, at: q }] });
          return;
        }
        placeAnnotation(d, tool, picks, q);
      }
    }
  };

  const placeAnnotation = (doc: DrawingDoc, t: Extract<DrawingTool, { picks?: unknown }>, picks: { view: string; edge: string; at: P }[], q: P) => {
    const anchor = picks[0] ? { view: picks[0].view, edge: picks[0].edge, at: "mid" as const } : undefined;
    let a: NewAnnotation | null = null;
    switch (t.kind) {
      case "dim": a = smartDimension(res, layout.views, picks, q); if (!a) { store.set({ message: "Escolha primeiro uma aresta" }); return; } break;
      case "note": a = { kind: "note", at: q, text: "Nota", leader: anchor }; break;
      case "gdt": a = { kind: "gdt", at: q, leader: anchor, char: "flatness", tol: "0,05", datums: [] }; break;
      case "datum": if (!anchor) return; a = { kind: "datum", at: q, anchor, letter: nextLetter(doc) }; break;
      case "surface": a = { kind: "surface", at: q, anchor: anchor ?? undefined, process: "removal", value: "Ra 3,2" }; if (!anchor) a = { ...a, anchor: { view: viewAt(q)?.id ?? "", point: [0, 0] } }; break;
      case "weld": if (!anchor) return; a = { kind: "weld", at: q, anchor, symbol: "fillet", size: "a5" }; break;
      case "balloon": {
        if (!picks[0]) return;
        const comp = res?.views[picks[0].view]?.edgeComponent?.[picks[0].edge];
        if (!comp) return;
        a = { kind: "balloon", at: q, view: picks[0].view, component: comp, edge: picks[0].edge };
        break;
      }
    }
    if (t.kind === "surface" && !anchor) {
      // sem aresta: o símbolo fica no ponto clicado (âncora fixa na vista sob o cursor, ou na folha)
      const v = viewAt(q);
      const pl = v && layout.views[v.id];
      a = { kind: "surface", at: q, anchor: pl ? { view: v!.id, point: toView(pl, q) } : undefined, process: "removal", value: "Ra 3,2" };
    }
    const r = addAnnotation(doc, a!);
    commit(r.doc, "Anotação");
    store.set({ drawingSel: { kind: "ann", id: r.id }, drawingTool: { kind: t.kind } as DrawingTool });
  };

  // teclas: Esc cancela a ferramenta, Delete apaga a seleção
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT") return;
      if (e.key === "Escape") { store.set({ drawingTool: null, drawingSel: null }); e.stopImmediatePropagation(); }
      if (e.key === "Delete" || e.key === "Backspace") {
        const s = store.state.drawingSel;
        const doc = store.activeDrawing();
        if (!s || !doc) return;
        commit(s.kind === "view" ? deleteView(doc, s.id) : { ...doc, annotations: doc.annotations.filter((a) => a.id !== s.id) }, "Apagar");
        store.set({ drawingSel: null });
        e.stopImmediatePropagation();
      }
      if (e.key === "f" || e.key === "F") setVb(null);
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  const onDown = (e: PointerEvent) => {
    const q = sheetPt(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.shiftKey && !tool)) { drag.current = { kind: "pan", start: q, last: q, moved: false, client: [e.clientX, e.clientY] }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (!tool) {
      const a = annAt(q), v = a ? undefined : viewAt(q);
      const sel = a ? { kind: "ann" as const, id: a.id } : v ? { kind: "view" as const, id: v.id } : null;
      store.set({ drawingSel: sel });
      if (sel) drag.current = { kind: "move", start: q, last: q, moved: false, client: [e.clientX, e.clientY] };
      return;
    }
    drag.current = { kind: "move", start: q, last: q, moved: false, client: [e.clientX, e.clientY] };
  };
  const onMove = (e: PointerEvent) => {
    const q = sheetPt(e);
    setGhost(q);
    const g = drag.current;
    if (g) {
      if (Math.hypot(e.clientX - g.client[0], e.clientY - g.client[1]) > 3) g.moved = true;
      if (g.kind === "pan") {
        const r = svgRef.current!.getBoundingClientRect();
        const k = view.w / r.width;
        setVb({ x: view.x - e.movementX * k, y: view.y - e.movementY * k, w: view.w });
        return;
      }
      if (!tool && g.moved && st.drawingSel) {
        const delta: P = [q[0] - g.last[0], q[1] - g.last[1]];
        g.last = q;
        const doc = store.activeDrawing()!;
        if (st.drawingSel.kind === "view") {
          const v = doc.views.find((x) => x.id === st.drawingSel!.id)!;
          const pl = layout.views[v.id];
          commit(moveView(doc, v.id, [(pl?.at[0] ?? v.at[0]) + delta[0], (pl?.at[1] ?? v.at[1]) + delta[1]]), "Mover vista", true);
        } else commit(moveAnnotation(doc, st.drawingSel.id, delta, res, q), "Mover anotação", true);
        return;
      }
    }
    if (needsEdge) {
      const pe = pickEdge(res, layout.views, q, tol * 1.5);
      const pl = pe && layout.views[pe.view];
      setHover(pe && pl ? { view: pe.view, edge: pe.edge, pts: curvePoints(pe.curve).map((p) => [pl.at[0] + pl.s * (p[0] - pl.c[0]), pl.at[1] + pl.s * (p[1] - pl.c[1])]) } : null);
    } else if (hover) setHover(null);
  };
  const onUp = (e: PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g || g.kind === "pan") return;
    if (!g.moved && (tool || e.button === 0)) onClick(sheetPt(e));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const q = sheetPt(e);
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.max(20, Math.min(layout.w * 4, view.w * k));
    const qy = H - q[1];
    setVb({ x: q[0] - (q[0] - view.x) * (w / view.w), y: qy - (qy - view.y) * (w / view.w), w });
  };

  const body = useMemo(() => layout.prims.map((p) => primToSvg(p, H)).join(""), [layout]);
  const selBox = st.drawingSel ? (st.drawingSel.kind === "view" ? layout.views[st.drawingSel.id]?.box : layout.ann[st.drawingSel.id]) : undefined;
  const pendingPts = tool && "points" in tool && tool.parent ? tool.points?.map((p) => { const pl = layout.views[tool.parent!]; return pl ? [pl.at[0] + pl.s * (p[0] - pl.c[0]), pl.at[1] + pl.s * (p[1] - pl.c[1])] as P : p; }) : undefined;
  return (
    <section class="sheet-view">
      {tool && <div class="pick-banner">{TOOL_HINT[tool.kind]} · Esc para terminar</div>}
      <svg ref={svgRef} class="sheet-svg" data-testid="sheet" viewBox={`${view.x} ${view.y} ${view.w} ${vh}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}
        onDblClick={() => setVb(null)}>
        <rect x={0} y={0} width={layout.w} height={layout.h} fill="#fff" />
        <g dangerouslySetInnerHTML={{ __html: body }} />
        {selBox && <rect class="sel-box" x={selBox[0] - 2} y={H - selBox[3] - 2} width={selBox[2] - selBox[0] + 4} height={selBox[3] - selBox[1] + 4} />}
        {hover && <polyline class="hover-edge" points={hover.pts.map((p) => `${p[0]},${H - p[1]}`).join(" ")} />}
        {tool && "picks" in tool && tool.picks?.map((p, i) => <circle key={i} class="pick-dot" cx={p.at[0]} cy={H - p.at[1]} r={1.2} />)}
        {pendingPts?.map((p, i) => <circle key={i} class="pick-dot" cx={p[0]} cy={H - p[1]} r={1.2} />)}
        {pendingPts && pendingPts.length === 1 && ghost && tool?.kind === "section" && <line class="hover-edge" x1={pendingPts[0][0]} y1={H - pendingPts[0][1]} x2={ghost[0]} y2={H - ghost[1]} />}
        {pendingPts && pendingPts.length === 1 && ghost && tool?.kind === "detail" && <circle class="hover-edge" cx={pendingPts[0][0]} cy={H - pendingPts[0][1]} r={Math.hypot(ghost[0] - pendingPts[0][0], ghost[1] - pendingPts[0][1])} fill="none" />}
      </svg>
      {layout.warnings.length > 0 && <div class="sheet-warn">{layout.warnings.slice(0, 3).map((w, i) => <p key={i} class="warn">⚠ {w}</p>)}</div>}
    </section>
  );
}
