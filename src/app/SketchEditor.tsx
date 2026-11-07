// Editor de esboço 2D (SVG): desenho, seleção, arrasto com o solver, restrições e cotas.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConstraintType, SketchEntity } from "../doc/types.ts";
import { projTolOf, refEdgesOf, refGroupsOf } from "./sketch-ref.ts";
import { type HitOpts, hitAtIn, hitRefIn, snapIn } from "./sketch-hit.ts";
import { finishSplineIn, handleClick } from "./sketch-click.ts";
import { convertEdges } from "./sketch-convert.ts";
import { type ChamferMode, type LastValues, type Prompt, LAST_DEFAULTS, applyPromptIn, saveDimIn } from "./sketch-cmd.ts";
import { ChamferModeSelect, ChamferPreview, PromptBox, withChamferMode } from "./SketchChamferUI.tsx";
import { pathOf, previewOf } from "./sketch-draw.tsx";
import { History } from "../doc/history.ts";
import { type P2, allEntities, entityPoints, isImplicit, measure, pt } from "../sketch/geometry.ts";
import { solveSketch, freeEntities, type DragTarget, type SolveResult } from "../sketch/solver.ts";
import { isLineCorner } from "../sketch/modify.ts";
import { type SketchData, CONSTRAINT_GLYPH, CONSTRAINT_LABEL, applicableConstraints, applyConstraint, deleteItems, roundDim, smartDimension, toggleConstruction } from "../sketch/ops.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import { store, useStoreKeys } from "./store.ts";
import { commandViewport } from "./commands.ts";
import { type Draw, type DimMode, type Snap, type Tool, GEOM_CONSTRAINTS, TOOLS, fmt } from "./sketch-types.ts";
import { Constraints, Dimensions, Grid, labelPos } from "./SketchOverlays.tsx";


