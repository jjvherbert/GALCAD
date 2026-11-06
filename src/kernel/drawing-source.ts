// Desenhos: fonte de uma vista (forma, arestas nomeadas, esboços e PMI) a partir de uma peça ou montagem.
import { type CadProject } from "../doc/project.ts";
import { applyPose } from "../assembly/solver.ts";
import { type KernelService } from "./service.ts";
import { solveAssembly, type PartBuild } from "./assembly.ts";
import { namedEdges } from "./naming.ts";
import { type TopoDS_Shape, T, edgeProps, makeCompound, oc, sampleEdge, setArena } from "./occ.ts";
import { pmiStates } from "./pmi.ts";
import { type Source } from "./drawing-common.ts";

export async function sourceOf(svc: KernelService, project: CadProject, src: { kind: "part" | "assembly"; id: string }): Promise<Source> {
  const builds = new Map<string, PartBuild>();
  const get = async (pid: string) => { let b = builds.get(pid); if (!b) { b = await svc.partBuild(project, pid); builds.set(pid, b); } return b; };
  const sample = (e: TopoDS_Shape) => {
    const p = edgeProps(e);
    return { pts: p.type === "line" ? [p.start, p.end] : sampleEdge(e, 25).map((s) => s.p), type: p.type };
  };
  if (src.kind === "part") {
    const b = await get(src.id);
    setArena(svc.drawingArena);
    const body = b.ctx.body;
    if (!body) throw new Error("A peça não tem corpo sólido");
    const doc = project.parts.find((p) => p.id === src.id)!;
    const sketches = [...b.ctx.sketches].map(([id, s]) => {
      const f = doc.features.find((x) => x.id === id);
      return { id, s, constraints: f?.type === "sketch" && !f.suppressed ? f.constraints.filter((c) => !c.driven) : [] };
    });
    const items = doc.pmi ?? [];
    const states = items.length ? pmiStates(b.ctx, items) : [];
    const pmi = items.map((item, i) => ({ item, state: states[i] })).filter((x) => !x.state.errors.length);
    return { shape: body.shape, edges: namedEdges(body).map((e) => ({ name: e.name, ...sample(e.edge) })), sketches, volume: b.volume, material: doc.properties?.material, pmi };
  }
  const asm = await solveAssembly(project, src.id, get);
  for (const i of asm.instances) await get(i.part);
  setArena(svc.drawingArena);
  const o = oc();
  const shapes: TopoDS_Shape[] = [];
  const edges: Source["edges"] = [];
  let vol = 0;
  for (const i of asm.instances) {
    const b = builds.get(i.part)!;
    const body = b.ctx.body;
    if (!body) continue;
    vol += b.volume;
    const t = T(new o.gp_Trsf());
    const R = i.pose.R, p = i.pose.t;
    t.SetValues(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2]);
    shapes.push(T(T(new o.BRepBuilderAPI_Transform(body.shape, t, true, false)).Shape()));
    for (const e of namedEdges(body)) {
      const s = sample(e.edge);
      edges.push({ name: `${i.path.join("/")}|${e.name}`, pts: s.pts.map((q) => applyPose(i.pose, q)), type: s.type, component: i.path[0] });
    }
  }
  if (!shapes.length) throw new Error("A montagem não tem peças com corpo");
  return { shape: makeCompound(shapes), edges, sketches: [], volume: vol };
}
