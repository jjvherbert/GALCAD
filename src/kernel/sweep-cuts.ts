// Cortes para varrer (C8 → C9a): partições que tornam os sólidos de um estudo FEM em blocos hexaédricos
// (6 faces de 4 arestas), para a malha de hexaedros não cair na subdivisão. O avaliador (mesh-advisor) usa-o.
import type { Ctx } from "./context.ts";
import type { FemStudy } from "../doc/study.ts";
import type { TopoRef } from "../doc/types.ts";
import { type TopoDS_Shape, bbox, faceProps } from "./occ.ts";
import { hintFor } from "./naming.ts";
import { studyPlan, type StudyPlan } from "./sim-fem.ts";
import { applyPatch } from "../sim/mesh-advice.ts";
import type { V3 } from "../sim/case.ts";

type Partition = NonNullable<FemStudy["mesh"]["partitions"]>[number];
type Plane = { origin: V3; normal: V3 };

/** Um grupo de cortes que se aceita junto (ex.: as duas diagonais de uma placa com furo). */
export type SweepCut = { key: string; parts: Partition[]; planes: Plane[]; faces: TopoRef[]; kind: "face" | "axis" };

export type SweepCuts = {
  /** Grupos escolhidos, pela ordem da escolha gulosa. */
  cuts: SweepCut[];
  /** Sólidos e quantos são blocos, antes e depois dos cortes. */
  before: { solids: number; blocks: number };
  after: { solids: number; blocks: number };
  plan: StudyPlan;
};

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const corners = (s: TopoDS_Shape): V3[] => {
  const b = bbox(s), out: V3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
};

/**
 * Sugere cortes para varrer: candidatos são os planos das faces planas do corpo e, por cada furo/face
 * cilíndrica, planos pelo eixo (o par de diagonais para os cantos e os dois planos alinhados com o corpo).
 * Escolha gulosa (até 4 grupos): aceita o grupo que mais reduz os sólidos que não são blocos, ou que aumenta
 * os blocos sem os reduzir (um corte de um L só fecha com o seguinte). Devolve null se já são todos blocos,
 * se não há plano ou se nenhum grupo ajuda.
 */
