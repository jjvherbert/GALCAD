// Caminhos SVG e pré-visualização do desenho em curso no editor de esboço 2D.
import type { SketchEntity } from "../doc/types.ts";
import { type P2, allEntities, arcSweep, pt, splineBeziers } from "../sketch/geometry.ts";
import type { Draw } from "./sketch-types.ts";

type Ents = ReturnType<typeof allEntities>;
type Scr = (p: P2) => [number, number];

export function pathOf(ents: Ents, S: Scr, k: number, id: string, e: SketchEntity): string {
  if (e.type === "line") { const a = S(pt(ents, e.p1)), b = S(pt(ents, e.p2)); return `M${a}L${b}`; }
  if (e.type === "circle") { const c = S(pt(ents, e.c)); const r = e.r * k; return `M${c[0] - r},${c[1]}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0`; }
  if (e.type === "arc") {
    const a = S(pt(ents, e.s)), b = S(pt(ents, e.e)), r = e.r * k;
    return `M${a}A${r},${r} 0 ${arcSweep(e.a0, e.a1) > Math.PI ? 1 : 0} 0 ${b}`;
  }
  if (e.type === "spline") {
    const bz = splineBeziers(e.pts.map((p) => pt(ents, p)));
    return bz.map((b, i) => `${i ? "" : `M${S(b[0])}`}C${S(b[1])} ${S(b[2])} ${S(b[3])}`).join("");
  }
  return id;
}

export function previewOf(ents: Ents, S: Scr, mouse: P2 | null, drawing: Draw | null) {
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
}
