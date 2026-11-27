// Estudos: caso FEM de uma peça (apoios, cargas, malha e hipóteses).
import { type FemStudy, type LoadCsys, loadEdges, loadFaces, plasticCurveErrors } from "../doc/study.ts";
import { evalParam } from "../doc/variables.ts";
import { exprIdentifiers } from "../doc/expr.ts";
import type { MeshEdit } from "../sim/mshedit.ts";
import { type Expr, type TopoRef } from "../doc/types.ts";
import { type Ctx, type StepReport, edges as resolveEdges, faces as resolveFaces, featureName, modelSize, planeFrame } from "./context.ts";
import { type CutPlane, type PartitionTool, partitionSolid, sweptCut } from "./partition.ts";
import { chainWire } from "./sketch3d.ts";
import { chainsOf, one, shiftFrame } from "./features/surface-common.ts";
import { type PlanInput, meshPlan } from "./meshplan.ts";
import { T, type TopoDS_Shape, bbox, explore, gpAx2, gpVec, oc, sampleEdge, v3 } from "./occ.ts";
import { edgeProps, faceProps } from "./occ-props.ts";
import { type CaseCsys, type CaseFace, type FemCase, type FemCaseLoad, type V3, amplitudeTable, csysAxes, csysToGlobal, loadGroup, thermalFieldAt } from "../sim/case.ts";
import { type MeshGeo, bodyOf, caseFaces, shellOf, tagsOf, n3 } from "./sim-common.ts";
import { orthoPlyError } from "../sim/laminate.ts";

const FEM_HYP: Record<FemStudy["analysis"], string> = {
  static: "Estática linear: pequenos deslocamentos e deformações, material elástico linear isotrópico, sem contacto",
  modal: "Modal: frequências próprias com as condições de apoio indicadas (sem cargas, sem amortecimento)",
  buckling: "Encurvadura linear (valores próprios): fatores sobre as cargas indicadas, sem imperfeições nem plasticidade",
  thermal: "Térmica em regime permanente: condução isotrópica, convecção e fluxo impostos, sem radiação",
  dynamic: "Dinâmica transitória linear: pequenos deslocamentos, material elástico linear, cargas com amplitude no tempo, condições iniciais nulas",
};

/** Topologia do estudo pela ordem do model.brep: o corpo (ou a chapa) e, com partições, os blocos. */
export interface FemTopo {
  shape: TopoDS_Shape;
  solids: TopoDS_Shape[];
  faces: CaseFace[];
  allFaces: TopoDS_Shape[];
  allEdges: TopoDS_Shape[];
  /** Tags das faces (sub-faces nas partições) das referências. */
  faceTags: (refs: TopoRef[], what: string) => number[];
  /** Tags das arestas do modelo que vêm de uma aresta do corpo (as sub-arestas, se foi cortada). */
  edgeIdx: (e: TopoDS_Shape) => number[];
  /**
   * Tags das arestas novas que as partições abrem numa face do corpo (referência `cut@<face>`): por
   * exemplo a linha a meia espessura onde um plano corta a face exterior (NAFEMS LE10).
   */
  cutEdges: (face: TopoRef, what: string) => number[];
  note?: string;
}

/** Prefixo das referências a arestas de corte das partições: `cut@<nome da face>`. */
export const CUT_EDGE = "cut@";

