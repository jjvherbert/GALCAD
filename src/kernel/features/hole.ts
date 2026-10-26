// Furo (estilo "Hole Wizard"): simples, de passagem ou roscado, com rebaixo ou escareado,
// colocado nos pontos isolados de um esboço, perpendicular ao plano do esboço.
import type { Feature, HoleFeature } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { HOLE_NOTE, METRIC } from "../../doc/holes.ts";
import { isolatedPoints, type Seg } from "../../sketch/profiles.ts";
import { type Ctx, type StepReport, modelSize } from "../context.ts";
import { type Frame, to3D } from "../frame.ts";
import { loopWire, mapEdgesToEntities } from "../sketch3d.ts";
import { type NamedBody } from "../naming.ts";
import { T, type TopoDS_Shape, gpAx1, makeCompound, oc, v3 } from "../occ.ts";
import { applyOp } from "../boolean.ts";
import { sketchOf, generatedNames, nameFrom } from "./solid.ts";
import { makeFace } from "replicad";

const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 2 });

interface HoleGeom {
  r: number; // raio do furo
  depth: number; // profundidade cilíndrica
  tip: number; // altura da ponta cónica
  cb?: { r: number; depth: number };
  cs?: { r: number; depth: number };
}

/** Perfil (r, profundidade) do furo como segmentos com papéis (para os nomes das faces). */
function profileSegs(g: HoleGeom): Seg[] {
  const pts: { p: [number, number]; role: string }[] = [];
  if (g.cb) {
    pts.push({ p: [g.cb.r, 0], role: "cbwall" }, { p: [g.cb.r, g.cb.depth], role: "cbfloor" }, { p: [g.r, g.cb.depth], role: "wall" });
  } else if (g.cs) {
    pts.push({ p: [g.cs.r, 0], role: "cs" }, { p: [g.r, g.cs.depth], role: "wall" });
  } else {
    pts.push({ p: [g.r, 0], role: "wall" });
  }
  pts.push({ p: [g.r, g.depth], role: g.tip > 0 ? "tip" : "bottom" });
  pts.push({ p: [0, g.depth + g.tip], role: "axis" });
  const loop: { p: [number, number]; role: string }[] = [{ p: [0, 0], role: "top" }, ...pts];
  return loop.map((cur, i) => {
    const next = loop[(i + 1) % loop.length];
    return { kind: "line" as const, entity: cur.role, a: cur.p, b: next.p };
  });
}

/** Sólido de revolução de um furo no ponto `c`, com eixo `d` (para dentro do material). */
function holeSolid(g: HoleGeom, c: [number, number, number], d: [number, number, number], radial: [number, number, number], fid: string, pid: string): NamedBody {
  const frame: Frame = { o: c, x: radial, y: d, z: v3.cross(radial, d) };
  const segs = profileSegs(g);
  const wire = loopWire(segs, frame);
  const face = T(makeFace(wire));
  const edgeMap = mapEdgesToEntities(face.wrapped, segs, frame) as Map<TopoDS_Shape, string>;
  const mk = T(new (oc().BRepPrimAPI_MakeRevol)(face.wrapped, gpAx1(c, d), 2 * Math.PI, false));
  const containing = [...edgeMap].filter(([, role]) => role !== "axis").map(([edge, role]) => ({ edge, name: `${fid}:${pid}:${role}` }));
  return nameFrom(T(mk.Shape()), fid, generatedNames(mk, edgeMap, `${fid}:${pid}`), undefined, containing);
}