export function SketchEditor({ result }: { result: RebuildResponse | null }) {
  // `settings`: a quadrícula (sketchGrid) é lida no render
  const st = useStoreKeys("sketch", "settings");
  const edit = st.sketch!;
  const draft = edit.draft;
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([800, 600]);
  const [view, setView] = useState<{ k: number; tx: number; ty: number } | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [dimMode, setDimMode] = useState<DimMode>("auto");
  const [mirrorKeep, setMirrorKeep] = useState(true);
  const [chamferMode, setChamferMode] = useState<ChamferMode>("equal");
  const [sel, setSel] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Draw | null>(null);
  const [mouse, setMouse] = useState<P2 | null>(null);
  const [dimEdit, setDimEdit] = useState<{ id: string; text: string } | null>(null);
  /** Pedido de valor para filete de canto (raio) ou deslocamento (distância). */
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const lastValue = useRef<LastValues>({ ...LAST_DEFAULTS });
  const [info, setInfo] = useState<SolveResult | null>(null);
  const [free, setFree] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const hist = useRef(new History<SketchData>({ state: { entities: draft.entities, constraints: draft.constraints }, label: "início" }));
  const drag = useRef<{ mode: "points" | "radius" | "pan" | "label"; ids: string[]; start: P2; base: SketchData; screen: [number, number]; moved: boolean; t0: [number, number] } | null>(null);
  const lastMiddle = useRef(0);
  const freeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scope = (n: string) => result?.variables.values[n];
  const frame = result?.sketches[edit.id]?.frame;
  const ents = useMemo(() => allEntities(draft), [draft]);

  // --- solver -------------------------------------------------------------------
  const scheduleFree = (s: SketchData) => {
    clearTimeout(freeTimer.current);
    freeTimer.current = setTimeout(() => setFree(freeEntities(s, scope)), 150);
  };
  useEffect(() => {
    // entidades convertidas: posições atualizadas pelo núcleo (projeção das arestas do modelo)
    const fromKernel = result?.sketches[edit.id]?.entities;
    let start = draft;
    if (fromKernel) {
      const entities = { ...draft.entities };
      for (const [id, e] of Object.entries(draft.entities)) {
        if (!("ext" in e) || !e.ext || !fromKernel[id]) continue;
        entities[id] = fromKernel[id];
        for (const p of entityPoints(e)) if (fromKernel[p]) entities[p] = fromKernel[p];
      }
      start = { ...draft, entities };
    }
    const r = solveSketch(start, scope);
    setInfo(r);
    if (r.ok) store.updateSketch({ ...draft, entities: r.entities });
    scheduleFree(draft);
  }, []);

  /** Resolve e aplica; devolve false se a alteração for rejeitada (conflito). */
  function commit(next: SketchData, label: string, opts: { drivenOnConflict?: string } = {}): boolean {
    let r = solveSketch(next, scope);
    let note: string | null = null;
    if (!r.ok && opts.drivenOnConflict) {
      next = { ...next, constraints: next.constraints.map((c) => (c.id === opts.drivenOnConflict ? { ...c, driven: true } : c)) };
      r = solveSketch(next, scope);
      note = "A cota sobre-definia o esboço: foi criada como cota de referência (não comanda).";
    }
    if (!r.ok) {
      const names = r.conflicting.map((id) => CONSTRAINT_LABEL[next.constraints.find((c) => c.id === id)?.type ?? "coincident"]).join(", ");
      setMsg(`${r.message ?? "Erro"}${names ? `: ${names}` : ""}. Alteração anulada.`);
      return false;
    }
    const solved = { entities: r.entities, constraints: next.constraints };
    hist.current.push(solved, label);
    store.updateSketch({ ...draft, ...solved });
    setInfo(r);
    setMsg(note);
    scheduleFree(solved);
    return true;
  }

  // --- vista --------------------------------------------------------------------
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const projTol = projTolOf(result);
  const refGroups = useMemo(() => refGroupsOf(result, frame, projTol), [result, frame]);
  const refEdges = useMemo(() => refEdgesOf(result, frame, projTol), [result, frame]);

  useEffect(() => {
    if (view || size[0] < 10) return;
    const pts: P2[] = [];
    for (const e of Object.values(draft.entities)) if (e.type === "point") pts.push([e.x, e.y]);
    for (const c of draft.constraints) if (c.pos) pts.push(c.pos);
    for (const [a, b] of [...refEdges.inPlane, ...refEdges.other]) pts.push(a, b);
    if (!pts.length) { setView({ k: Math.min(size[0], size[1]) / 200, tx: size[0] / 2, ty: size[1] / 2 }); return; }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs, 0), Math.max(...xs, 0), Math.min(...ys, 0), Math.max(...ys, 0)];
    const k = Math.min(size[0] / Math.max(1, x1 - x0), size[1] / Math.max(1, y1 - y0)) * 0.7;
    setView({ k, tx: size[0] / 2 - ((x0 + x1) / 2) * k, ty: size[1] / 2 + ((y0 + y1) / 2) * k });
  }, [size, refEdges, view]);

  const v = view ?? { k: 2, tx: size[0] / 2, ty: size[1] / 2 };
  // o modelo 3D vê-se por trás do esboço (fundo transparente, como no SolidWorks): a câmara fica
  // normal ao plano e alinhada com este editor; a primeira vez desliza do ponto de vista da peça
  const first = useRef(true);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    const vp = commandViewport();
    if (!vp || !frame || !view || !wrap.current || size[0] < 10) return;
    vp.setSketchCamera(frame, view.k, view.tx, view.ty, wrap.current, first.current);
    if (first.current) { first.current = false; window.setTimeout(() => setEntered(true), vp.animate ? 320 : 0); }
  }, [frame, view?.k, view?.tx, view?.ty, size[0], size[1]]);
  useEffect(() => () => commandViewport()?.leaveSketchView(), []);
  const S = (p: P2): [number, number] => [p[0] * v.k + v.tx, -p[1] * v.k + v.ty];
  const W = (sx: number, sy: number): P2 => [(sx - v.tx) / v.k, -(sy - v.ty) / v.k];
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // --- acerto e seleção -------------------------------------------------------------
  function hitAt(sx: number, sy: number, opts: HitOpts = {}): string | null { return hitAtIn({ ents, S, W }, sx, sy, opts); }

  function snap(sx: number, sy: number, exclude?: Set<string>): Snap { return snapIn({ ents, S, W }, sx, sy, exclude); }

  const data = (): SketchData => ({ entities: draft.entities, constraints: draft.constraints });

  function hitRef(sx: number, sy: number): number { return hitRefIn(refGroups, S, sx, sy); }

  const converted = new Set(Object.values(draft.entities).flatMap((e) => ("ext" in e && e.ext ? [e.ext.name] : [])));

  /** Converte arestas do modelo em entidades ligadas (pontos fixos, atualizados pelo núcleo). */
  function convert(groups: typeof refGroups) { convertEdges({ draft, converted, commit, setMsg }, groups); }

  // --- rato -----------------------------------------------------------------------
  function onDown(e: PointerEvent) {
    const [sx, sy] = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || (tool === "select" && !hitAt(sx, sy))) {
      drag.current = { mode: "pan", ids: [], start: W(sx, sy), base: data(), screen: [sx, sy], moved: false, t0: [v.tx, v.ty] };
      return;
    }
    if (tool !== "select") return;
    const id = hitAt(sx, sy)!;
    const e2 = ents[id];
    const base = data();
    if (e2.type === "point" && !isImplicit(id)) drag.current = { mode: "points", ids: [id], start: W(sx, sy), base, screen: [sx, sy], moved: false, t0: [0, 0] };
    else if (e2.type === "line" && !isImplicit(id)) drag.current = { mode: "points", ids: [e2.p1, e2.p2].filter((p) => !isImplicit(p)), start: W(sx, sy), base, screen: [sx, sy], moved: false, t0: [0, 0] };
    else if (e2.type === "circle" || e2.type === "arc") drag.current = { mode: "radius", ids: [id], start: W(sx, sy), base, screen: [sx, sy], moved: false, t0: [0, 0] };
    else drag.current = { mode: "points", ids: [], start: W(sx, sy), base, screen: [sx, sy], moved: false, t0: [0, 0] };
  }

  function onMove(e: PointerEvent) {
    const [sx, sy] = local(e);
    const p = W(sx, sy);
    setMouse(p);
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.hypot(sx - d.screen[0], sy - d.screen[1]) < 3) return;
      d.moved = true;
      if (d.mode === "pan") { setView({ ...v, tx: d.t0[0] + sx - d.screen[0], ty: d.t0[1] + sy - d.screen[1] }); return; }
      const be = allEntities(d.base);
      const delta: P2 = [p[0] - d.start[0], p[1] - d.start[1]];
      let targets: DragTarget[] = [];
      if (d.mode === "points") targets = d.ids.map((id) => { const q = pt(be, id); return { kind: "point", id, x: q[0] + delta[0], y: q[1] + delta[1] }; });
      else if (d.mode === "radius") { const c = be[d.ids[0]] as Extract<SketchEntity, { type: "circle" | "arc" }>; const cc = pt(be, c.c); targets = [{ kind: "radius", id: d.ids[0], r: Math.hypot(p[0] - cc[0], p[1] - cc[1]) }]; }
      if (!targets.length) return;
      const r = solveSketch(d.base, scope, targets);
      if (r.ok) store.updateSketch({ ...draft, entities: r.entities });
      return;
    }
    if (tool === "select" || tool === "dim" || tool === "trim" || tool === "extend" || tool === "offset" || tool === "skmirror") setHover(hitAt(sx, sy, { points: false }) ?? (tool === "select" || tool === "dim" || tool === "skmirror" ? hitAt(sx, sy) : null));
    else if (tool === "convert") { const i = hitRef(sx, sy); setHover(i >= 0 ? `ref:${i}` : null); }
    else if (tool === "skfillet" || tool === "skchamfer") { const h = hitAt(sx, sy, { curves: false }); setHover(h && isLineCorner(data(), h) ? h : null); }
    else setHover(snap(sx, sy).id ?? null);
    if (drawing?.kind === "arc" && drawing.start) {
      const c = pt(ents, drawing.center);
      const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
      if (drawing.last !== undefined) {
        let da = a - drawing.last;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        setDrawing({ ...drawing, acc: drawing.acc + da, last: a });
      } else setDrawing({ ...drawing, last: a });
    }
  }

  function onUp(e: PointerEvent) {
    const d = drag.current;
    drag.current = null;
    const [sx, sy] = local(e);
    if (d && d.moved) {
      if (d.mode !== "pan") commit(data(), "Arrastar");
      return;
    }
    if (e.button === 1) {
      // duplo clique no botão do meio: ajustar (como no SolidWorks)
      const now = performance.now();
      if (now - lastMiddle.current < 350) { setView(null); lastMiddle.current = 0; } else lastMiddle.current = now;
      return;
    }
    if (d?.mode === "pan" && e.button !== 0) return;
    click(sx, sy, e.shiftKey || e.ctrlKey || e.metaKey, e.detail >= 2);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const [sx, sy] = local(e);
    // como no 3D (e no SolidWorks): roda para a frente afasta, salvo se invertido nas preferências
    let f = Math.exp(e.deltaY * 0.0015);
    if (store.state.settings.reverseWheel) f = 1 / f;
    setView({ k: v.k * f, tx: sx - (sx - v.tx) * f, ty: sy - (sy - v.ty) * f });
  }

  // --- cliques por ferramenta ---------------------------------------------------------
  const clickCtx = () => ({ tool, sel, drawing, dimMode, draft, ents, hitAt, snap, hitRef, refGroups, convert, commit, data, W, lastValue, mirrorKeep, chamferMode, setSel, setMsg, setPrompt, setDrawing, setDimEdit });
  const click = (sx: number, sy: number, additive: boolean, dbl: boolean) => handleClick(clickCtx(), sx, sy, additive, dbl);
  const finishSpline = (pts: string[]) => finishSplineIn(clickCtx(), pts);

  // --- comandos ---------------------------------------------------------------------
  const entitySel = sel.filter((id) => ents[id]);
  const constraintSel = sel.filter((id) => !ents[id]);
  const applicable = applicableConstraints(data(), entitySel);

  function constrain(t: ConstraintType) {
    if (commit(applyConstraint(data(), t, entitySel), CONSTRAINT_LABEL[t])) setSel([]);
  }
  function remove() {
    if (!sel.length) return;
    commit(deleteItems(data(), sel), "Apagar");
    setSel([]);
  }
  function undo() { const s = hist.current.undo(); if (s) { store.updateSketch({ ...draft, ...s }); setInfo(solveSketch(s, scope)); scheduleFree(s); } }
  function redo() { const s = hist.current.redo(); if (s) { store.updateSketch({ ...draft, ...s }); setInfo(solveSketch(s, scope)); scheduleFree(s); } }

  const cmdCtx = () => ({ prompt, dimEdit, draft, scope, data, commit, lastValue, setMsg, setPrompt, setSel, setDimEdit });
  function applyPrompt() { applyPromptIn(cmdCtx()); }
  function saveDim() { saveDimIn(cmdCtx()); }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === "escape") { if (drawing?.kind === "spline" && drawing.pts.length >= 2) finishSpline(drawing.pts); setDrawing(null); if (!drawing) { setSel([]); setTool("select"); } }
      else if (k === "enter" && drawing?.kind === "spline") finishSpline(drawing.pts);
      else if (k === "delete" || k === "backspace") remove();
      else if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); }
      else if (k === "f" && !e.ctrlKey && !e.metaKey) setView(null);
      else if (!e.ctrlKey && !e.metaKey) {
        const t = TOOLS.find((x) => x.key.toLowerCase() === k);
        if (t) { setTool(t.id); setDrawing(null); }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // --- desenho ----------------------------------------------------------------------
  const conflicts = new Set(info?.conflicting ?? []);
  const conflictEnts = new Set(draft.constraints.filter((c) => conflicts.has(c.id)).flatMap((c) => c.refs));
  const cls = (id: string, e: SketchEntity) =>
    ["ent", e.construction ? "constr" : "", "ext" in e && e.ext ? "ext" : "", sel.includes(id) ? "sel" : hover === id ? "hover" : "", conflictEnts.has(id) ? "conflict" : free.has(id) ? "free" : "defined"].join(" ");

  const curves = Object.entries(draft.entities).filter(([, e]) => e.type !== "point");
  const points = Object.entries(draft.entities).filter(([, e]) => e.type === "point");
  const path = (id: string, e: SketchEntity): string => pathOf(ents, S, v.k, id, e);

  const preview = previewOf(ents, S, mouse, drawing);

  const status = !info ? "" : !info.ok ? `⚠ ${info.message}` : info.dof === 0 ? "Totalmente definido" : info.dof > 0 ? `Sub-definido · ${info.dof} grau(s) de liberdade` : "";

  return (
    <div class="sketch-editor">
      <div class="sk-toolbar" role="toolbar" aria-label="Ferramentas de esboço">
        {TOOLS.map((t) => (
          <button key={t.id} class={tool === t.id ? "on" : ""} title={`${t.label} (${t.key})`} onClick={() => { setTool(t.id); setDrawing(null); }}>
            <span class="ic">{t.icon}</span><span class="lb">{t.label}</span>
          </button>
        ))}
        {tool === "dim" && (
          <select value={dimMode} onChange={(e) => setDimMode((e.target as HTMLSelectElement).value as DimMode)} title="Tipo de cota">
            <option value="auto">Automática</option>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        )}
        {tool === "skmirror" && (
          <label class="sk-opt" title="Desmarcado: apaga as entidades originais e fica só a cópia espelhada"><input type="checkbox" checked={mirrorKeep} onChange={(e) => setMirrorKeep((e.target as HTMLInputElement).checked)} /> Manter original</label>
        )}
        {tool === "skchamfer" && <ChamferModeSelect mode={chamferMode} onChange={(m) => { setChamferMode(m); setPrompt(withChamferMode(prompt, m, lastValue.current)); }} />}
        {tool === "convert" && refGroups.some((g) => g.inPlane) && (
          <button title="Converter todas as arestas do modelo que estão no plano do esboço" onClick={() => convert(refGroups.filter((g) => g.inPlane))}>Contorno no plano</button>
        )}
        <span class="sep" />
        <button title="Linha de construção (alternar)" disabled={!entitySel.length} onClick={() => { commit(toggleConstruction(data(), entitySel), "Construção"); }}>
          <span class="ic">┄</span><span class="lb">Construção</span>
        </button>
        <button title="Apagar (Delete)" disabled={!sel.length} onClick={remove}><span class="ic">✕</span><span class="lb">Apagar</span></button>
        <button title="Ajustar ao ecrã (F)" onClick={() => setView(null)}><span class="ic">⤢</span></button>
        <button title="Desfazer (Ctrl+Z)" disabled={!hist.current.canUndo} onClick={undo}><span class="ic">↶</span></button>
        <button title="Refazer (Ctrl+Y)" disabled={!hist.current.canRedo} onClick={redo}><span class="ic">↷</span></button>
      </div>
      <div ref={wrap} class={`sk-canvas ${entered ? "entered" : "entering"}`} onWheel={onWheel as never} onContextMenu={(e) => e.preventDefault()}>
        <div class="sk-confirm" role="group" aria-label="Terminar o esboço">
          <button class="ok" onClick={() => store.exitSketch(true)} title="Guardar o esboço e sair (como o ✓ do SolidWorks)"><span class="ic">✓</span><span>Sair do esboço</span></button>
          <button class="no" onClick={() => store.exitSketch(false)} title="Descartar as alterações e sair"><span class="ic">✕</span><span>Cancelar</span></button>
        </div>
        {entitySel.length > 0 && (
          <div class="sk-relations" aria-label="Relações">
            <span class="muted">Relações:</span>
            {GEOM_CONSTRAINTS.filter((t) => applicable.includes(t)).map((t) => (
              <button key={t} onClick={() => constrain(t)} title={CONSTRAINT_LABEL[t]}>
                <span class="glyph">{CONSTRAINT_GLYPH[t]}</span> {CONSTRAINT_LABEL[t]}
              </button>
            ))}
            {!applicable.length && <span class="muted">nenhuma para esta seleção</span>}
            {entitySel.length && (() => { const d = smartDimension(data(), entitySel, "auto"); return d ? <button onClick={() => { setTool("dim"); setDrawing({ kind: "dim", picks: entitySel }); setMsg("Clique no vazio para colocar a cota"); }}>↔ Cotar</button> : null; })()}
          </div>
        )}
        <svg width={size[0]} height={size[1]} onPointerDown={onDown as never} onPointerMove={onMove as never} onPointerUp={onUp as never} class={`tool-${tool}`}>
          {store.state.settings.sketchGrid && <Grid v={v} w={size[0]} h={size[1]} />}
          <g class="ref-edges">
            {refEdges.inPlane.map(([a, b], i) => <line key={`i${i}`} class="ref-in" x1={S(a)[0]} y1={S(a)[1]} x2={S(b)[0]} y2={S(b)[1]} />)}
            {tool === "convert" && hover?.startsWith("ref:") && (() => {
              const g = refGroups[Number(hover.slice(4))];
              return g ? <polyline class="ref-hover" points={g.pts.map((q) => S(q).join(",")).join(" ")} /> : null;
            })()}
          </g>
          <line class={`axis h ${hover === "H" || sel.includes("H") ? "hover" : ""}`} x1={0} x2={size[0]} y1={v.ty} y2={v.ty} />
          <line class={`axis v ${hover === "V" || sel.includes("V") ? "hover" : ""}`} y1={0} y2={size[1]} x1={v.tx} x2={v.tx} />
          {curves.map(([id, e]) => <path key={id} d={path(id, e)} class={cls(id, e)} />)}
          {preview}
          <ChamferPreview prompt={prompt} data={data()} scope={scope} S={S} />
          <Constraints constraints={draft.constraints} ents={ents} S={S} sel={sel} conflicts={conflicts} onSelect={(id, add) => setSel(add ? [...sel, id] : [id])} />
          <Dimensions constraints={draft.constraints} ents={ents} S={S} W={W} sel={sel} conflicts={conflicts} scope={scope}
            onEdit={(c) => setDimEdit({ id: c.id, text: String(c.value ?? roundDim(measure(ents, c))) })}
            onSelect={(id, add) => setSel(add ? [...sel, id] : [id])}
            onMoveLabel={(id, pos) => store.updateSketch({ ...draft, constraints: draft.constraints.map((c) => (c.id === id ? { ...c, pos } : c)) })} />
          {points.map(([id, e]) => {
            const [x, y] = S([(e as { x: number }).x, (e as { y: number }).y]);
            return <rect key={id} x={x - 3} y={y - 3} width={6} height={6} class={`pt ${cls(id, e)}`} />;
          })}
          <circle cx={v.tx} cy={v.ty} r={4} class={`origin ${hover === "O" || sel.includes("O") ? "hover" : ""}`} />
        </svg>
        {prompt && <PromptBox prompt={prompt} setPrompt={setPrompt} apply={applyPrompt} />}
        {dimEdit && (() => {
          const c = draft.constraints.find((x) => x.id === dimEdit.id);
          if (!c) return null;
          const [x, y] = S(c.pos ?? labelPos(c, ents));
          return (
            <div class="dim-input" style={{ left: `${x}px`, top: `${y}px` }}>
              <input autoFocus value={dimEdit.text} aria-label="Valor da cota (número ou expressão)"
                onInput={(e) => setDimEdit({ ...dimEdit, text: (e.target as HTMLInputElement).value })}
                onKeyDown={(e) => { if (e.key === "Enter") saveDim(); if (e.key === "Escape") setDimEdit(null); }} />
              <button onClick={saveDim} title="Aplicar">✓</button>
              <button onClick={() => { setDimEdit(null); }} title="Fechar">✕</button>
            </div>
          );
        })()}
      </div>
      <div class="sk-status">
        <span class={info && !info.ok ? "bad" : info?.dof === 0 ? "good" : "warn"}>{status}</span>
        {constraintSel.length > 0 && <span>{constraintSel.length} restrição(ões) selecionada(s)</span>}
        {mouse && <span class="muted">x {fmt(mouse[0])} · y {fmt(mouse[1])} mm</span>}
        {msg && <span class="msg">{msg}</span>}
        <span class="grow" />
        <span class="muted">Roda: zoom · arrastar no vazio: deslocar · Shift: seleção múltipla</span>
      </div>
    </div>
  );
}