export function femTopo(ctx: Ctx, s: FemStudy, report: StepReport): FemTopo {
  const sh = s.shell ? shellOf(ctx) : undefined;
  const solid = sh ? sh.shape : bodyOf(ctx);
  const cuts = s.mesh.partitions ?? [];
  if (sh || !cuts.length) {
    const faces = sh ? caseFaces(ctx, solid, sh.faces) : caseFaces(ctx, solid);
    const allEdges = explore(solid, "edge");
    return {
      shape: solid, solids: sh ? [] : [solid], faces, allFaces: explore(solid, "face"), allEdges,
      faceTags: (refs, what) => tagsOf(ctx, faces, solid, refs, what, report),
      edgeIdx: (e) => { const i = allEdges.findIndex((x) => x.IsSame(e)); return i < 0 ? [] : [i + 1]; },
      cutEdges: (_f, what) => { throw new Error(`${what}: as arestas de corte só existem com partições da malha`); },
    };
  }
  // «só nesta face»: o corte limita-se às linhas na face e é varrido pela espessura (normal da face)
  const onFace = (c: (typeof cuts)[number], i: number): Partial<CutPlane> => {
    if (!c.onFace) return {};
    const nf = resolveFaces(ctx, [c.onFace], report)[0];
    const q = faceProps(nf.face);
    if (!q.normal) throw new Error(`Partição ${i + 1}: a face "${nf.name}" onde fica o corte não é plana`);
    return { face: nf.face, sweep: q.normal, label: `Partição ${i + 1} na face "${nf.name}"` };
  };
  const tool = (c: (typeof cuts)[number], i: number): PartitionTool => {
    if (c.axis === "f") {
      // o plano da face prolongado para lá dos seus limites (Abaqus: Partition Cell > Extend Face)
      if (!c.face) throw new Error(`Partição ${i + 1}: escolha a face plana cujo plano corta o sólido`);
      const nf = resolveFaces(ctx, [c.face], report)[0];
      const q = faceProps(nf.face);
      if (!q.normal || !q.planeOrigin) throw new Error(`Partição ${i + 1}: a face "${nf.name}" não é plana`);
      return { axis: "n" as const, normal: q.normal, at: q.normal.reduce((a, v, k) => a + v * q.planeOrigin![k], 0), label: `Partição ${i + 1} pela face "${nf.name}"`, ...onFace(c, i) };
    }
    if (c.axis === "plane") {
      // um plano de referência: padrão, de referência, de um sistema de eixos ou uma face plana
      if (!c.plane) throw new Error(`Partição ${i + 1}: escolha o plano de referência`);
      const fr = planeFrame(ctx, c.plane, report);
      return { axis: "n" as const, normal: fr.z, at: v3.dot(fr.z, fr.o), label: `Partição ${i + 1} pelo plano de referência`, ...onFace(c, i) };
    }
    if (c.axis === "sketch") {
      // as curvas do esboço extrudidas nos dois sentidos para lá do modelo (Abaqus: Extrude/Sweep Edges)
      if (!c.sketch) throw new Error(`Partição ${i + 1}: escolha o esboço`);
      const far = modelSize(ctx);
      const { s: sk, chains } = chainsOf(ctx, c.sketch, report);
      if (!chains.length) throw new Error(`Partição ${i + 1}: o esboço não tem curvas`);
      const shape = one(chains.map((ch) => {
        const wire = chainWire(ch, shiftFrame(sk.frame, v3.mul(sk.frame.z, -far))).wrapped;
        return T(T(new (oc().BRepPrimAPI_MakePrism)(wire, gpVec(v3.mul(sk.frame.z, 2 * far)), false, true)).Shape());
      }));
      const name = featureName(ctx, c.sketch);
      if (!c.onFace) return { kind: "shape", shape, label: `Partição ${i + 1} pelo esboço "${name}"` };
      // curva projetada numa face (SolidWorks: Split Line › Projection): só as linhas que o esboço traça na
      // face, varridas pela espessura na normal da face, para a face oposta receber a mesma divisão
      const nf = resolveFaces(ctx, [c.onFace], report)[0];
      const q = faceProps(nf.face);
      if (!q.normal) throw new Error(`Partição ${i + 1}: a face "${nf.name}" onde se projeta o esboço não é plana`);
      const cut = sweptCut(shape, nf.face, q.normal, far);
      if (!cut) throw new Error(`Partição ${i + 1}: o esboço "${name}" não se projeta na face "${nf.name}"`);
      return { kind: "shape", shape: cut, label: `Partição ${i + 1}: esboço "${name}" projetado na face "${nf.name}"` };
    }
    if (c.axis === "cyl") {
      // uma superfície cilíndrica de raio R, infinita no eixo (Abaqus: Partition Cell > Extrude a circle)
      const r = evalParam(c.at, ctx.scope, `Partição ${i + 1} raio`);
      if (!(r > 0)) throw new Error(`Partição ${i + 1}: o raio do cilindro tem de ser maior que zero`);
      let o: V3, d: V3, why: string;
      if (c.face) {
        // eixo de uma face cilíndrica (um furo, um veio): o cilindro fica coaxial
        const nf = resolveFaces(ctx, [c.face], report)[0];
        const ax = faceProps(nf.face).axis;
        if (!ax) throw new Error(`Partição ${i + 1}: a face "${nf.name}" não é cilíndrica`);
        o = ax.o; d = ax.d; why = `coaxial com "${nf.name}"`;
      } else {
        const ev = (v: Expr | undefined, k: string, dflt: number) => (v === undefined ? dflt : evalParam(v, ctx.scope, `Partição ${i + 1} ${k}`));
        o = [0, 1, 2].map((k) => ev(c.origin?.[k], `origem ${"xyz"[k]}`, 0)) as V3;
        d = [0, 1, 2].map((k) => ev(c.normal?.[k], `eixo ${"xyz"[k]}`, k === 2 ? 1 : 0)) as V3;
        why = `eixo por (${o.join("; ")})`;
      }
      const len = Math.hypot(...d);
      if (!(len > 1e-12)) throw new Error(`Partição ${i + 1}: a direção do eixo do cilindro é nula`);
      d = v3.mul(d, 1 / len);
      const x = v3.norm(v3.cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
      const far = modelSize(ctx), o_ = oc();
      const circ = T(new o_.gp_Circ(gpAx2(v3.sub(o, v3.mul(d, far)), d, x), r));
      const wire = T(T(new o_.BRepBuilderAPI_MakeWire(T(T(new o_.BRepBuilderAPI_MakeEdge(circ)).Edge()))).Wire());
      const shape = T(T(new o_.BRepPrimAPI_MakePrism(wire, gpVec(v3.mul(d, 2 * far)), false, true)).Shape());
      return { kind: "shape", shape, label: `Partição ${i + 1} (cilindro R = ${r}, ${why})` };
    }
    const at = evalParam(c.at, ctx.scope, `Partição ${i + 1}`);
    return {
      axis: c.axis, at, label: `Partição ${i + 1} (${c.axis === "n" ? "n·x" : c.axis.toUpperCase()} = ${at})`,
      normal: c.axis === "n" ? (c.normal ?? [0, 0, 1]).map((v, k) => evalParam(v, ctx.scope, `Partição ${i + 1} normal ${"xyz"[k]}`)) as [number, number, number] : undefined,
      ...onFace(c, i),
    };
  };
  // cada ferramenta é diagnosticada à parte: a que não se consegue construir fica de fora com aviso
  const tools = cuts.flatMap((c, i): PartitionTool[] => {
    try { return [tool(c, i)]; } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      report.warnings.push(`${m.startsWith("Partição") ? m : `Partição ${i + 1}: ${m}`} — ignorada`);
      return [];
    }
  });
  const p = partitionSolid(solid, tools);
  report.warnings.push(...p.skipped);
  // nomes: a face de origem (com ~k se foi dividida) ou «corte k» nas faces novas
  const base = p.faces.map((f) => { const o = p.origin(f); return o ? ctx.body!.faces.find((n) => n.face.IsSame(o))?.name ?? "?" : undefined; });
  const total = new Map<string, number>(), seen = new Map<string, number>();
  for (const b of base) if (b) total.set(b, (total.get(b) ?? 0) + 1);
  let cut = 0;
  const named = p.faces.map((face, i) => {
    const b = base[i];
    if (!b) return { face, name: `corte ${++cut}` };
    const k = (seen.get(b) ?? 0) + 1;
    seen.set(b, k);
    return { face, name: total.get(b)! > 1 ? `${b}~${k}` : b };
  });
  const faces = caseFaces(ctx, p.shape, named as never);
  const index = (list: TopoDS_Shape[], x: TopoDS_Shape) => list.findIndex((y) => y.IsSame(x)) + 1;
  return {
    shape: p.shape, solids: p.solids, faces, allFaces: p.faces, allEdges: p.edges,
    faceTags: (refs, what) => {
      if (!refs.length) throw new Error(`${what}: escolha as faces`);
      return resolveFaces(ctx, refs, report).flatMap((nf) => {
        const sub = p.sub(nf.face);
        if (!sub.length) throw new Error(`${what}: a face "${nf.name}" não pertence ao corpo do estudo`);
        return sub.map((f) => index(p.faces, f));
      });
    },
    edgeIdx: (e) => p.sub(e).map((x) => index(p.edges, x)).filter((t) => t > 0),
    cutEdges: (ref, what) => {
      const [nf] = resolveFaces(ctx, [ref], report);
      const own = new Set<number>();
      for (const sf of p.sub(nf.face)) for (const e of explore(sf, "edge")) own.add(index(p.edges, e));
      const out = new Set<number>();
      for (const cf of p.faces.filter((f) => !p.origin(f))) for (const e of explore(cf, "edge")) { const k = index(p.edges, e); if (own.has(k)) out.add(k); }
      out.delete(0);
      if (!out.size) throw new Error(`${what}: nenhuma partição corta a face "${nf.name}"`);
      return [...out].sort((a, b) => a - b);
    },
    note: p.used ? `Partições: ${p.used} ferramenta(s) dividem o sólido em ${p.solids.length} blocos com faces de corte partilhadas (malha conforme); cargas, apoios e seeds passam às sub-faces e sub-arestas` : undefined,
  };
}