export function suggestSweepCuts(ctx: Ctx, s: FemStudy, sp: StudyPlan = studyPlan(ctx, s)): SweepCuts | null {
  const body = ctx.body;
  if (!body || !sp.plan || !sp.plan.blocks.some((b) => !b)) return null;
  const blocks = sp.plan.blocks, solids = sp.input.solids;
  const badBoxes = solids.filter((_, i) => !blocks[i]).map(corners);
  /** O plano atravessa a caixa de algum sólido que não é bloco (senão não muda nada). */
  const cutsBad = (n: V3, off: number) => badBoxes.some((cs) => { const ds = cs.map((c) => dot(n, c) - off); return Math.max(...ds) > 1e-3 && Math.min(...ds) < -1e-3; });
  const seen: { n: V3; off: number }[] = [];
  const fresh = (n: V3, off: number) => {
    if (seen.some((q) => Math.abs(Math.abs(dot(q.n, n)) - 1) < 1e-6 && Math.abs(q.off * Math.sign(dot(q.n, n)) - off) < 1e-6)) return false;
    seen.push({ n, off }); return true;
  };
  const cand: SweepCut[] = [];
  const planeNormals: V3[] = [];
  for (const nf of body.faces) {
    const fp = faceProps(nf.face);
    if (fp.type !== "plane" || !fp.normal || !fp.planeOrigin) continue;
    const n = fp.normal as V3, o = fp.planeOrigin as V3, off = dot(n, o);
    planeNormals.push(n);
    if (!fresh(n, off) || !cutsBad(n, off)) continue;
    const ref: TopoRef = { kind: "face", name: nf.name, hint: hintFor("face", nf.face) };
    cand.push({ key: nf.name, kind: "face", parts: [{ axis: "f", at: 0, face: ref }], planes: [{ origin: o, normal: n }], faces: [ref] });
  }
  // furos: planos pelo eixo. A costura da face cilíndrica parte um dos setores; o plano alinhado que a
  // atravessa fecha-o (as diagonais sozinhas deixam 1 de 4 por bloco numa placa com furo).
  const axes: { o: V3; d: V3 }[] = [];
  const allCorners = solids.flatMap(corners);
  for (const nf of body.faces) {
    const fp = faceProps(nf.face);
    if (fp.type !== "cylinder" || !fp.axis) continue;
    const o = fp.axis.o as V3, d = unit(fp.axis.d as V3);
    if (axes.some((a) => Math.abs(Math.abs(dot(a.d, d)) - 1) < 1e-6 && Math.hypot(...cross(sub(o, a.o), d)) < 1e-6)) continue;
    axes.push({ o, d });
    const ref: TopoRef = { kind: "face", name: nf.name, hint: hintFor("face", nf.face) };
    const u0 = planeNormals.find((n) => Math.abs(dot(n, d)) < 1e-6);
    const u = u0 ?? unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u);
    const pu = allCorners.map((c) => dot(sub(c, o), u)), pv = allCorners.map((c) => dot(sub(c, o), v));
    const uMax = Math.max(...pu), uMin = Math.min(...pu), vMax = Math.max(...pv), vMin = Math.min(...pv);
    /** Plano que contém o eixo e a direção w (perpendicular a d). */
    const through = (w: V3) => { const n = unit(cross(d, w)); return { n, off: dot(n, o) }; };
    const group = (key: string, ws: V3[]) => {
      const ps = ws.map(through).filter((p) => cutsBad(p.n, p.off) && fresh(p.n, p.off));
      if (ps.length) cand.push({
        key: `${nf.name}~${key}`, kind: "axis", faces: [ref],
        parts: ps.map((p): Partition => ({ axis: "n", normal: p.n, at: p.off })),
        planes: ps.map((p) => ({ origin: o, normal: p.n })),
      });
    };
    const at = (a: number, b: number): V3 => [u[0] * a + v[0] * b, u[1] * a + v[1] * b, u[2] * a + v[2] * b];
    if (uMax > 0 && uMin < 0 && vMax > 0 && vMin < 0) group("diag", [at(uMax, vMax), at(uMax, vMin)]);
    group("u", [u]);
    group("v", [v]);
  }
  const bad = (p: StudyPlan) => (p.plan ? p.plan.blocks.filter((b) => !b).length : Infinity);
  const good = (p: StudyPlan) => (p.plan ? p.plan.blocks.filter((b) => b).length : 0);
  const chosen: SweepCut[] = [];
  let cur = bad(sp), curGood = good(sp), curPlan = sp;
  // até 16 candidatos, metade para eixos de furos e metade para faces (o que sobrar de um lado preenche o outro),
  // para que um corpo com muitas faces planas não deixe os furos de fora.
  const ax = cand.filter((c) => c.kind === "axis"), fc = cand.filter((c) => c.kind === "face");
  const nAx = Math.min(ax.length, Math.max(8, 16 - fc.length));
  const pool = [...ax.slice(0, nAx), ...fc.slice(0, 16 - nAx)];
  for (let k = 0; k < 4 && cur > 0; k++) {
    let best: { c: SweepCut; p: StudyPlan; b: number; g: number } | null = null;
    for (const c of pool) {
      if (chosen.includes(c)) continue;
      const p = studyPlan(ctx, { ...s, mesh: applyPatch(s.mesh, { addPartitions: [...chosen, c].flatMap((x) => x.parts) }) });
      if (p.warnings.some((w) => /parti/i.test(w) && !sp.warnings.includes(w))) continue;
      const b = bad(p), g = good(p);
      if ((b < cur || (b === cur && g > curGood)) && (!best || b < best.b || (b === best.b && g > best.g))) best = { c, p, b, g };
    }
    if (!best) break;
    chosen.push(best.c); cur = best.b; curGood = best.g; curPlan = best.p;
  }
  if (!chosen.length || cur >= bad(sp)) return null;
  const N = blocks.length, N1 = curPlan.plan!.blocks.length;
  return { cuts: chosen, before: { solids: N, blocks: N - bad(sp) }, after: { solids: N1, blocks: N1 - cur }, plan: curPlan };
}