export function hole(ctx: Ctx, f: HoleFeature & Feature, report: StepReport): Ctx {
  if (!ctx.body) throw new Error("O furo precisa de um corpo");
  const s = sketchOf(ctx, f.sketch);
  const points = isolatedPoints(s.entities);
  if (!points.length) throw new Error("O esboço não tem pontos de centro (pontos isolados que não sejam de construção)");
  const P = (v: HoleFeature["diameter"], label: string, fb?: number) => evalParam(v, ctx.scope, label, fb);

  const size = f.size ? METRIC[f.size] : undefined;
  if ((f.kind === "clearance" || f.kind === "tapped") && !size) throw new Error(`Rosca desconhecida: ${f.size ?? "(nenhuma)"}`);
  const diameter =
    f.kind === "simple" ? P(f.diameter, "Diâmetro")
    : f.kind === "clearance" ? size!.clearance[f.fit ?? "normal"]
    : size!.tapDrill;
  if (diameter <= 0) throw new Error("Diâmetro: tem de ser positivo");
  const through = f.end.type === "throughAll";
  const depth = f.end.type === "throughAll" ? modelSize(ctx, [s.frame.o]) : P(f.end.depth, "Profundidade");
  if (depth <= 0) throw new Error("Profundidade: tem de ser positiva");
  const tipAngle = through ? 0 : P(f.tipAngle, "Ângulo da ponta", 118);
  const g: HoleGeom = { r: diameter / 2, depth, tip: tipAngle > 0 ? diameter / 2 / Math.tan((tipAngle * Math.PI) / 360) : 0 };

  const head = f.kind === "tapped" ? "none" : f.head ?? "none";
  if (head === "counterbore") {
    const hd = P(f.headDiameter, "Diâmetro do rebaixo", size?.counterbore.d);
    const hh = P(f.headDepth, "Profundidade do rebaixo", size?.counterbore.depth);
    if (hd <= diameter) throw new Error("O rebaixo tem de ser maior que o furo");
    if (hh >= depth) throw new Error("O rebaixo é mais profundo que o furo");
    g.cb = { r: hd / 2, depth: hh };
  } else if (head === "countersink") {
    const hd = P(f.headDiameter, "Diâmetro do escareado", size?.countersink?.d);
    const ha = P(f.headAngle, "Ângulo do escareado", size?.countersink?.angle ?? 90);
    if (hd <= diameter) throw new Error("O escareado tem de ser maior que o furo");
    g.cs = { r: hd / 2, depth: (hd / 2 - diameter / 2) / Math.tan((ha * Math.PI) / 360) };
  }

  const d = f.flip ? s.frame.z : v3.mul(s.frame.z, -1);
  const solids = points.map(({ id, p }) => holeSolid(g, to3D(s.frame, p), d, s.frame.x, f.id, id));
  const tool: NamedBody = solids.length === 1 ? solids[0] : { shape: makeCompound(solids.map((x) => x.shape)), faces: solids.flatMap((x) => x.faces) };
  ctx.tools.set(f.id, { body: tool, op: "cut" });
  const body = applyOp(ctx, tool, "cut", f.id);

  const rows: [string, string][] = [["Furos", String(points.length)]];
  if (f.kind === "clearance") rows.push(["Passagem", `${f.size} (${{ close: "fino", normal: "médio", loose: "largo" }[f.fit ?? "normal"]}) — ⌀${fmt(diameter)} mm`]);
  if (f.kind === "tapped") {
    const tl = through ? depth : P(f.threadDepth, "Comprimento roscado", depth);
    rows.push(["Rosca (cosmética)", `${f.size} × ${fmt(size!.pitch)}`], ["Broca", `⌀${fmt(diameter)} mm`], ["Comprimento roscado", through ? "passante" : `${fmt(Math.min(tl, depth))} mm`]);
  }
  if (f.kind === "simple") rows.push(["Diâmetro", `⌀${fmt(diameter)} mm`]);
  rows.push(["Fim", through ? "Passante" : `Cego, ${fmt(depth)} mm${g.tip ? `, ponta ${fmt(tipAngle)}°` : ", fundo plano"}`]);
  if (g.cb) rows.push(["Rebaixo", `⌀${fmt(g.cb.r * 2)} × ${fmt(g.cb.depth)} mm`]);
  if (g.cs) rows.push(["Escareado", `⌀${fmt(g.cs.r * 2)} mm`]);
  report.info = { title: "Furo", rows, note: f.kind === "simple" ? undefined : HOLE_NOTE };
  return { ...ctx, body };
}
