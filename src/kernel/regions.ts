// Regiões de um esboço com curvas que se cruzam ou sobrepõem ("contornos selecionados").
// O plano é dividido por todas as curvas (não de construção) com o BRepAlgoAPI_Splitter do OpenCASCADE:
// cada face resultante que não toca na moldura exterior é uma região. A geometria é exata (arcos, splines).
import { cast } from "replicad";
import type { RegionRef, SketchEntity } from "../doc/types.ts";
import type { P2 } from "../sketch/geometry.ts";
import { type Seg, entitySeg, segSample } from "../sketch/profiles.ts";
import { type Frame, to2D, to3D } from "./frame.ts";
import { segEdges, mapEdgesToEntities } from "./sketch3d.ts";
import { T, type TopoDS_Face, type TopoDS_Shape, edgeProps, explore, faceProps, makeList, oc } from "./occ.ts";
import { assembleWire, makeFace, makeLine } from "replicad";

export interface SketchRegion {
  face: TopoDS_Face;
  /**
   * Assinatura: entidades que delimitam a região, cada uma com o lado em que a região fica
   * ("c2+" = dentro do círculo c2 / à esquerda da linha; "c2-" = fora / à direita). Ordenada.
   */
  sig: string[];
  /** Ponto interior (coordenadas do esboço). */
  seed: P2;
  area: number;
  /** Triângulos da região em 2D (x0,y0,x1,y1,x2,y2,…), para mostrar e escolher na interface. */
  tris: number[];
  /** Arestas da face → entidade do esboço de origem. */
  edgeMap: Map<TopoDS_Shape, string>;
}

export function computeRegions(entities: Record<string, SketchEntity>, frame: Frame): SketchRegion[] {
  const segs: Seg[] = [];
  for (const [id, e] of Object.entries(entities)) {
    if (e.type === "point" || e.construction) continue;
    const s = entitySeg(entities, id);
    if (s) segs.push(s);
  }
  if (!segs.length) return [];
  const pts = segs.flatMap(segSample);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const span = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const m = span * 0.1;
  const box = [Math.min(...xs) - m, Math.max(...xs) + m, Math.min(...ys) - m, Math.max(...ys) + m];
  const corners: P2[] = [[box[0], box[2]], [box[1], box[2]], [box[1], box[3]], [box[0], box[3]]];
  const frameFace = T(makeFace(assembleWire(corners.map((c, i) => makeLine(to3D(frame, c), to3D(frame, corners[(i + 1) % 4]))))));

  const tools = segs.flatMap((s) => segEdges(s, frame)).map((e) => T(e).wrapped as TopoDS_Shape);
  const o = oc();
  const sp = T(new o.BRepAlgoAPI_Splitter());
  sp.SetArguments(makeList([frameFace.wrapped]));
  sp.SetTools(makeList(tools));
  sp.Build();
  if (sp.HasErrors()) throw new Error("Não foi possível calcular as regiões do esboço");
  const result = T(sp.Shape());

  const tol = span * 1e-7;
  const onFrame = (p: P2) => Math.abs(p[0] - box[0]) < tol || Math.abs(p[0] - box[1]) < tol || Math.abs(p[1] - box[2]) < tol || Math.abs(p[1] - box[3]) < tol;
  const regions: SketchRegion[] = [];
  for (const face of explore(result, "face")) {
    if (explore(face, "edge").some((e) => onFrame(to2D(frame, edgeProps(e).mid)))) continue;
    const edgeMap = mapEdgesToEntities(face, segs, frame) as Map<TopoDS_Shape, string>;
    const ids = [...new Set(edgeMap.values())];
    const mesh = cast(face).mesh({ tolerance: span * 1e-3, angularTolerance: 0.2 });
    const tris: number[] = [];
    let best = -1, seed: P2 = [0, 0];
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const q = [0, 1, 2].map((k) => { const i = mesh.triangles[t + k] * 3; return to2D(frame, [mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]]); });
      tris.push(...q.flat());
      const a = Math.abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1])) / 2;
      if (a > best) { best = a; seed = [(q[0][0] + q[1][0] + q[2][0]) / 3, (q[0][1] + q[1][1] + q[2][1]) / 3]; }
    }
    const sig = ids.map((id) => `${id}${sideOf(segs.find((s) => s.entity === id)!, seed) ? "+" : "-"}`).sort();
    regions.push({ face, sig, seed, area: faceProps(face).area, tris, edgeMap });
  }
  return regions.sort((a, b) => a.sig.join().localeCompare(b.sig.join()) || a.seed[0] - b.seed[0] || a.seed[1] - b.seed[1]);
}

/** Lado de uma entidade em que está o ponto: dentro do círculo/arco, ou à esquerda da linha/spline. */
function sideOf(s: Seg, p: P2): boolean {
  if (s.kind === "circle" || s.kind === "arc") return Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) < s.r;
  const poly = segSample(s);
  let best = Infinity, left = false;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    if (d < best) { best = d; left = dx * (p[1] - a[1]) - dy * (p[0] - a[0]) > 0; }
  }
  return left;
}

/** Ponto dentro de uma região (pelos triângulos). */
export function regionContains(r: Pick<SketchRegion, "tris">, p: P2): boolean {
  const t = r.tris;
  for (let i = 0; i < t.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = t.slice(i, i + 6);
    const d1 = (p[0] - bx) * (ay - by) - (ax - bx) * (p[1] - by);
    const d2 = (p[0] - cx) * (by - cy) - (bx - cx) * (p[1] - cy);
    const d3 = (p[0] - ax) * (cy - ay) - (cx - ax) * (p[1] - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}

/**
 * Resolve as regiões escolhidas: assinatura igual → região que contém o ponto → maior semelhança de
 * assinatura (Jaccard ≥ 0,5). Devolve as regiões e os avisos.
 */
export function resolveRegions(all: SketchRegion[], refs: RegionRef[]): { regions: SketchRegion[]; warnings: string[] } {
  const out: SketchRegion[] = [];
  const warnings: string[] = [];
  for (const ref of refs) {
    const key = ref.sig.join("+");
    const same = all.filter((x) => x.sig.join("+") === key);
    // várias regiões com as mesmas entidades: a que contém o ponto
    let hit = same.find((x) => regionContains(x, ref.seed)) ?? same[0];
    if (!hit) {
      hit = all.find((x) => regionContains(x, ref.seed))!;
      if (hit) warnings.push(`Região ${key} reencontrada pela posição`);
    }
    if (!hit) {
      const jac = (a: string[], b: string[]) => { const s = new Set(a); const i = b.filter((x) => s.has(x)).length; return i / (a.length + b.length - i); };
      const cand = all.map((x) => ({ x, j: jac(x.sig, ref.sig) })).sort((a, b) => b.j - a.j)[0];
      if (cand && cand.j >= 0.5) { hit = cand.x; warnings.push(`Região ${key} reencontrada por semelhança`); }
    }
    if (!hit) { warnings.push(`Região ${key} já não existe`); continue; }
    if (!out.includes(hit)) out.push(hit);
  }
  return { regions: out, warnings };
}

export const regionKey = (r: Pick<SketchRegion, "sig">) => r.sig.join("+");
