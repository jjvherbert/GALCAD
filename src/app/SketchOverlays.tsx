// Sobreposições SVG do editor de esboço: grelha, restrições e cotas.
import { useRef } from "preact/hooks";
import { type SketchConstraint, type SketchEntity, DIMENSION_TYPES } from "../doc/types.ts";
import { evalExpr } from "../doc/expr.ts";
import { type P2, measure, pt } from "../sketch/geometry.ts";
import { CONSTRAINT_GLYPH, CONSTRAINT_LABEL } from "../sketch/ops.ts";
import { fmt } from "./sketch-types.ts";

export function Grid({ v, w, h }: { v: { k: number; tx: number; ty: number }; w: number; h: number }) {
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
export function labelPos(c: SketchConstraint, ents: Record<string, SketchEntity>): P2 {
  const anchors = anchorPoints(c, ents);
  const m: P2 = [anchors.reduce((s, p) => s + p[0], 0) / anchors.length, anchors.reduce((s, p) => s + p[1], 0) / anchors.length];
  if (c.type === "distanceX") return [m[0], m[1] + 8];
  if (c.type === "distanceY") return [m[0] + 8, m[1]];
  return [m[0] + 4, m[1] + 4];
}

export function anchorPoints(c: SketchConstraint, ents: Record<string, SketchEntity>): P2[] {
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

export function Constraints({ constraints, ents, S, sel, conflicts, onSelect }: {
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

export function Dimensions({ constraints, ents, S, W, sel, conflicts, scope, onEdit, onSelect, onMoveLabel }: {
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
