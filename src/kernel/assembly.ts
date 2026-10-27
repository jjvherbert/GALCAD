// Montagens no núcleo: reconstrói as peças (com a cache de cada uma), extrai a geometria das
// referências dos mates, resolve os mates (subconjuntos como corpos rígidos) e devolve as instâncias.
import type { AssemblyDoc, CadProject, Component, MateRef } from "../doc/project.ts";
import { partKey } from "../doc/knowledge.ts";
import { resolveVariables, evalParam } from "../doc/variables.ts";
import type { StdAxis, StdPlane, Vec3 } from "../doc/types.ts";
import {
  type MateGeom, type Pose, type SolverMate, I3, applyPose, composePose, eulerXYZ, mv, poseMatrix, solveMates,
} from "../assembly/solver.ts";
import type { AssemblyInstance, MassProps, MateStatus } from "./protocol.ts";
import type { MeshData } from "./mesh.ts";
import type { Ctx, StepReport } from "./context.ts";
import { edges as resolveEdges, faces as resolveFaces } from "./context.ts";
import { STD_AXES, STD_FRAMES } from "./frame.ts";
import { edgeProps, explore, faceProps, normalOnFace, sampleEdge, v3 } from "./occ.ts";

/** Peça reconstruída, pronta a instanciar. */
export interface PartBuild {
  ctx: Ctx;
  mesh: MeshData | null;
  volume: number;
  area: number;
  center: Vec3;
  bbox: { min: Vec3; max: Vec3 } | null;
  errors: number;
}

export interface SolvedInstance { path: string[]; part: string; pose: Pose; names: string[] }

export interface AssemblyBuild {
  ok: boolean;
  dof: number;
  messages: string[];
  mates: Record<string, MateStatus>;
  instances: SolvedInstance[];
}

/** Geometria de referência (no referencial da peça) de uma face ou aresta, ou de um plano/eixo padrão. */
export function refGeometry(ctx: Ctx | null, ref: MateRef): MateGeom {
  if ("std" in ref) {
    const s = ref.std;
    if (s === "XY" || s === "XZ" || s === "YZ") return { kind: "plane", p: [0, 0, 0], n: STD_FRAMES[s as StdPlane].z };
    return { kind: "axis", p: [0, 0, 0], d: STD_AXES[s as StdAxis].d };
  }
  if (!ctx) throw new Error("Referência sem peça");
  const report: StepReport = { warnings: [] };
  if (ref.ref.kind === "face") {
    const [nf] = resolveFaces(ctx, [ref.ref], report);
    if (!nf) throw new Error(`Face "${ref.ref.name}" inexistente`);
    const p = faceProps(nf.face);
    if (p.type === "plane") return { kind: "plane", p: p.center, n: normalOnFace(nf.face, p.center) };
    if (p.axis) {
      const e = explore(nf.face, "edge")[0];
      const q = e ? sampleEdge(e, 3)[1].p : p.center;
      const r = v3.dist(v3.cross(v3.sub(q, p.axis.o), p.axis.d), [0, 0, 0]);
      return { kind: "axis", p: p.axis.o, d: p.axis.d, r: p.type === "cylinder" ? r : undefined };
    }
    if (p.type === "sphere") return { kind: "point", p: p.center };
    throw new Error(`A face "${ref.ref.name}" (${p.type}) não serve para mates: use faces planas, cilíndricas ou cónicas`);
  }
  const [ne] = resolveEdges(ctx, [ref.ref], report);
  if (!ne) throw new Error(`Aresta "${ref.ref.name}" inexistente`);
  const e = edgeProps(ne.edge);
  if (e.type === "line" && e.dir) return { kind: "axis", p: e.start, d: e.dir };
  if (e.type === "circle" && e.center && e.dir) return { kind: "axis", p: e.center, d: e.dir, r: e.radius };
  throw new Error(`A aresta "${ref.ref.name}" não serve para mates: use arestas retas ou circulares`);
}

const posePlacement = (c: Component): Pose => ({ R: eulerXYZ(c.placement.r), t: c.placement.t });

/**
 * Resolve uma montagem (recursivamente). As poses das instâncias ficam no referencial desta montagem.
 * Num subconjunto, os mates do conjunto de cima referem-se às suas peças por "caminho/face".
 */
