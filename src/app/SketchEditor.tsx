// Editor de esboço 2D (SVG): desenho, seleção, arrasto com o solver, restrições e cotas.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConstraintType, SketchConstraint, SketchEntity } from "../doc/types.ts";
import { DIMENSION_TYPES } from "../doc/types.ts";
import { evalExpr } from "../doc/expr.ts";
import { History } from "../doc/history.ts";
import { type P2, allEntities, arcSweep, entityPoints, isImplicit, measure, pt, sampleEntity, splineBeziers } from "../sketch/geometry.ts";
import { solveSketch, freeEntities, type DragTarget, type SolveResult } from "../sketch/solver.ts";
import { connectedCurves, extend, isLineCorner, offset, sketchFillet, trim } from "../sketch/modify.ts";
import {
  type SketchData, CONSTRAINT_GLYPH, CONSTRAINT_LABEL, addArc, addCircle, addConstraint, addEntity, addLine, addPoint, addRectangle,
  applicableConstraints, applyConstraint, deleteItems, mergePoints, roundDim, smartDimension, toggleConstruction,
} from "../sketch/ops.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import { store, useStore } from "./store.ts";
import { commandViewport } from "./commands.ts";

type Tool = "select" | "line" | "rect" | "circle" | "arc" | "spline" | "point" | "dim" | "trim" | "extend" | "skfillet" | "offset" | "convert";
type DimMode = "auto" | "horizontal" | "vertical";

type Draw =
  | { kind: "line"; start: string; first: string; created: boolean }
  | { kind: "rect"; c1: P2; c1Id?: string }
  | { kind: "circle"; center: string }
  | { kind: "arc"; center: string; start?: P2; startId?: string; acc: number; last?: number }
  | { kind: "spline"; pts: string[] }
  | { kind: "dim"; picks: string[] };

interface Snap { p: P2; id?: string; on?: string }

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "Selecionar", key: "Esc", icon: "↖" },
  { id: "line", label: "Linha", key: "L", icon: "╱" },
  { id: "rect", label: "Retângulo", key: "R", icon: "▭" },
  { id: "circle", label: "Círculo", key: "C", icon: "◯" },
  { id: "arc", label: "Arco (centro)", key: "A", icon: "◠" },
  { id: "spline", label: "Spline", key: "S", icon: "∿" },
  { id: "point", label: "Ponto", key: "P", icon: "·" },
  { id: "dim", label: "Cota inteligente", key: "D", icon: "↔" },
  { id: "trim", label: "Aparar", key: "T", icon: "✂" },
  { id: "extend", label: "Estender", key: "E", icon: "⟶" },
  { id: "skfillet", label: "Filete de canto", key: "G", icon: "◟" },
  { id: "offset", label: "Deslocar", key: "O", icon: "⧈" },
  { id: "convert", label: "Converter arestas", key: "K", icon: "⇲" },
];

const GEOM_CONSTRAINTS: ConstraintType[] = ["coincident", "pointOn", "midpoint", "horizontal", "vertical", "parallel", "perpendicular", "collinear", "tangent", "equal", "concentric", "symmetric", "fix"];

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 3 });