export function femCase(ctx: Ctx, s: FemStudy, report: StepReport, topo = femTopo(ctx, s, report)): FemCase {
  const { faces, allEdges } = topo;
  const b = bbox(topo.shape);
  const edgeTags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as arestas`);
    const cuts = refs.filter((r) => r.name.startsWith(CUT_EDGE));
    const plain = refs.filter((r) => !r.name.startsWith(CUT_EDGE));
    const fromCuts = cuts.flatMap((r) => topo.cutEdges({ kind: "face", name: r.name.slice(CUT_EDGE.length) }, what));
    const fromPlain = (plain.length ? resolveEdges(ctx, plain, report) : []).flatMap((ne) => {
      const t = topo.edgeIdx(ne.edge);
      if (!t.length) throw new Error(`${what}: a aresta "${ne.name}" não pertence ao ${s.shell ? "modelo" : "corpo"}`);
      return t;
    });
    return [...fromCuts, ...fromPlain];
  };
  const geo: MeshGeo = { solids: topo.solids, faces: topo.allFaces, edges: allEdges, edgeTags, ...(topo.note ? { note: topo.note } : {}) };
  return buildFemCase(s, ctx.scope, faces, topo.faceTags, { min: b.min as V3, max: b.max as V3 }, report, geo);
}


/** Casca: espessura avaliada e as opções que o modelo de casca ainda não suporta recusadas. */
const SHELL_LOADS = new Set(["fixed", "displacement", "force", "pressure", "gravity"]);
function shellCheck(s: FemStudy, sc: Ctx["scope"], tags: (refs: TopoRef[], what: string) => number[]): FemCase["shell"] & {} {
  const plies = s.shell!.plies?.length ? s.shell!.plies : undefined;
  // regiões: faces com laminado próprio; uma face só pode estar numa região
  const seen = new Map<number, number>();
  const regions = (s.shell!.regions ?? []).map((r, i) => {
    if (!r.plies.length) throw new Error(`Laminado, região ${i + 1}: sem camadas`);
    r.plies.forEach((p, k) => { const e = orthoPlyError(p); if (e) throw new Error(`Laminado, região ${i + 1}, camada ${k + 1}: ${e}`); });
    const faces = tags(r.faces, `Laminado, região ${i + 1}`);
    if (!faces.length) throw new Error(`Laminado, região ${i + 1}: escolha pelo menos uma face`);
    for (const f of faces) {
      if (seen.has(f)) throw new Error(`Laminado, região ${i + 1}: a face ${f} já está na região ${seen.get(f)! + 1}`);
      seen.set(f, i);
    }
    return { faces, plies: r.plies };
  });
  if (plies || regions.length) {
    plies?.forEach((p, k) => { const e = orthoPlyError(p); if (e) throw new Error(`Laminado, camada ${k + 1}: ${e}`); });
    if (s.analysis !== "static" && s.analysis !== "modal" && s.analysis !== "buckling") throw new Error("Laminado em casca: só estática, modal ou encurvadura nesta versão");
    if (s.mesh.order !== 2) throw new Error("Laminado em casca: requer malha de ordem 2 (S6)");
  }
  const thickness = plies ? plies.reduce((a, p) => a + p.t, 0) : evalParam(s.shell!.thickness, sc, "Espessura da casca");
  if (!(thickness > 0)) throw new Error("Espessura da casca: tem de ser positiva");
  const no = (what: string) => { throw new Error(`Casca: ${what} ainda não é suportado`); };
  const sv = s.solver ?? "calculix";
  if (sv !== "calculix" && sv !== "code_aster") no(`o solver ${s.solver}`);
  if (sv === "code_aster" && plies) throw new Error("Casca: o laminado ainda não está no code_aster (use o CalculiX)");
  if (sv === "code_aster" && s.analysis === "buckling") no("a encurvadura em casca no code_aster");
  if (s.analysis !== "static" && s.analysis !== "modal" && s.analysis !== "buckling") no(`a análise ${s.analysis}`);
  if (s.nonlinear?.geometry || s.nonlinear?.plasticity) no("a análise não linear");
  if (s.mesh.element === "hex" || s.mesh.seeds?.length || s.mesh.mapped?.length || (s.mesh.layers ?? 0) > 1 || s.mesh.partitions?.length) no("a malha manual (hexaedros, seeds, faces mapeadas ou partições)");
  if (s.contact && s.contact.mode !== "none") no("o contacto");
  for (const l of s.loads) if (!SHELL_LOADS.has(l.kind)) no(`a condição «${l.kind}»`);
  return { thickness, ...(plies ? { plies } : {}), ...(regions.length ? { regions } : {}) };
}

/** Referencial local de uma condição: avaliado e conferido (erro se degenerado). */
function loadCsys(c: LoadCsys | undefined, sc: Ctx["scope"], i: number): CaseCsys | undefined {
  if (!c) return undefined;
  const r: CaseCsys = { type: c.type, a: n3(c.a, sc, `Condição ${i + 1}: referencial (a)`), b: n3(c.b, sc, `Condição ${i + 1}: referencial (b)`) };
  try { csysAxes(r); } catch (e) { throw new Error(`Condição ${i + 1}: ${(e as Error).message}`); }
  return r;
}

/** Caso FEM a partir das faces com tag e de um resolvedor de referências (peça ou montagem). */
const HEX_NAME = (order: 1 | 2, integ: FemStudy["mesh"]["integration"]) => order === 2 ? (integ === "full" ? "C3D20 / HEXA20" : "C3D20R / HEXA20 (integração reduzida)") : integ === "full" ? "C3D8 / HEXA8 (integração completa)" : integ === "reduced" ? "C3D8R / HEXA8 (integração reduzida, controlo de hourglass)" : "C3D8I (modos incompatíveis) / HEXA8";

export function buildFemCase(s: FemStudy, sc: Ctx["scope"], faces: CaseFace[], tags: (refs: TopoRef[], what: string) => number[], box: { min: V3; max: V3 }, report: StepReport, geo: MeshGeo): FemCase {
  const groups: Record<string, number[]> = {};
  const edgeGroups: Record<string, number[]> = {}, edgeLength: Record<string, number> = {};
  const loads: FemCaseLoad[] = [];
  // passos de carga (só estática): índice de cada id; as condições recebem os índices onde estão ativas
  const multi = (s.steps?.length ?? 0) > 1;
  if (multi && s.analysis !== "static") report.warnings.push("Passos de carga: só na análise estática — ignorados (um só passo)");
  const stepIdx = new Map((multi && s.analysis === "static" ? s.steps! : []).map((st, k) => [st.id, k]));
  s.loads.forEach((l, i) => {
    const n0 = loads.length;
    loadCase(l, i);
    if (!stepIdx.size || !l.steps || l.kind === "spring" || l.kind === "mass" || l.kind === "thermalField") return;
    const ks = l.steps.map((id) => stepIdx.get(id)).filter((k): k is number => k !== undefined).sort((a, b) => a - b);
    if (!ks.length) report.warnings.push(`Condição ${i + 1}: não está ativa em nenhum passo`);
    if (ks.length < stepIdx.size) for (let j = n0; j < loads.length; j++) loads[j].steps = ks;
  });
  function loadCase(l: FemStudy["loads"][number], i: number) {
    if (l.kind === "gravity") { loads.push({ kind: "gravity", g: n3(l.g, sc, "Gravidade") }); return; }
    if (l.kind === "thermalField") {
      const what = `Condição ${i + 1}: campo de temperatura`;
      if (s.analysis !== "static") throw new Error(`${what}: só na análise estática`);
      const src = String(l.t ?? "").trim();
      if (!src) throw new Error(`${what}: indique T(x, y, z)`);
      const vars: Record<string, number> = {};
      try {
        for (const id of exprIdentifiers(src)) {
          if (id === "x" || id === "y" || id === "z") continue;
          const v = sc(id);
          if (v === undefined) throw new Error(`variável desconhecida "${id}"`);
          vars[id] = v;
        }
        const mid: V3 = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2) as V3;
        thermalFieldAt({ t: src, vars })(mid);
      } catch (e) { throw new Error(`${what}: ${(e as Error).message}`); }
      loads.push({ kind: "thermalField", t: src, vars, tRef: evalParam(l.tRef, sc, `${what}: temperatura de referência`, 0) });
      return;
    }
    if (l.kind === "pointForce") { loads.push({ kind: "pointForce", point: n3(l.point, sc, `Condição ${i + 1}: ponto`), f: n3(l.f, sc, `Condição ${i + 1}: força`) }); return; }
    const g = loadGroup(i, l.kind);
    const edges = loadEdges(s, l);
    if (edges.length) {
      if (loadFaces(s, l).length) throw new Error(`Condição ${i + 1}: escolha faces ou arestas, não ambas`);
      edgeGroups[g] = geo.edgeTags(edges, `Condição ${i + 1}`);
      edgeLength[g] = edgeGroups[g].reduce((a, t) => a + edgeProps(geo.edges[t - 1]).length, 0);
    } else groups[g] = tags(loadFaces(s, l), `Condição ${i + 1}`);
    if (l.kind === "symmetry") {
      // simetria: o deslocamento normal ao plano é nulo (faces planas alinhadas com um eixo); desliza no plano
      const byAxis: number[][] = [[], [], []];
      for (const t of groups[g]) {
        const f = faces.find((x) => x.tag === t)!;
        const k = f.normal ? f.normal.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-6) : -1;
        if (k < 0) throw new Error(`Condição ${i + 1} (simetria): a face ${f.name} tem de ser plana e alinhada com X, Y ou Z`);
        byAxis[k].push(t);
      }
      delete groups[g];
      byAxis.forEach((ts, k) => {
        if (!ts.length) return;
        const gk = `${g}_${"XYZ"[k]}`;
        groups[gk] = ts;
        loads.push({ kind: "displacement", group: gk, u: [0, 1, 2].map((q) => (q === k ? 0 : null)) });
      });
      return;
    }
    switch (l.kind) {
      case "fixed": loads.push({ kind: "fixed", group: g }); break;
      case "displacement": {
        const csys = loadCsys(l.csys, sc, i);
        const vel = !!l.velocity;
        if (vel && s.analysis !== "dynamic") throw new Error(`Condição ${i + 1}: a velocidade imposta só existe na análise dinâmica`);
        if (vel && csys) throw new Error(`Condição ${i + 1}: a velocidade imposta só aceita o referencial global`);
        loads.push({ kind: "displacement", group: g, u: [l.ux, l.uy, l.uz].map((x, k) => (x === undefined || x === "" ? null : evalParam(x, sc, `${vel ? "Velocidade" : "Deslocamento"} ${"XYZ"[k]}`))), ...(csys && { csys }), ...(vel && { velocity: true }) });
        break;
      }
      case "force": {
        const csys = loadCsys(l.csys, sc, i), f = n3(l.f, sc, "Força");
        if (csys?.type === "cyl") throw new Error(`Condição ${i + 1} (força): a força total só aceita um referencial retangular (para cargas radiais use uma pressão)`);
        // força total num referencial retangular: as mesmas componentes globais em todos os nós
        loads.push({ kind: "force", group: g, f: csys ? csysToGlobal(csysAxes(csys)!, f) : f });
        break;
      }
      case "spring": {
        const k = n3(l.k, sc, "Rigidez da mola"), csys = loadCsys(l.csys, sc, i);
        if (k.some((x) => x < 0)) throw new Error(`Condição ${i + 1} (mola): a rigidez não pode ser negativa`);
        loads.push({ kind: "spring", group: g, k, ...(csys && { csys }) });
        break;
      }
      case "mass": {
        const m = evalParam(l.m, sc, "Massa");
        if (m < 0) throw new Error(`Condição ${i + 1} (massa): a massa não pode ser negativa`);
        loads.push({ kind: "mass", group: g, m: m / 1000 }); // kg → t
        break;
      }
      case "coupling": {
        if (l.mode === "distributing" && edges.length) throw new Error(`Condição ${i + 1} (acoplamento distribuído): escolha faces (as arestas só aceitam o acoplamento rígido)`);
        const z = (v?: [Expr, Expr, Expr], w = "") => (v ? n3(v, sc, `Condição ${i + 1}: ${w}`) : [0, 0, 0] as V3);
        loads.push({ kind: "coupling", group: g, point: n3(l.point, sc, `Condição ${i + 1}: ponto`), mode: l.mode, f: z(l.f, "força"), mo: z(l.mo, "momento") });
        break;
      }
      case "pressure": loads.push({ kind: "pressure", group: g, p: evalParam(l.p, sc, "Pressão") }); break;
      case "temperature": loads.push({ kind: "temperature", group: g, t: evalParam(l.t, sc, "Temperatura") }); break;
      case "convection": loads.push({ kind: "convection", group: g, h: evalParam(l.h, sc, "Coeficiente h"), tInf: evalParam(l.tInf, sc, "Temperatura do fluido") }); break;
      case "heatFlux": loads.push({ kind: "heatFlux", group: g, q: evalParam(l.q, sc, "Fluxo de calor") }); break;
    }
  }
  const local = (s.mesh.local ?? []).map((l, i) => {
    const g = `R${i + 1}`;
    groups[g] = tags(l.faces, `Refinamento ${i + 1}`);
    return { group: g, size: evalParam(l.size, sc, "Tamanho local") };
  });
  const probes = (s.probes ?? []).map((pr, i) => {
    const key = `probe${i + 1}`;
    if (pr.at.kind === "faces") {
      groups[`P${i + 1}`] = tags(pr.at.faces, `Sonda ${pr.name || i + 1}`);
      return { key, name: pr.name || `Sonda ${i + 1}`, quantity: pr.quantity, group: `P${i + 1}`, stat: pr.stat };
    }
    return { key, name: pr.name || `Sonda ${i + 1}`, quantity: pr.quantity, point: n3(pr.at.point, sc, `Sonda ${i + 1}`) };
  });
  const size = evalParam(s.mesh.size, sc, "Tamanho da malha");
  if (size <= 0) throw new Error("Tamanho da malha: tem de ser positivo");
  // malha manual: seeds, faces mapeadas e hexaedros
  const element = s.mesh.element ?? "tet";
  const shell = s.shell ? shellCheck(s, sc, tags) : undefined;
  let solidLaminate: FemCase["solidLaminate"];
  if (s.solidLaminate) {
    const L = s.solidLaminate;
    if (s.shell) throw new Error("Laminado sólido: não pode ser usado com casca");
    if ((s.solver ?? "calculix") !== "calculix") throw new Error("Laminado sólido: só no CalculiX");
    if (s.analysis === "thermal") throw new Error("Laminado sólido: ainda não na análise térmica");
    if (!L.plies?.length) throw new Error("Laminado sólido: sem camadas");
    L.plies.forEach((p, k) => { const e = orthoPlyError(p); if (e) throw new Error(`Laminado sólido, camada ${k + 1}: ${e}`); });
    solidLaminate = { plies: L.plies, z0: evalParam(L.z0, sc, "Laminado sólido: z0", box.min[2]) };
  }
  const localSize = new Map<number, number>();
  for (const l of local) for (const t of groups[l.group]) localSize.set(t, Math.min(l.size, localSize.get(t) ?? Infinity));
  const plan = element === "hex" || s.mesh.seeds?.length || s.mesh.mapped?.length || (s.mesh.layers ?? 0) > 1 ? meshPlan({
    solids: geo.solids, faces: geo.faces, edges: geo.edges, size, localSize, element, hexMethod: s.mesh.hexMethod ?? "auto", names: geo.names,
    seeds: (s.mesh.seeds ?? []).map((sd, i) => ({ tags: geo.edgeTags(sd.edges, `Seed ${i + 1}`), mode: sd.mode, value: evalParam(sd.value, sc, `Seed ${i + 1}`), bias: sd.bias === undefined || sd.bias === "" ? 1 : evalParam(sd.bias, sc, `Seed ${i + 1}: razão`), biasAt: sd.biasAt ?? "start", biasPoint: sd.biasPoint })),
    mapped: s.mesh.mapped?.length ? tags(s.mesh.mapped, "Faces mapeadas") : [], layers: s.mesh.layers,
  }) : undefined;
  report.warnings.push(...(plan?.warnings ?? []));
  const v3 = (e: Expr[], what: string) => e.map((x, k) => evalParam(x, sc, `${what} ${"XYZ"[k]}`)) as [number, number, number];
  const edits: MeshEdit[] = (s.mesh.edits ?? []).map((e, i) => e.kind === "move"
    ? { kind: "move", at: v3(e.at, `Edição ${i + 1}: ponto`), to: v3(e.to, `Edição ${i + 1}: destino`) }
    : { kind: "delete", at: v3(e.at, `Edição ${i + 1}: ponto`), ...(e.radius === undefined || e.radius === "" ? {} : { radius: evalParam(e.radius, sc, `Edição ${i + 1}: raio`) }) });
  const meshHyp = shell
    ? `Malha: cascas triangulares de ordem ${s.mesh.order} (${s.mesh.order === 2 ? "S6" : "S3"}, Gmsh), tamanho máx. ${size} mm — confirmar a convergência refinando`
    : element === "hex"
    ? `Malha: ${plan!.notes.join("; ")}, elementos ${HEX_NAME(s.mesh.order, s.mesh.integration)} (Gmsh), tamanho ${size} mm — confirmar a convergência refinando e a qualidade (pré-visualização da malha)`
    : `Malha: tetraedros de ordem ${s.mesh.order} (Gmsh), tamanho máx. ${size} mm${plan?.notes.length ? `; ${plan.notes.join("; ")}` : ""} — confirmar a convergência refinando`;
  const thermal = s.analysis === "thermal";
  if (thermal && !s.loads.some((l) => l.kind === "temperature" || l.kind === "convection")) report.warnings.push("Térmica sem temperatura nem convecção imposta: o problema não tem solução única");
  if (!thermal && s.analysis !== "modal" && !s.loads.some((l) => l.kind === "fixed" || l.kind === "displacement" || l.kind === "symmetry" || l.kind === "spring")) report.warnings.push("Sem apoios: movimento de corpo rígido");
  // na dinâmica só a plasticidade (a não linearidade geométrica fica para a estática)
  const nl = s.analysis === "static" && (s.nonlinear?.geometry || s.nonlinear?.plasticity)
    ? { geometry: !!s.nonlinear.geometry, plasticity: !!s.nonlinear.plasticity, increments: Math.max(1, Math.round(s.nonlinear.increments ?? 10)) }
    : s.analysis === "dynamic" && s.nonlinear?.plasticity ? { geometry: false, plasticity: true, increments: 1 } : undefined;
  const m = s.material;
  if (nl?.plasticity && !(m.yield! > 0)) throw new Error("Plasticidade: indique a tensão de cedência do material");
  const curve = nl?.plasticity ? m.plasticCurve : undefined;
  if (curve?.length) { const e = plasticCurveErrors(m); if (e.length) throw new Error(`Plasticidade: ${e[0]}`); }
  else if (nl?.plasticity && !(m.tangent! >= 0 && m.tangent! < m.E)) throw new Error("Plasticidade: o módulo tangente tem de estar entre 0 e E");
  if (s.solver === "openradioss" && s.analysis !== "dynamic") throw new Error("OpenRadioss: escolha a análise «Dinâmica transitória» (explícita)");
  // dinâmica: duração, passo, amplitude e Rayleigh resolvidos
  let dynamic: FemCase["dynamic"];
  if (s.analysis === "dynamic") {
    const d = s.dynamic ?? { scheme: "implicit", duration: 0.01, load: "step" };
    const T = evalParam(d.duration, sc, "Duração");
    if (!(T > 0)) throw new Error("Dinâmica: a duração tem de ser positiva");
    const opt = (x: unknown, label: string) => (x === undefined || x === "" ? undefined : evalParam(x as never, sc, label));
    const dt = opt(d.dt, "Passo de tempo") ?? (d.scheme === "implicit" ? T / 200 : undefined);
    if (dt !== undefined && !(dt > 0 && dt <= T)) throw new Error("Dinâmica: o passo tem de estar entre 0 e a duração");
    const rise = opt(d.rise, "Tempo de subida"), period = opt(d.period, "Período");
    if ((d.load === "halfsine" || d.load === "sine") && !(period! > 0)) throw new Error("Dinâmica: indique o período (ou a duração do meio seno)");
    const alpha = opt(d.alpha, "Rayleigh α") ?? 0, beta = opt(d.beta, "Rayleigh β") ?? 0;
    if (alpha < 0 || beta < 0) throw new Error("Dinâmica: os coeficientes de Rayleigh não podem ser negativos");
    dynamic = { scheme: d.scheme, duration: T, dt, amplitude: amplitudeTable(d.load, T, rise, period), alpha, beta, frames: Math.min(400, Math.max(5, Math.round(d.frames ?? 50))) };
    const v0 = d.v0?.map((x, k) => opt(x, `Velocidade inicial ${"XYZ"[k]}`) ?? 0) as [number, number, number] | undefined;
    if (v0?.some((x) => !Number.isFinite(x))) throw new Error("Dinâmica: velocidade inicial inválida");
    if (v0?.some((x) => x !== 0)) dynamic.v0 = v0;
    if (s.solver === "openradioss" && d.scheme !== "explicit") throw new Error("OpenRadioss: só integração explícita");
    if ((s.solver ?? "calculix") === "calculix" && d.scheme !== "explicit" && nl?.plasticity && s.mesh.order === 2) report.warnings.push("CalculiX: plasticidade na dinâmica implícita com elementos quadráticos tende a divergir — use ordem 1 (hexaedros com integração completa)");
    if (s.solver === "code_aster" && d.scheme === "explicit") report.warnings.push("code_aster explícito (DIFF_CENT): lento e só com integração completa — para impacto use o CalculiX (ou o OpenRadioss)");
  }
  const LOAD_NAME = { step: "degrau", ramp: "rampa", halfsine: "meio seno", sine: "seno" } as const;
  const analysisHyp = dynamic
    ? `${nl?.plasticity ? FEM_HYP.dynamic.replace("Dinâmica transitória linear", "Dinâmica transitória").replace("material elástico linear", `material elastoplástico (von Mises, encruamento isotrópico ${curve?.length ? "multilinear" : "bilinear"})`) : FEM_HYP.dynamic}; ${dynamic.scheme === "implicit" ? "integração implícita (CalculiX: α-HHT, α = −0,05; code_aster: Newmark, aceleração média)" : "integração explícita (diferenças centrais, massa diagonal, passo abaixo do limite de estabilidade)"}; ${dynamic.duration} s${dynamic.dt ? `, passo ${dynamic.dt} s` : ", passo estável da malha"}; carga em ${LOAD_NAME[s.dynamic?.load ?? "step"]}; ${dynamic.alpha || dynamic.beta ? `amortecimento de Rayleigh α = ${dynamic.alpha} 1/s, β = ${dynamic.beta} s` : "sem amortecimento físico"}`
    : !nl ? FEM_HYP[s.analysis]
    : `Estática não linear (${[nl.geometry && "grandes deslocamentos e rotações", nl.plasticity && `plasticidade de von Mises com encruamento isotrópico ${curve?.length ? "multilinear" : "bilinear"}`].filter(Boolean).join("; ")}), carga aplicada em ${nl.increments}+ incrementos, cargas de direção fixa, sem contacto`;
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: s.solver ?? "calculix", title: s.name, analysis: s.analysis, modes: s.modes ?? 6, nonlinear: nl, dynamic, ...(stepIdx.size ? { steps: s.steps!.map((st, k) => st.name || `Passo ${k + 1}`) } : {}), probes: probes.length ? probes : undefined,
    ...(shell ? { shell } : {}), ...(solidLaminate ? { solidLaminate } : {}), material: s.material, groups, ...(Object.keys(edgeGroups).length ? { edgeGroups, edgeLength } : {}), faces, loads, bbox: box,
    mesh: {
      size, minSize: evalParam(s.mesh.minSize, sc, "Tamanho mínimo", size / 10), curvature: s.mesh.curvature ?? 12, order: s.mesh.order, local,
      ...(element === "hex" ? { element, integration: s.mesh.integration ?? (s.mesh.order === 2 ? "reduced" : "incompatible") } : {}),
      ...(plan && !shell ? { hexMethod: plan.hexMethod, volumes: plan.volumes, surfaces: plan.surfaces, curves: plan.curves } : {}),
      ...(edits.length ? { edits } : {}),
    },
    hypotheses: [
      analysisHyp,
      ...(solidLaminate ? [`Laminado sólido: ${solidLaminate.plies.length} camadas ortotrópicas em z a partir de z = ${solidLaminate.z0} mm (${solidLaminate.plies.map((p) => `${p.theta}°/${p.t}`).join(", ")}); cada elemento fica na camada do seu centroide`] : []),
      `Material: ${m.name} (E = ${m.E} MPa, ν = ${m.nu}${thermal ? `, k = ${m.k} W/(m·K)` : `, ρ = ${m.density} g/cm³`}${nl?.plasticity ? `, σy = ${m.yield} MPa, ${curve?.length ? `curva σ–εp com ${curve.length} pontos até ${curve[curve.length - 1][0]} MPa (plástico perfeito depois)` : `Et = ${m.tangent} MPa`}` : ""})${m.source ? ` — ${m.source}` : ""}`,
      meshHyp,
      ...(edits.length ? [`Malha editada à mão: ${edits.filter((e) => e.kind === "move").length} nó(s) movido(s), ${edits.filter((e) => e.kind === "delete").length} apagamento(s) de elementos — as faces e arestas das cargas/apoios que deixam de ser fronteira saem dos grupos; confirmar na pré-visualização`] : []),
      ...(geo.note ? [geo.note] : []),
      ...(shell ? [shell.plies
        ? `Casca laminada (Mindlin, S6, *SHELL SECTION COMPOSITE) na superfície média da chapa: ${shell.plies.length} camadas [${shell.plies.map((p) => `${p.theta}°`).join("/")}] da base para o topo, espessura total ${shell.thickness} mm; ângulos medidos a partir do eixo x projetado na superfície; camadas ortotrópicas (E3 = E2, G13 = G12); tensões da camada e da altura com maior von Mises; a pressão atua segundo a normal da superfície`
        : `Casca de Mindlin (corte transversal incluído) na superfície média da chapa, espessura uniforme ${shell.thickness} mm; tensões no topo e na base (±t/2) da casca; a pressão atua segundo a normal da superfície`] : []),
      ...(shell && thermal ? ["Térmica na casca: condução no plano e através da espessura (S6 expandido em sólido), temperatura linear em cada camada; a convecção e o fluxo atuam na face do lado da normal (topo); a condutividade de cada camada é a dada nela (k ao longo das fibras, k2 na transversal) ou, sem ela, o k do material do estudo"] : []),
      ...(shell?.regions?.length ? [`Laminado por regiões: ${shell.regions.map((r, i) => `região ${i + 1} (faces ${r.faces.join(", ")}): [${r.plies.map((p) => `${p.theta}°`).join("/")}], ${+r.plies.reduce((a, p) => a + p.t, 0).toFixed(6)} mm`).join("; ")}; o resto da chapa fica com ${shell.plies ? "o laminado base" : `a casca isotrópica de ${shell.thickness} mm`}. Todas as secções com o mesmo número de camadas (a mais espessa é dividida em partes iguais) para o ccx dar tensões em todas; a superfície média é a mesma em todas as regiões (sem desvio)`] : []),
      "Forças distribuídas uniformemente pela área das faces; apoios ideais (rígidos)",
      ...(stepIdx.size ? [`${stepIdx.size} passos de carga sequenciais: cada passo parte do estado final do anterior (deslocamentos e, com plasticidade, deformações permanentes); molas e massas ativas em todos`] : []),
      ...(Object.keys(edgeGroups).length ? ["Condições em arestas: força distribuída uniformemente pelo comprimento, apoio nos nós da aresta; a tensão junto à aresta é singular (depende da malha) — ler os resultados a uma distância de alguns elementos"] : []),
      ...(s.loads.some((l) => l.kind === "symmetry") ? ["Simetria: modelo parcial — geometria, apoios e cargas têm de ser simétricos em relação ao plano; as cargas são as da parte modelada (metade da total) e os resultados só valem nessa parte"] : []),
      "Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado",
    ],
  };
}

/** Nós de uma aresta na pré-visualização das seeds (malha ao vivo, sem Gmsh). */
export interface SeedEdge { tag: number; n: number; kind: "user" | "propagated" | "auto"; progression?: number; bump?: number; points: number[] }
export interface SeedPreview { edges: SeedEdge[]; warnings: string[]; notes: string[] }

/**
 * Frações (0..1, ao longo do comprimento) dos n+1 nós de uma aresta com a distribuição do Gmsh:
 * Progression r = elementos de comprimento r^i a partir do início; Bump b aproximado por um tamanho
 * 1 + (1/b − 1)·4x(1−x) (b < 1: refinado nas pontas; b > 1: no centro).
 */
export function seedFractions(n: number, d: { progression?: number; bump?: number } = {}): number[] {
  if (d.progression && d.progression !== 1) {
    const l = Array.from({ length: n }, (_, i) => d.progression! ** i);
    const tot = l.reduce((a, b) => a + b, 0);
    let acc = 0;
    return [0, ...l.map((x) => (acc += x) / tot)].map((x, i) => (i === n ? 1 : x));
  }
  if (d.bump && d.bump !== 1) {
    // densidade 1/tamanho integrada numericamente e invertida
    const m = 400, k = 1 / d.bump - 1, cum = [0];
    for (let i = 0; i < m; i++) { const x = (i + 0.5) / m; cum.push(cum[i] + 1 / (1 + k * 4 * x * (1 - x))); }
    const out = [0];
    for (let j = 1, i = 0; j < n; j++) {
      const target = (cum[m] * j) / n;
      while (cum[i + 1] < target) i++;
      out.push((i + (target - cum[i]) / (cum[i + 1] - cum[i])) / m);
    }
    return [...out, 1];
  }
  return Array.from({ length: n + 1 }, (_, i) => i / n);
}

/** Pontos às frações dadas do comprimento da aresta (amostragem do parâmetro e interpolação por arco). */
function pointsAlong(edge: TopoDS_Shape, fr: number[]): number[] {
  const s = sampleEdge(edge, 200), cum = [0];
  for (let i = 1; i < s.length; i++) cum.push(cum[i - 1] + Math.hypot(s[i].p[0] - s[i - 1].p[0], s[i].p[1] - s[i - 1].p[1], s[i].p[2] - s[i - 1].p[2]));
  const L = cum[cum.length - 1] || 1, out: number[] = [];
  let i = 0;
  for (const f of fr) {
    const target = f * L;
    while (i < s.length - 2 && cum[i + 1] < target) i++;
    const u = cum[i + 1] > cum[i] ? Math.min(1, Math.max(0, (target - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
    for (let k = 0; k < 3; k++) out.push(s[i].p[k] + (s[i + 1].p[k] - s[i].p[k]) * u);
  }
  return out;
}

/** Plano da malha de um estudo, tolerante (entradas inválidas viram avisos): partilhado pela pré-visualização das seeds e pelo avaliador. */
export interface StudyPlan {
  topo: FemTopo;
  input: PlanInput;
  plan: ReturnType<typeof meshPlan> | null;
  size: number;
  /** Tamanho efetivo das arestas sem curva no plano: o menor entre o global e os locais das faces vizinhas. */
  near: Map<number, number>;
  curves: Map<number, MeshPlanCurve>;
  /** N.º de elementos numa aresta (tag 1-based) segundo o plano. */
  nOf: (tag: number) => { n: number; kind: SeedEdge["kind"] };
  warnings: string[];
}
type MeshPlanCurve = NonNullable<ReturnType<typeof meshPlan>["curves"]>[number];

export function studyPlan(ctx: Ctx, s: FemStudy): StudyPlan {
  const report: StepReport = { warnings: [] };
  const warnings: string[] = [];
  const tryDo = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch (e) { warnings.push((e as Error).message); return fallback; } };
  const topo = tryDo(() => femTopo(ctx, s, report), null) ?? femTopo(ctx, { ...s, mesh: { ...s.mesh, partitions: [] } }, report);
  const solid = topo.shape, allFaces = topo.allFaces, allEdges = topo.allEdges;
  const sc = ctx.scope;
  const edgeTags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as arestas`);
    return resolveEdges(ctx, refs, report).flatMap((ne) => topo.edgeIdx(ne.edge));
  };
  let size = tryDo(() => evalParam(s.mesh.size, sc, "Tamanho da malha"), NaN);
  if (!(size > 0)) {
    const b = bbox(solid);
    size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 10 || 1;
    warnings.push(`Tamanho da malha inválido: pré-visualização com ${+size.toPrecision(3)} mm`);
  }
  const localSize = new Map<number, number>();
  (s.mesh.local ?? []).forEach((l, i) => tryDo(() => {
    const v = evalParam(l.size, sc, "Tamanho local");
    if (v > 0) for (const t of topo.faceTags(l.faces, `Refinamento ${i + 1}`)) localSize.set(t, Math.min(v, localSize.get(t) ?? Infinity));
  }, undefined));
  const seeds = (s.mesh.seeds ?? []).flatMap((sd, i) => tryDo(() => {
    const value = evalParam(sd.value, sc, `Seed ${i + 1}`);
    const bias = sd.bias === undefined || sd.bias === "" ? 1 : evalParam(sd.bias, sc, `Seed ${i + 1}: razão`);
    if (!(value > 0) || !(bias >= 1)) throw new Error(`Seed ${i + 1}: valor positivo e razão ≥ 1`);
    return [{ tags: edgeTags(sd.edges, `Seed ${i + 1}`), mode: sd.mode, value, bias, biasAt: sd.biasAt ?? "start" as const, biasPoint: sd.biasPoint }];
  }, []));
  const mapped = s.mesh.mapped?.length ? tryDo(() => topo.faceTags(s.mesh.mapped!, "Faces mapeadas"), []) : [];
  const input: PlanInput = { solids: topo.solids.length ? topo.solids : [solid], faces: allFaces, edges: allEdges, size, localSize, element: s.mesh.element ?? "tet", hexMethod: s.mesh.hexMethod ?? "auto", seeds, mapped, layers: s.mesh.layers };
  let plan: ReturnType<typeof meshPlan> | null = null;
  try { plan = meshPlan(input); } catch (e) {
    warnings.push((e as Error).message);
    plan = tryDo(() => meshPlan({ ...input, hexMethod: "auto", mapped: mapped.filter((f) => { try { meshPlan({ ...input, hexMethod: "auto", mapped: [f] }); return true; } catch { return false; } }) }), null);
  }
  warnings.push(...(plan?.warnings ?? []), ...report.warnings);
  const curves = new Map((plan?.curves ?? []).map((c) => [c.tag, c]));
  const near = new Map<number, number>();
  allFaces.forEach((f, i) => {
    const ls = localSize.get(i + 1);
    if (ls !== undefined) for (const e of explore(f, "edge")) { const t = allEdges.findIndex((x) => x.IsSame(e)) + 1; if (t) near.set(t, Math.min(ls, near.get(t) ?? Infinity)); }
  });
  const nOf = (tag: number) => {
    const c = curves.get(tag);
    if (c) return { n: c.n, kind: (c.user ? "user" : "propagated") as SeedEdge["kind"] };
    return { n: Math.max(1, Math.ceil(edgeProps(allEdges[tag - 1]).length / Math.min(size, near.get(tag) ?? Infinity) - 1e-9)), kind: "auto" as const };
  };
  return { topo, input, plan, size, near, curves, nOf, warnings };
}

/**
 * Pré-visualização das seeds de um estudo FEM: n.º e posição dos nós em todas as arestas do corpo,
 * calculados pelo mesmo plano da malha que vai para o Gmsh (seeds, propagação pelas arestas opostas
 * das faces mapeadas e tamanho global/local nas restantes). Tolerante: entradas inválidas viram avisos.
 */
export function seedPreview(ctx: Ctx, s: FemStudy): SeedPreview {
  const sp = studyPlan(ctx, s);
  const edges = sp.topo.allEdges.map((e, i): SeedEdge => {
    const tag = i + 1, c = sp.curves.get(tag), { n, kind } = sp.nOf(tag);
    if (c) {
      const d = { progression: c.progression, bump: c.bump };
      return { tag, n, kind, ...(c.progression ? { progression: c.progression } : {}), ...(c.bump ? { bump: c.bump } : {}), points: pointsAlong(e, seedFractions(n, d)) };
    }
    return { tag, n, kind, points: pointsAlong(e, seedFractions(n)) };
  });
  return { edges, warnings: [...new Set(sp.warnings)], notes: sp.plan?.notes ?? [] };
}
