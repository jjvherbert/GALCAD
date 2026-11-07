// Cliques por ferramenta do editor de esboço 2D (desenho, aparar, estender, filete, chanfro, conversão, cotas).
import { type SketchEntity } from "../doc/types.ts";
import { type P2, measure, pt } from "../sketch/geometry.ts";
import { connectedCurves, extend, isLineCorner, trim } from "../sketch/modify.ts";
import { type SketchData, addArc, addCircle, addConstraint, addEntity, addLine, addRectangle, mergePoints, roundDim, smartDimension } from "../sketch/ops.ts";
import { sketchMirror } from "../sketch/mirror.ts";
import { type HitOpts, placePoint } from "./sketch-hit.ts";
import { type RefGroup } from "./sketch-ref.ts";
import { type Draw, type DimMode, type Snap, type Tool } from "./sketch-types.ts";
import type { allEntities } from "../sketch/geometry.ts";

/** Contexto dos cliques: estado do editor e as ações que cada ferramenta usa. */
export type ClickCtx = {
  tool: Tool;
  sel: string[];
  drawing: Draw | null;
  dimMode: DimMode;
  draft: SketchData;
  ents: ReturnType<typeof allEntities>;
  hitAt: (sx: number, sy: number, opts?: HitOpts) => string | null;
  snap: (sx: number, sy: number, exclude?: Set<string>) => Snap;
  hitRef: (sx: number, sy: number) => number;
  refGroups: RefGroup[];
  convert: (groups: RefGroup[]) => void;
  commit: (next: SketchData, label: string, opts?: { drivenOnConflict?: string }) => boolean;
  data: () => SketchData;
  W: (sx: number, sy: number) => P2;
  lastValue: { current: { fillet: string; chamfer: string; offset: string } };
  /** Espelhar: manter as entidades originais (por defeito) ou ficar só com a cópia. */
  mirrorKeep: boolean;
  setSel: (s: string[]) => void;
  setMsg: (m: string | null) => void;
  setPrompt: (p: { kind: "fillet" | "chamfer" | "offset"; at: [number, number]; text: string; target: string[] } | null) => void;
  setDrawing: (d: Draw | null) => void;
  setDimEdit: (d: { id: string; text: string } | null) => void;
};

export function handleClick(c: ClickCtx, sx: number, sy: number, additive: boolean, dbl: boolean) {
  const { tool, sel, drawing, draft, ents, hitAt, snap, hitRef, refGroups, convert, commit, data, W, lastValue, setSel, setMsg, setPrompt, setDrawing } = c;
  const dimClick = (a: number, b: number) => dimClickAt(c, a, b);
  const finishSpline = (p: string[]) => finishSplineIn(c, p);
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
  if (tool === "skchamfer") {
    const id = hitAt(sx, sy, { curves: false });
    if (id && isLineCorner(data(), id)) setPrompt({ kind: "chamfer", at: [sx, sy], text: lastValue.current.chamfer, target: [id] });
    else setMsg("Clique num canto entre duas linhas");
    return;
  }
  if (tool === "convert") {
    const i = hitRef(sx, sy);
    if (i >= 0) convert([refGroups[i]]);
    return;
  }
  if (tool === "skmirror") {
    // clique simples numa linha (ou eixo H/V) com seleção feita = linha de simetria; Shift junta à seleção
    const id = hitAt(sx, sy);
    if (!id) { setMsg("Selecione as entidades (Shift+clique) e depois clique na linha de simetria"); return; }
    if (!additive && sel.length && !sel.includes(id) && ents[id]?.type === "line") {
      const r = sketchMirror(data(), sel, id, { keep: c.mirrorKeep });
      if (r) { if (commit(r, "Espelhar")) setSel([]); return; }
    }
    if (id === "H" || id === "V" || id === "O") return;
    setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
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

export function finishSplineIn(c: ClickCtx, pts: string[]) {
  const { commit, data, setDrawing } = c;
  const uniq = pts.filter((p, i) => i === 0 || p !== pts[i - 1]);
  if (uniq.length >= 2) commit(addEntity(data(), "s", { type: "spline", pts: uniq }).s, "Spline");
  setDrawing(null);
}

export function dimClickAt(c: ClickCtx, sx: number, sy: number) {
  const { dimMode, drawing, ents, hitAt, commit, data, W, setSel, setMsg, setDrawing, setDimEdit } = c;
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