export function SketchEditor({ result }: { result: RebuildResponse | null }) {
  const st = useStore();
  const edit = st.sketch!;
  const draft = edit.draft;
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([800, 600]);
  const [view, setView] = useState<{ k: number; tx: number; ty: number } | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [dimMode, setDimMode] = useState<DimMode>("auto");
  const [sel, setSel] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Draw | null>(null);
  const [mouse, setMouse] = useState<P2 | null>(null);
  const [dimEdit, setDimEdit] = useState<{ id: string; text: string } | null>(null);
  /** Pedido de valor para filete de canto (raio) ou deslocamento (distância). */
  const [prompt, setPrompt] = useState<{ kind: "fillet" | "offset"; at: [number, number]; text: string; target: string[] } | null>(null);
  const lastValue = useRef<{ fillet: string; offset: string }>({ fillet: "5", offset: "5" });
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

  /** Arestas do modelo projetadas no plano do esboço (as que estão no plano ficam mais fortes). */
  const projTol = 1e-3 * Math.max(1, ...(result?.mass ? result.mass.bbox.max.map((v, i) => Math.abs(v - result.mass!.bbox.min[i])) : [1]));
  /** Arestas do modelo projetadas, uma a uma, com o nome topológico (para converter). */
  const refGroups = useMemo(() => {
    const m = result?.mesh;
    if (!m || !frame) return [];
    const L = m.lines;
    return m.edges.map((g) => {
      const pts: P2[] = [];
      let inPlane = true;
      for (let k = 0; k < g.count; k++) {
        if (k > 1 && k % 2 === 0) continue; // segmentos guardados aos pares: o vértice k repete o k−1
        const i = (g.start + k) * 3;
        const d = [L[i] - frame.o[0], L[i + 1] - frame.o[1], L[i + 2] - frame.o[2]];
        pts.push([d[0] * frame.x[0] + d[1] * frame.x[1] + d[2] * frame.x[2], d[0] * frame.y[0] + d[1] * frame.y[1] + d[2] * frame.y[2]]);
        if (Math.abs(d[0] * frame.z[0] + d[1] * frame.z[1] + d[2] * frame.z[2]) > projTol) inPlane = false;
      }
      return { name: g.name, type: g.type, mid: g.mid, dir: g.dir, pts, inPlane };
    });
  }, [result, frame]);

  const refEdges = useMemo(() => {
    const lines = result?.mesh?.lines;
    if (!lines || !frame) return { inPlane: [] as [P2, P2][], other: [] as [P2, P2][] };
    const inPlane: [P2, P2][] = [], other: [P2, P2][] = [];
    const tol = projTol;
    const p2 = (i: number): [P2, number] => {
      const d = [lines[i] - frame.o[0], lines[i + 1] - frame.o[1], lines[i + 2] - frame.o[2]];
      return [[d[0] * frame.x[0] + d[1] * frame.x[1] + d[2] * frame.x[2], d[0] * frame.y[0] + d[1] * frame.y[1] + d[2] * frame.y[2]], d[0] * frame.z[0] + d[1] * frame.z[1] + d[2] * frame.z[2]];
    };
    for (let i = 0; i < lines.length; i += 6) {
      const [a, za] = p2(i), [b, zb] = p2(i + 3);
      (Math.abs(za) < tol && Math.abs(zb) < tol ? inPlane : other).push([a, b]);
    }
    return { inPlane, other };
  }, [result, frame]);

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
  function hitAt(sx: number, sy: number, opts: { points?: boolean; curves?: boolean; exclude?: Set<string> } = {}): string | null {
    const { points = true, curves = true, exclude } = opts;
    let best: string | null = null, bestD = 8;
    if (points) {
      for (const [id, e] of Object.entries(ents)) {
        if (e.type !== "point" || exclude?.has(id) || (isImplicit(id) && id !== "O")) continue;
        const [x, y] = S([e.x, e.y]);
        const d = Math.hypot(x - sx, y - sy);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best) return best;
    }
    if (!curves) return null;
    // curvas reais primeiro; os eixos do esboço só se não houver nenhuma por perto
    for (const axes of [false, true]) {
      bestD = 6;
      for (const [id, e] of Object.entries(ents)) {
        if (e.type === "point" || exclude?.has(id)) continue;
        const isAxis = id === "H" || id === "V";
        if (isAxis !== axes || (isImplicit(id) && !isAxis)) continue;
        const poly = isAxis ? [[-1e5, 0], [1e5, 0]].map((p) => (id === "V" ? [0, p[0]] : p) as P2) : sampleEntity(ents, id);
        for (let i = 0; i < poly.length - 1; i++) {
          const d = segDist([sx, sy], S(poly[i]), S(poly[i + 1]));
          if (d < bestD) { bestD = d; best = id; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  function snap(sx: number, sy: number, exclude?: Set<string>): Snap {
    const id = hitAt(sx, sy, { curves: false, exclude });
    if (id) return { p: pt(ents, id), id };
    const on = hitAt(sx, sy, { points: false, exclude });
    const p = W(sx, sy);
    if (on && on !== "H" && on !== "V") return { p: projectOn(ents, on, p), on };
    if (on === "H") return { p: [p[0], 0], on };
    if (on === "V") return { p: [0, p[1]], on };
    return { p };
  }

  /** Ponto num local de clique: reutiliza o existente ou cria um novo (com "ponto em" se sobre uma curva). */
  function placePoint(s: SketchData, sn: Snap): { s: SketchData; id: string; created: boolean } {
    if (sn.id) return { s, id: sn.id, created: false };
    let r = addPoint(s, sn.p);
    if (sn.on) r = { s: addConstraint(r.s, "pointOn", [r.id, sn.on]).s, id: r.id };
    return { ...r, created: true };
  }

  const data = (): SketchData => ({ entities: draft.entities, constraints: draft.constraints });

  function hitRef(sx: number, sy: number): number {
    let best = -1, bestD = 7;
    refGroups.forEach((g, i) => {
      for (let k = 0; k < g.pts.length - 1; k++) {
        const d = segDist([sx, sy], S(g.pts[k]), S(g.pts[k + 1]));
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    return best;
  }

  const converted = new Set(Object.values(draft.entities).flatMap((e) => ("ext" in e && e.ext ? [e.ext.name] : [])));

  /** Converte arestas do modelo em entidades ligadas (pontos fixos, atualizados pelo núcleo). */
  function convert(groups: typeof refGroups) {
    let s: SketchData = { entities: { ...draft.entities }, constraints: draft.constraints.slice() };
    let made = 0, skipped = 0;
    const fixedPoint = (p: P2): string => {
      const hit = Object.entries(s.entities).find(([, e]) => e.type === "point" && Math.hypot(e.x - p[0], e.y - p[1]) < 1e-3);
      if (hit) { s.entities[hit[0]] = { ...(hit[1] as Extract<SketchEntity, { type: "point" }>), fixed: true }; return hit[0]; }
      const r = addPoint(s, p);
      s = r.s;
      s.entities[r.id] = { ...(s.entities[r.id] as Extract<SketchEntity, { type: "point" }>), fixed: true };
      return r.id;
    };
    for (const g of groups) {
      if (converted.has(g.name)) continue;
      const ext = { kind: "edge" as const, name: g.name, hint: { c: g.mid, n: g.dir } };
      const a = g.pts[0], b = g.pts[g.pts.length - 1];
      if (g.type === "line") {
        // os pontos primeiro: fixedPoint altera `s`
        const p1 = fixedPoint(a), p2 = fixedPoint(b);
        s = addEntity(s, "l", { type: "line", p1, p2, ext }).s;
      } else if (g.type === "circle" && g.pts.length >= 3) {
        const m = g.pts[Math.floor(g.pts.length / 3)], n = g.pts[Math.floor((2 * g.pts.length) / 3)];
        const c = circleThrough(a, m, n);
        if (!c) { skipped++; continue; }
        const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * Math.max(1, c.r);
        const cid = fixedPoint(c.c);
        if (closed) s = addEntity(s, "c", { type: "circle", c: cid, r: c.r, ext }).s;
        else {
          // sentido anti-horário pelo ponto intermédio
          const mid = g.pts[Math.floor(g.pts.length / 2)];
          const ccw = (a[0] - c.c[0]) * (mid[1] - c.c[1]) - (a[1] - c.c[1]) * (mid[0] - c.c[0]) > 0;
          const [from, to] = ccw ? [a, b] : [b, a];
          const ps = fixedPoint(from), pe = fixedPoint(to);
          s = addEntity(s, "a", { type: "arc", c: cid, s: ps, e: pe, r: c.r, a0: Math.atan2(from[1] - c.c[1], from[0] - c.c[0]), a1: Math.atan2(to[1] - c.c[1], to[0] - c.c[0]), ext }).s;
        }
      } else { skipped++; continue; }
      made++;
    }
    if (made) commit(s, "Converter arestas");
    setMsg(skipped ? `${skipped} aresta(s) não convertida(s): só retas e circulares` : made ? null : "Já convertidas");
  }

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
    if (tool === "select" || tool === "dim" || tool === "trim" || tool === "extend" || tool === "offset") setHover(hitAt(sx, sy, { points: false }) ?? (tool === "select" || tool === "dim" ? hitAt(sx, sy) : null));
    else if (tool === "convert") { const i = hitRef(sx, sy); setHover(i >= 0 ? `ref:${i}` : null); }
    else if (tool === "skfillet") { const h = hitAt(sx, sy, { curves: false }); setHover(h && isLineCorner(data(), h) ? h : null); }
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
  function click(sx: number, sy: number, additive: boolean, dbl: boolean) {
    if (tool === "select") {
      const id = hitAt(sx, sy);
      if (!id) { setSel([]); return; }
      setSel(additive ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id]);
      return;
    }
    if (tool === "dim") { dimClick(sx, sy); return; }
    if (tool === "trim" || tool === "extend") {
      const id = hitAt(sx, sy, { points: false });
      if (!id || id === "H" || id === "V") return;
      const target = draft.entities[id];
      if (target && "ext" in target && target.ext) { setMsg("Entidade convertida: é comandada pelo modelo e não pode ser aparada nem estendida"); return; }
      if (tool === "trim") commit(trim(data(), id, W(sx, sy)), "Aparar");
      else {
        const r = extend(data(), id, W(sx, sy));
        if (r) commit(r, "Estender"); else setMsg("Não há nenhuma entidade nessa direção para onde estender");
      }
      return;
    }
    if (tool === "skfillet") {
      const id = hitAt(sx, sy, { curves: false });
      if (id && isLineCorner(data(), id)) setPrompt({ kind: "fillet", at: [sx, sy], text: lastValue.current.fillet, target: [id] });
      else setMsg("Clique num canto entre duas linhas");
      return;
    }
    if (tool === "convert") {
      const i = hitRef(sx, sy);
      if (i >= 0) convert([refGroups[i]]);
      return;
    }
    if (tool === "offset") {
      const id = hitAt(sx, sy, { points: false });
      if (!id || id === "H" || id === "V") return;
      const chain = connectedCurves(data(), id);
      setSel(chain);
      setPrompt({ kind: "offset", at: [sx, sy], text: lastValue.current.offset, target: chain });
      return;
    }
    const s0 = data();
    const sn = snap(sx, sy);
    switch (tool) {
      case "point": {
        if (sn.id) return;
        const r = placePoint(s0, sn);
        commit(r.s, "Ponto");
        return;
      }
      case "line": {
        if (!drawing || drawing.kind !== "line") {
          const r = placePoint(s0, sn);
          if (r.created) commit(r.s, "Ponto");
          setDrawing({ kind: "line", start: r.id, first: r.id, created: r.created });
          return;
        }
        if (dbl || sn.id === drawing.start) { setDrawing(null); return; }
        const r = placePoint(s0, sn);
        const l = addLine(r.s, drawing.start, r.id);
        if (!commit(l.s, "Linha")) return;
        if (r.id === drawing.first) setDrawing(null);
        else setDrawing({ ...drawing, start: r.id, created: r.created });
        return;
      }
      case "rect": {
        if (!drawing || drawing.kind !== "rect") { setDrawing({ kind: "rect", c1: sn.p, c1Id: sn.id }); return; }
        if (Math.abs(sn.p[0] - drawing.c1[0]) < 1e-9 || Math.abs(sn.p[1] - drawing.c1[1]) < 1e-9) return;
        const r = addRectangle(s0, drawing.c1, sn.p, drawing.c1Id);
        let s = r.s;
        if (sn.id) s = mergePoints(s, sn.id, r.points[2]);
        commit(s, "Retângulo");
        setDrawing(null);
        return;
      }
      case "circle": {
        if (!drawing || drawing.kind !== "circle") {
          const r = placePoint(s0, sn);
          if (r.created) commit(r.s, "Ponto");
          setDrawing({ kind: "circle", center: r.id });
          return;
        }
        const c = pt(ents, drawing.center);
        const rad = Math.hypot(sn.p[0] - c[0], sn.p[1] - c[1]);
        if (rad < 1e-9) return;
        commit(addCircle(s0, drawing.center, rad).s, "Círculo");
        setDrawing(null);
        return;
      }
      case "arc": {
        if (!drawing || drawing.kind !== "arc") {
          const r = placePoint(s0, sn);
          if (r.created) commit(r.s, "Ponto");
          setDrawing({ kind: "arc", center: r.id, acc: 0 });
          return;
        }
        if (!drawing.start) { setDrawing({ ...drawing, start: sn.p, startId: sn.id, acc: 0, last: undefined }); return; }
        const ccw = drawing.acc >= 0;
        const r = addArc(s0, drawing.center, drawing.start, sn.p, ccw);
        let s = r.s;
        const arc = s.entities[r.id] as Extract<SketchEntity, { type: "arc" }>;
        // ligar aos pontos existentes onde o arco começou/acabou
        const startPt = ccw ? arc.s : arc.e, endPt = ccw ? arc.e : arc.s;
        if (drawing.startId) s = mergePoints(s, drawing.startId, startPt);
        if (sn.id) s = mergePoints(s, sn.id, endPt);
        commit(s, "Arco");
        setDrawing(null);
        return;
      }
      case "spline": {
        const pts = drawing?.kind === "spline" ? drawing.pts : [];
        if (dbl && pts.length >= 2) { finishSpline(pts); return; }
        const r = placePoint(s0, sn);
        if (r.created) commit(r.s, "Ponto");
        setDrawing({ kind: "spline", pts: [...pts, r.id] });
        return;
      }
    }
  }

  function finishSpline(pts: string[]) {
    const uniq = pts.filter((p, i) => i === 0 || p !== pts[i - 1]);
    if (uniq.length >= 2) commit(addEntity(data(), "s", { type: "spline", pts: uniq }).s, "Spline");
    setDrawing(null);
  }

  function dimClick(sx: number, sy: number) {
    const id = hitAt(sx, sy);
    const picks = drawing?.kind === "dim" ? drawing.picks : [];
    if (id) {
      const next = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id].slice(-2);
      setDrawing({ kind: "dim", picks: next });
      setSel(next);
      return;
    }
    // clique no vazio: colocar a cota
    if (!picks.length) return;
    const dim = smartDimension(data(), picks, dimMode);
    if (!dim) { setMsg("Não sei cotar esta seleção"); return; }
    const value = roundDim(measure(ents, dim));
    const r = addConstraint(data(), dim.type, dim.refs, value, { pos: W(sx, sy) });
    if (commit(r.s, "Cota", { drivenOnConflict: r.id })) setDimEdit({ id: r.id, text: String(value) });
    setDrawing(null);
    setSel([]);
  }

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

  function applyPrompt() {
    if (!prompt) return;
    let v: number;
    try { v = evalExpr(prompt.text, scope); } catch (e) { setMsg((e as Error).message); return; }
    lastValue.current[prompt.kind] = prompt.text;
    if (prompt.kind === "fillet") {
      const r = sketchFillet(data(), prompt.target[0], Math.abs(v));
      if (!r) { setMsg("Raio demasiado grande para as linhas do canto"); return; }
      if (commit(r, "Filete de canto")) setPrompt(null);
    } else {
      if (commit(offset(data(), prompt.target, v), "Deslocar")) { setPrompt(null); setSel([]); }
    }
  }

  function saveDim() {
    if (!dimEdit) return;
    const text = dimEdit.text.trim();
    try {
      const val = evalExpr(text, scope);
      if (!(val > 0) && !text.startsWith("-")) throw new Error("O valor tem de ser positivo");
      const num = Number(text.replace(",", "."));
      const value = Number.isFinite(num) && /^[-+]?[\d.,]+$/.test(text) ? num : text;
      const next = { ...data(), constraints: draft.constraints.map((c) => (c.id === dimEdit.id ? { ...c, value, driven: false } : c)) };
      if (commit(next, "Cota", { drivenOnConflict: dimEdit.id })) setDimEdit(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

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
  const path = (id: string, e: SketchEntity): string => {
    if (e.type === "line") { const a = S(pt(ents, e.p1)), b = S(pt(ents, e.p2)); return `M${a}L${b}`; }
    if (e.type === "circle") { const c = S(pt(ents, e.c)); const r = e.r * v.k; return `M${c[0] - r},${c[1]}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0`; }
    if (e.type === "arc") {
      const a = S(pt(ents, e.s)), b = S(pt(ents, e.e)), r = e.r * v.k;
      return `M${a}A${r},${r} 0 ${arcSweep(e.a0, e.a1) > Math.PI ? 1 : 0} 0 ${b}`;
    }
    if (e.type === "spline") {
      const bz = splineBeziers(e.pts.map((p) => pt(ents, p)));
      return bz.map((b, i) => `${i ? "" : `M${S(b[0])}`}C${S(b[1])} ${S(b[2])} ${S(b[3])}`).join("");
    }
    return id;
  };

  const preview = (() => {
    if (!mouse || !drawing) return null;
    const m = S(mouse);
    if (drawing.kind === "line") return <line class="preview" x1={S(pt(ents, drawing.start))[0]} y1={S(pt(ents, drawing.start))[1]} x2={m[0]} y2={m[1]} />;
    if (drawing.kind === "rect") { const a = S(drawing.c1); return <rect class="preview" x={Math.min(a[0], m[0])} y={Math.min(a[1], m[1])} width={Math.abs(m[0] - a[0])} height={Math.abs(m[1] - a[1])} />; }
    if (drawing.kind === "circle") { const c = S(pt(ents, drawing.center)); return <circle class="preview" cx={c[0]} cy={c[1]} r={Math.hypot(m[0] - c[0], m[1] - c[1])} />; }
    if (drawing.kind === "arc") {
      const c = S(pt(ents, drawing.center));
      if (!drawing.start) return <line class="preview" x1={c[0]} y1={c[1]} x2={m[0]} y2={m[1]} />;
      const s = S(drawing.start), r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      const ang = Math.atan2(-(m[1] - c[1]), m[0] - c[0]);
      const e = [c[0] + r * Math.cos(ang), c[1] - r * Math.sin(ang)];
      const large = Math.abs(drawing.acc) > Math.PI ? 1 : 0;
      return <path class="preview" d={`M${s}A${r},${r} 0 ${large} ${drawing.acc >= 0 ? 0 : 1} ${e}`} />;
    }
    if (drawing.kind === "spline" && drawing.pts.length) {
      const bz = splineBeziers([...drawing.pts.map((p) => pt(ents, p)), mouse]);
      return <path class="preview" d={bz.map((b, i) => `${i ? "" : `M${S(b[0])}`}C${S(b[1])} ${S(b[2])} ${S(b[3])}`).join("")} />;
    }
    return null;
  })();

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
          <Grid v={v} w={size[0]} h={size[1]} />
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
        {prompt && (
          <div class="dim-input" style={{ left: `${prompt.at[0]}px`, top: `${prompt.at[1]}px` }}>
            <input autoFocus value={prompt.text} aria-label={prompt.kind === "fillet" ? "Raio do filete" : "Distância (negativa para o outro lado)"}
              onInput={(e) => setPrompt({ ...prompt, text: (e.target as HTMLInputElement).value })}
              onKeyDown={(e) => { if (e.key === "Enter") applyPrompt(); if (e.key === "Escape") setPrompt(null); }} />
            <button onClick={applyPrompt} title="Aplicar">✓</button>
            <button onClick={() => setPrompt(null)} title="Fechar">✕</button>
          </div>
        )}
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

/** Circunferência por três pontos. */
function circleThrough(a: P2, b: P2, c: P2): { c: P2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

function segDist(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function projectOn(ents: Record<string, SketchEntity>, id: string, p: P2): P2 {
  const e = ents[id];
  if (e.type === "line") {
    const a = pt(ents, e.p1), b = pt(ents, e.p2);
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    return [a[0] + t * dx, a[1] + t * dy];
  }
  if (e.type === "circle" || e.type === "arc") {
    const c = pt(ents, e.c);
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    return [c[0] + e.r * Math.cos(a), c[1] + e.r * Math.sin(a)];
  }
  return p;
}

function Grid({ v, w, h }: { v: { k: number; tx: number; ty: number }; w: number; h: number }) {
  // passo de grelha "redondo" entre 15 e 75 px
  let step = 1;
  while (step * v.k < 15) step *= step.toString().startsWith("2") ? 2.5 : 2;
  while (step * v.k > 75) step /= 2;
  const lines = [];
  const x0 = Math.floor(-v.tx / v.k / step) * step, x1 = (w - v.tx) / v.k;
  for (let x = x0, i = 0; x <= x1 && i < 400; x += step, i++) {
    const sx = x * v.k + v.tx;
    lines.push(<line key={`x${i}`} x1={sx} x2={sx} y1={0} y2={h} class={Math.abs(x / step / 5 - Math.round(x / step / 5)) < 1e-6 ? "g5" : "g"} />);
  }
  const y0 = Math.floor((v.ty - h) / v.k / step) * step, y1 = v.ty / v.k;
  for (let y = y0, i = 0; y <= y1 && i < 400; y += step, i++) {
    const sy = -y * v.k + v.ty;
    lines.push(<line key={`y${i}`} y1={sy} y2={sy} x1={0} x2={w} class={Math.abs(y / step / 5 - Math.round(y / step / 5)) < 1e-6 ? "g5" : "g"} />);
  }
  return <g class="grid">{lines}</g>;
}

/** Ponto de ancoragem por defeito do rótulo de uma cota. */
function labelPos(c: SketchConstraint, ents: Record<string, SketchEntity>): P2 {
  const anchors = anchorPoints(c, ents);
  const m: P2 = [anchors.reduce((s, p) => s + p[0], 0) / anchors.length, anchors.reduce((s, p) => s + p[1], 0) / anchors.length];
  if (c.type === "distanceX") return [m[0], m[1] + 8];
  if (c.type === "distanceY") return [m[0] + 8, m[1]];
  return [m[0] + 4, m[1] + 4];
}

function anchorPoints(c: SketchConstraint, ents: Record<string, SketchEntity>): P2[] {
  const out: P2[] = [];
  for (const r of c.refs) {
    const e = ents[r];
    if (!e) continue;
    if (e.type === "point") out.push([e.x, e.y]);
    else if (e.type === "line") { const a = pt(ents, e.p1), b = pt(ents, e.p2); out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
    else if (e.type === "circle" || e.type === "arc") { const cc = pt(ents, e.c); out.push([cc[0] + e.r * Math.SQRT1_2, cc[1] + e.r * Math.SQRT1_2]); }
    else if (e.type === "spline") out.push(pt(ents, e.pts[Math.floor(e.pts.length / 2)]));
  }
  return out.length ? out : [[0, 0]];
}

function Constraints({ constraints, ents, S, sel, conflicts, onSelect }: {
  constraints: SketchConstraint[]; ents: Record<string, SketchEntity>; S: (p: P2) => [number, number]; sel: string[]; conflicts: Set<string>; onSelect: (id: string, add: boolean) => void;
}) {
  const placed = new Map<string, number>();
  return (
    <g class="constraints">
      {constraints.filter((c) => !DIMENSION_TYPES.has(c.type) && c.type !== "coincident").map((c) => {
        const glyph = CONSTRAINT_GLYPH[c.type] ?? "?";
        return anchorPoints(c, ents).slice(0, c.type === "symmetric" ? 1 : 2).map((p, i) => {
          const [x, y] = S(p);
          const key = `${Math.round(x / 10)},${Math.round(y / 10)}`;
          const n = placed.get(key) ?? 0;
          placed.set(key, n + 1);
          return (
            <g key={`${c.id}-${i}`} class={`glyph ${sel.includes(c.id) ? "sel" : ""} ${conflicts.has(c.id) ? "conflict" : ""}`} transform={`translate(${x + 8 + n * 14},${y - 10})`}
              onPointerDown={(e) => { e.stopPropagation(); onSelect(c.id, e.shiftKey || e.ctrlKey); }}
              onPointerUp={(e) => e.stopPropagation()}>
              <rect x={-6} y={-7} width={12} height={13} rx={2} />
              <text text-anchor="middle" y={3}>{glyph}</text>
              <title>{CONSTRAINT_LABEL[c.type]}</title>
            </g>
          );
        });
      })}
    </g>
  );
}

function Dimensions({ constraints, ents, S, W, sel, conflicts, scope, onEdit, onSelect, onMoveLabel }: {
  constraints: SketchConstraint[]; ents: Record<string, SketchEntity>; S: (p: P2) => [number, number]; W: (x: number, y: number) => P2;
  sel: string[]; conflicts: Set<string>; scope: (n: string) => number | undefined;
  onEdit: (c: SketchConstraint) => void; onSelect: (id: string, add: boolean) => void; onMoveLabel: (id: string, pos: P2) => void;
}) {
  const dragging = useRef<{ id: string; moved: boolean } | null>(null);
  return (
    <g class="dims">
      {constraints.filter((c) => DIMENSION_TYPES.has(c.type)).map((c) => {
        let value: number;
        try { value = c.driven || c.value === undefined ? measure(ents, c) : evalExpr(c.value, scope); } catch { value = NaN; }
        const shown = c.type === "radius" ? `R${fmt(value)}` : c.type === "diameter" ? `⌀${fmt(value)}` : c.type === "angle" ? `${fmt(value)}°` : fmt(Math.abs(value));
        const text = c.driven ? `(${shown})` : typeof c.value === "string" && !/^[-+]?[\d.]+$/.test(c.value) ? `${c.value} = ${shown}` : shown;
        const lp = S(c.pos ?? labelPos(c, ents));
        const anchors = anchorPoints(c, ents).map(S);
        return (
          <g key={c.id} class={`dim ${c.driven ? "driven" : ""} ${sel.includes(c.id) ? "sel" : ""} ${conflicts.has(c.id) ? "conflict" : ""}`}>
            {anchors.length === 2 && <line class="dimline" x1={anchors[0][0]} y1={anchors[0][1]} x2={anchors[1][0]} y2={anchors[1][1]} />}
            {anchors.map((a, i) => <line key={i} class="leader" x1={a[0]} y1={a[1]} x2={lp[0]} y2={lp[1]} />)}
            <text x={lp[0]} y={lp[1]} class="dimtext"
              onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); dragging.current = { id: c.id, moved: false }; }}
              onPointerMove={(e) => {
                if (dragging.current?.id !== c.id) return;
                dragging.current.moved = true;
                const svg = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
                onMoveLabel(c.id, W(e.clientX - svg.left, e.clientY - svg.top));
              }}
              onPointerUp={(e) => { e.stopPropagation(); const d = dragging.current; dragging.current = null; if (d && !d.moved) onSelect(c.id, e.shiftKey); }}
              onDblClick={(e) => { e.stopPropagation(); onEdit(c); }}>
              {text}
              <title>{CONSTRAINT_LABEL[c.type]} · duplo clique para editar</title>
            </text>
          </g>
        );
      })}
    </g>
  );
}
