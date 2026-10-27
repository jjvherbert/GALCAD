// Geometria de painéis para o escantilhonamento (análise integrada Galkeel): para cada face escolhida,
// o plano médio, as dimensões do painel no plano (lado curto b e lado longo l do retângulo envolvente
// de área mínima da fronteira), a flecha (crown) c — maior afastamento da superfície ao plano que passa
// pela fronteira —, a área, o centroide e a normal para fora. São MEDIDAS do modelo; a norma pede as
// dimensões entre apoios (reforços/anteparas), que o engenheiro confirma no painel.
import type { Vec3 } from "../doc/types.ts";
import { type Ctx, type StepReport, faces as resolveFaces } from "./context.ts";
import { T, explore, faceProps, normalOnFace, oc, sampleEdge, v3 } from "./occ.ts";

export interface PanelGeom {
  name: string;
  type: string;
  area: number;
  center: Vec3;
  /** Normal para fora no centro (face orientada do sólido). */
  normal: Vec3;
  /** Normal do plano médio da fronteira e eixos do retângulo (b ao longo de ub, l ao longo de ul). */
  planeNormal: Vec3;
  ub: Vec3;
  ul: Vec3;
  b: number;
  l: number;
  crown: number;
  bbox: { min: Vec3; max: Vec3 };
}

/** Vetores próprios de uma matriz 3×3 simétrica (Jacobi), por valor próprio crescente. */
export function eigenSym3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-14) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3) };
}

/** Retângulo envolvente de área mínima de pontos 2D (rotação em passos de 0,5° e refinamento). */
export function minAreaRect(pts: [number, number][]): { w: number; h: number; angle: number } {
  const fit = (a: number) => {
    const c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { const u = c * x + s * y, w = -s * x + c * y; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, w); y1 = Math.max(y1, w); }
    return { w: x1 - x0, h: y1 - y0 };
  };
  let best = { a: 0, area: Infinity };
  for (let k = 0; k < 180; k++) { const a = (k * Math.PI) / 360; const r = fit(a); if (r.w * r.h < best.area) best = { a, area: r.w * r.h }; }
  for (let step = Math.PI / 720; step > 1e-6; step /= 2) for (const a of [best.a - step, best.a + step]) { const r = fit(a); if (r.w * r.h < best.area) best = { a, area: r.w * r.h }; }
  const r = fit(best.a);
  return { w: r.w, h: r.h, angle: best.a };
}

export function panelGeometry(ctx: Ctx, names: string[]): PanelGeom[] {
  if (!ctx.body) throw new Error("A peça não tem corpo sólido");
  const o = oc();
  const report: StepReport = { warnings: [] };
  return names.map((name) => {
    const [nf] = resolveFaces(ctx, [{ kind: "face", name }], report);
    if (!nf) throw new Error(`Face inexistente: ${name}`);
    const p = faceProps(nf.face);
    // pontos da fronteira
    const pts: Vec3[] = explore(nf.face, "edge").flatMap((e) => sampleEdge(e, 24).map((s) => s.p));
    const c0 = [0, 1, 2].map((k) => pts.reduce((s, q) => s + q[k], 0) / pts.length) as Vec3;
    const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => pts.reduce((s, q) => s + (q[i] - c0[i]) * (q[j] - c0[j]), 0) / pts.length));
    const { vectors } = eigenSym3(cov);
    let n = vectors[0];
    const outward = (() => { try { return normalOnFace(nf.face, p.center); } catch { return n; } })();
    if (p.type === "plane" && p.normal) n = p.normal;
    if (v3.dot(n, outward) < 0) n = v3.mul(n, -1) as Vec3;
    const e1 = v3.norm(v3.cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n)) as Vec3, e2 = v3.cross(n, e1) as Vec3;
    const p2 = pts.map((q): [number, number] => { const d = v3.sub(q, c0); return [v3.dot(d, e1), v3.dot(d, e2)]; });
    const r = minAreaRect(p2);
    const ca = Math.cos(r.angle), sa = Math.sin(r.angle);
    const ax1 = v3.add(v3.mul(e1, ca), v3.mul(e2, sa)) as Vec3, ax2 = v3.add(v3.mul(e1, -sa), v3.mul(e2, ca)) as Vec3;
    const [b, l, ub, ul] = r.w <= r.h ? [r.w, r.h, ax1, ax2] : [r.h, r.w, ax2, ax1];
    // flecha: pontos da triangulação da face contra o plano da fronteira
    // flecha = extensão da superfície segundo a normal do plano médio (corda → topo da curvatura)
    let crown = 0, dLo = Infinity, dHi = -Infinity;
    if (p.type !== "plane") {
      T(new o.BRepMesh_IncrementalMesh(nf.face, Math.max(0.05, l * 2e-3), false, 0.1, false));
      const f = T(o.TopoDS.Face(nf.face));
      const loc = T(new o.TopLoc_Location());
      const tri = o.BRep_Tool.Triangulation(f, loc, 0);
      if (tri && !(tri as unknown as { IsNull?: () => boolean }).IsNull?.()) {
        const trsf = loc.Transformation();
        for (let k = 1; k <= tri.NbNodes(); k++) {
          const q = tri.Node(k).Transformed(trsf);
          const d = v3.dot(v3.sub([q.X(), q.Y(), q.Z()], c0), n);
          dLo = Math.min(dLo, d); dHi = Math.max(dHi, d);
          q.delete();
        }
        crown = dHi - dLo;
      }
    }
    const bb = pts.reduce((acc, q) => ({ min: acc.min.map((x, k) => Math.min(x, q[k])) as Vec3, max: acc.max.map((x, k) => Math.max(x, q[k])) as Vec3 }), { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 });
    return { name: nf.name, type: p.type, area: p.area, center: p.center as Vec3, normal: outward as Vec3, planeNormal: n, ub, ul, b, l, crown, bbox: bb };
  });
}