export async function solveAssembly(
  project: CadProject, asmId: string, getPart: (id: string) => Promise<PartBuild>, stack: string[] = [],
): Promise<AssemblyBuild> {
  const asm = project.assemblies.find((a) => a.id === asmId);
  if (!asm) throw new Error(`Montagem ${asmId} inexistente`);
  if (stack.includes(asmId)) throw new Error(`Montagem recursiva: ${[...stack, asmId].join(" → ")}`);
  const messages: string[] = [];
  const comps = asm.components.filter((c) => !c.suppressed);
  // conteúdo de cada componente (peça ou subconjunto resolvido)
  const content = new Map<string, { part?: PartBuild; sub?: AssemblyBuild }>();
  for (const c of comps) {
    if (c.ref.kind === "part") {
      if (!project.parts.some((p) => p.id === c.ref.id)) { messages.push(`${c.name}: peça inexistente`); continue; }
      content.set(c.id, { part: await getPart(partKey(c)) });
    } else {
      const sub = await solveAssembly(project, c.ref.id, getPart, [...stack, asmId]);
      if (!sub.ok) messages.push(`${c.name}: o subconjunto tem mates por resolver`);
      content.set(c.id, { sub });
    }
  }
  const live = comps.filter((c) => content.has(c.id));

  // geometria de uma referência no referencial do componente de topo
  const geomOf = (ref: MateRef): MateGeom => {
    if (ref.component === "") return refGeometry(null, ref);
    const k = content.get(ref.component);
    if (!k) throw new Error(`Componente ${ref.component} indisponível`);
    if (k.part) return refGeometry(k.part.ctx, ref);
    if ("std" in ref) return refGeometry(null, ref);
    // subconjunto: "c1/c3/nome" → instância c1/c3 e a referência "nome" na sua peça
    const parts = ref.ref.name.split("/");
    const inner = parts.slice(0, -1).join("/");
    const inst = k.sub!.instances.find((i) => i.path.join("/") === inner);
    if (!inst) throw new Error(`Referência "${ref.ref.name}" não encontrada no subconjunto`);
    const g = refGeometry(partCtxOf(inst), { component: ref.component, ref: { ...ref.ref, name: parts.at(-1)! } });
    const P = inst.pose;
    if (g.kind === "plane") return { kind: "plane", p: applyPose(P, g.p), n: mv(P.R, g.n) };
    if (g.kind === "axis") return { kind: "axis", p: applyPose(P, g.p), d: mv(P.R, g.d), r: g.r };
    return { kind: "point", p: applyPose(P, g.p) };
  };
  const partCtxs = new Map<string, Ctx>();
  const partCtxOf = (inst: SolvedInstance) => partCtxs.get(inst.part) ?? null;
  for (const c of live) {
    const k = content.get(c.id)!;
    if (k.part) partCtxs.set(partKey(c), k.part.ctx);
  }
  // as peças dos subconjuntos também precisam do contexto (para a geometria das referências)
  for (const c of live) {
    const sub = content.get(c.id)!.sub;
    if (sub) for (const i of sub.instances) if (!partCtxs.has(i.part)) partCtxs.set(i.part, (await getPart(i.part)).ctx);
  }

  const scope = resolveVariables(asm.variables ?? []).scope;
  const status: Record<string, MateStatus> = {};
  const mates: SolverMate[] = [];
  for (const m of asm.mates) {
    if (m.suppressed) continue;
    try {
      const angle = m.kind === "angle";
      const value = m.kind === "distance" || angle ? evalParam(m.value, scope, m.name) * (angle ? Math.PI / 180 : 1) : undefined;
      mates.push({ id: m.id, kind: m.kind, a: m.a.component || null, ga: geomOf(m.a), b: m.b.component || null, gb: geomOf(m.b), value, align: m.align });
    } catch (e) {
      status[m.id] = { ok: false, residual: Infinity, error: (e as Error).message };
    }
  }
  const size = Math.max(100, ...live.map((c) => {
    const b = content.get(c.id)!.part?.bbox;
    return b ? v3.dist(b.min, b.max) : 100;
  }));
  const solverComps = live.map((c, i) => ({ id: c.id, fixed: c.fixed ?? i === 0, pose: posePlacement(c) }));
  const r = solveMates(solverComps, mates, size);
  for (const [id, res] of r.residuals) status[id] = { ok: res <= 1e-6, residual: res };
  for (const f of r.failed) status[f.id] = { ...(status[f.id] ?? { residual: Infinity }), ok: false, error: f.error };

  const instances: SolvedInstance[] = [];
  for (const c of live) {
    const P = r.poses.get(c.id) ?? posePlacement(c);
    const k = content.get(c.id)!;
    if (k.part) instances.push({ path: [c.id], part: partKey(c), pose: P, names: [c.name] });
    else for (const i of k.sub!.instances) instances.push({ path: [c.id, ...i.path], part: i.part, pose: composePose(P, i.pose), names: [c.name, ...i.names] });
  }
  const ok = Object.values(status).every((s) => s.ok) && !messages.length;
  return { ok, dof: r.dof, messages, mates: status, instances };
}

/** Propriedades de massa (volume, área, centro, caixa) de uma montagem resolvida. */
export function assemblyMass(instances: SolvedInstance[], parts: Map<string, PartBuild>): MassProps | null {
  let vol = 0, area = 0, solids = 0;
  let c: Vec3 = [0, 0, 0];
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const i of instances) {
    const p = parts.get(i.part);
    if (!p || !p.bbox) continue;
    vol += p.volume;
    area += p.area;
    solids += explore(p.ctx.body?.shape ?? (null as never), "solid").length;
    c = v3.add(c, v3.mul(applyPose(i.pose, p.center), p.volume));
    for (const x of [p.bbox.min[0], p.bbox.max[0]]) for (const y of [p.bbox.min[1], p.bbox.max[1]]) for (const z of [p.bbox.min[2], p.bbox.max[2]]) {
      const q = applyPose(i.pose, [x, y, z]);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
    }
  }
  if (!instances.length || !Number.isFinite(lo[0])) return null;
  return { volume: vol, area, center: vol > 0 ? v3.mul(c, 1 / vol) : [0, 0, 0], bbox: { min: lo, max: hi }, solids };
}

export function toInstances(b: AssemblyBuild): AssemblyInstance[] {
  return b.instances.map((i) => ({ path: i.path.join("/"), top: i.path[0], part: i.part, name: i.names.join(" / "), matrix: poseMatrix(i.pose) }));
}

export { I3 };
export type { AssemblyDoc };
