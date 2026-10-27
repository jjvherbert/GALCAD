// Serviço do núcleo: reconstrução, malhas e exportação. Usado pelo worker (e em testes).
import { cast } from "replicad";
import type { AssemblyResponse, CurvatureKind, CurvatureResponse, DeviationResponse, DrawingResponse, ExportFormat, InterferenceResponse, ExportResponse, MassProps, RebuildResponse, SheetInfo, SketchView } from "./protocol.ts";
import type { Ctx } from "./context.ts";
import type { NamedBody } from "./naming.ts";
import { curvature, deviation } from "./analysis.ts";
import type { CadDocument } from "../doc/types.ts";
import { Engine } from "./rebuild.ts";
import type { CadProject } from "../doc/project.ts";
import type { Vec3 } from "../doc/types.ts";
import { type PartBuild, assemblyMass, solveAssembly, toInstances } from "./assembly.ts";
import { buildDrawing } from "./drawing.ts";
import { nameFresh } from "./naming.ts";
import { assemblyMesh } from "../assembly/combine.ts";
import { meshBody, type MeshData } from "./mesh.ts";
import { Arena, T, bbox, explore, makeCompound, oc, setArena, volume, type TopoDS_Shape } from "./occ.ts";

const surfaceArea = (s: TopoDS_Shape) => {
  const o = oc();
  const props = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(s, props, false, false);
  const a = props.Mass();
  props.delete();
  return a;
};

/** Corpo sólido + corpos de superfície numa só forma (malha, exportação, análises). */
export function sceneOf(ctx: Ctx): { scene: NamedBody | null; owner: (name: string) => string } {
  const parts: [string, NamedBody][] = [...(ctx.body ? [["", ctx.body] as [string, NamedBody]] : []), ...ctx.sheets];
  const owners = new Map<string, string>();
  for (const [id, b] of parts) for (const f of b.faces) owners.set(f.name, id);
  const owner = (n: string) => owners.get(n) ?? "";
  const curves = [...ctx.curves.values()];
  if (!parts.length && !curves.length) return { scene: null, owner };
  if (parts.length === 1 && !curves.length) return { scene: parts[0][1], owner };
  return { scene: { shape: makeCompound([...parts.map(([, b]) => b.shape), ...curves.map((c) => c.shape)]), faces: parts.flatMap(([, b]) => b.faces) }, owner };
}
import { to3MF, toGLB, toOBJ } from "../io/mesh-export.ts";

export class KernelService {
  /** Um motor (com a sua cache) por peça do projeto. */
  private engines = new Map<string, Engine>();
  private lastMesh: MeshData | null = null;
  private lastScene: NamedBody | null = null;

  engineFor(id: string): Engine {
    let e = this.engines.get(id);
    if (!e) { e = new Engine(); this.engines.set(id, e); }
    return e;
  }

  /** Reconstrói; `force` descarta a cache (reconstrução completa, Ctrl+Q). */
  async rebuild(doc: CadDocument & { id?: string }, force = false): Promise<RebuildResponse> {
    const engine = this.engineFor(doc.id ?? "_");
    if (force) engine.clear();
    const r = await engine.rebuild(doc);
    const body = r.ctx.body;
    const { scene, owner } = sceneOf(r.ctx);
    const mesh = scene ? meshBody(scene, undefined, owner, [...r.ctx.curves.values()].flatMap((c) => c.edges)) : null;
    // cópia própria: o worker transfere os buffers da malha devolvida para a interface (ficam vazios aqui)
    this.lastMesh = mesh && { ...mesh, vertices: mesh.vertices.slice(), normals: mesh.normals.slice(), triangles: mesh.triangles.slice(), lines: mesh.lines.slice() };
    this.lastScene = scene;
    const sheets: SheetInfo[] = [...r.ctx.sheets].map(([id, b]) => {
      const s = new (oc().BRepBuilderAPI_Sewing)(1e-6, false, true, true, false);
      s.Add(b.shape);
      s.Perform();
      const freeEdges = s.NbFreeEdges();
      s.delete();
      return { id, faces: b.faces.length, area: surfaceArea(b.shape), freeEdges };
    });
    const sketches: Record<string, SketchView> = {};
    for (const [id, s] of r.ctx.sketches) {
      sketches[id] = {
        frame: s.frame, entities: s.entities, ok: s.solve.ok, dof: s.solve.dof,
        profiles: { errors: s.profiles.errors, regions: s.profiles.regions.length },
        regionList: s.regions.map((r) => ({ sig: r.sig, seed: r.seed, area: r.area, tris: r.tris })),
      };
    }
    let mass: MassProps | null = null;
    if (body) {
      const v = volume(body.shape);
      const area = surfaceArea(body.shape);
      mass = { volume: v.volume, area, center: v.center, bbox: bbox(body.shape), solids: explore(body.shape, "solid").length };
    }
    return {
      status: r.status,
      variables: r.variables,
      ms: r.ms,
      reused: r.reused,
      mesh,
      sketches,
      planes: Object.fromEntries(r.ctx.planes),
      axes: Object.fromEntries(r.ctx.axes),
      csys: Object.fromEntries(r.ctx.csys),
      mass,
      sheets,
    };
  }

  // --- montagens ---------------------------------------------------------------------

  private meshCache = new Map<string, { key: string; mesh: MeshData | null }>();
  private lastAsm: { project: CadProject; id: string } | null = null;
  private asmArena = new Arena();

  /** Peça reconstruída (cache do motor da peça) e a sua malha (cache por conteúdo). */
  async partBuild(project: CadProject, id: string): Promise<PartBuild> {
    const doc = project.parts.find((p) => p.id === id);
    if (!doc) throw new Error(`Peça ${id} inexistente`);
    const r = await this.engineFor(id).rebuild(doc);
    const key = JSON.stringify(doc);
    let cached = this.meshCache.get(id);
    if (!cached || cached.key !== key) {
      const { scene, owner } = sceneOf(r.ctx);
      cached = { key, mesh: scene ? meshBody(scene, undefined, owner) : null };
      this.meshCache.set(id, cached);
    }
    const body = r.ctx.body;
    const v = body ? volume(body.shape) : { volume: 0, center: [0, 0, 0] as Vec3 };
    return {
      ctx: r.ctx, mesh: cached.mesh, volume: v.volume, area: body ? surfaceArea(body.shape) : 0, center: v.center,
      bbox: body ? bbox(body.shape) : null, errors: Object.values(r.status).filter((x) => x.state === "error").length,
    };
  }

  async assembly(project: CadProject, id: string, force = false): Promise<AssemblyResponse> {
    const t0 = performance.now();
    if (force) for (const e of this.engines.values()) e.clear();
    const builds = new Map<string, PartBuild>();
    const get = async (pid: string) => {
      let b = builds.get(pid);
      if (!b) { b = await this.partBuild(project, pid); builds.set(pid, b); }
      return b;
    };
    const asm = await solveAssembly(project, id, get);
    this.lastAsm = { project, id };
    const parts: Record<string, MeshData> = {};
    const partMass: Record<string, { volume: number; area: number }> = {};
    const partErrors: Record<string, number> = {};
    for (const [pid, b] of builds) {
      // cópias: os buffers são transferidos para a interface
      if (b.mesh) parts[pid] = { ...b.mesh, vertices: b.mesh.vertices.slice(), normals: b.mesh.normals.slice(), triangles: b.mesh.triangles.slice(), lines: b.mesh.lines.slice() };
      partMass[pid] = { volume: b.volume, area: b.area };
      partErrors[pid] = b.errors;
    }
    // cena exportável: as peças nas posições resolvidas (STEP/STL/3MF/OBJ/GLB da montagem)
    this.asmArena.free();
    setArena(this.asmArena);
    const o = oc();
    const placed = asm.instances.flatMap((i) => {
      const body = builds.get(i.part)?.ctx.body;
      if (!body) return [];
      const t = T(new o.gp_Trsf());
      const R = i.pose.R, p = i.pose.t;
      t.SetValues(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2]);
      return [T(T(new o.BRepBuilderAPI_Transform(body.shape, t, true, false)).Shape())];
    });
    const instances = toInstances(asm);
    this.lastScene = placed.length ? { shape: makeCompound(placed), faces: [] } : null;
    this.lastMesh = assemblyMesh({ parts: Object.fromEntries([...builds].filter(([, b]) => b.mesh).map(([k, b]) => [k, b.mesh!])), instances } as never);
    return {
      ok: asm.ok, dof: asm.dof, messages: asm.messages, mates: asm.mates, parts, instances, partMass, partErrors,
      mass: assemblyMass(asm.instances, builds), ms: Math.round(performance.now() - t0),
    };
  }

  /** Deteção de interferências entre as peças da última montagem (volume comum > 0). */
  async interference(): Promise<InterferenceResponse> {
    if (!this.lastAsm) throw new Error("Não há montagem");
    const { project, id } = this.lastAsm;
    const builds = new Map<string, PartBuild>();
    const get = async (pid: string) => { let b = builds.get(pid); if (!b) { b = await this.partBuild(project, pid); builds.set(pid, b); } return b; };
    const asm = await solveAssembly(project, id, get);
    const arena = new Arena();
    setArena(arena);
    try {
      const o = oc();
      const placed = asm.instances.flatMap((i) => {
        const body = builds.get(i.part)?.ctx.body;
        if (!body) return [];
        const t = T(new o.gp_Trsf());
        const R = i.pose.R, p = i.pose.t;
        t.SetValues(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2]);
        const shape = T(T(new o.BRepBuilderAPI_Transform(body.shape, t, true, false)).Shape());
        return [{ path: i.path.join("/"), name: i.names.join(" / "), shape, box: bbox(shape) }];
      });
      const pairs: InterferenceResponse["pairs"] = [];
      const overlap = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }) => [0, 1, 2].every((k) => a.min[k] < b.max[k] && b.min[k] < a.max[k]);
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
        const A = placed[i], B = placed[j];
        if (!overlap(A.box, B.box)) continue;
        const c = T(new o.BRepAlgoAPI_Common(A.shape, B.shape));
        c.Build();
        if (!c.IsDone()) continue;
        const common = T(c.Shape());
        const vol = explore(common, "solid").length ? volume(common).volume : 0;
        if (vol > 1e-6) pairs.push({ a: A.path, b: B.path, volume: vol, mesh: meshBody(nameFresh(common, "int")) });
      }
      return { pairs };
    } finally {
      arena.free();
      setArena(this.asmArena);
    }
  }

  async drawing(project: CadProject, id: string, force = false): Promise<DrawingResponse> {
    return buildDrawing(this, project, id, force);
  }

  /** Desvio de tangência nas arestas entre faces. */
  deviation(): DeviationResponse {
    if (!this.lastScene) throw new Error("Não há modelo para analisar");
    return deviation(this.lastScene);
  }

  /** Curvatura em cada vértice da última malha. */
  curvature(kind: CurvatureKind): CurvatureResponse {
    if (!this.lastScene || !this.lastMesh) throw new Error("Não há modelo para analisar");
    return curvature(this.lastScene, this.lastMesh, kind);
  }

  async export(format: ExportFormat, name: string): Promise<ExportResponse> {
    const body = this.lastScene;
    if (!body || !this.lastMesh) throw new Error("Não há corpo para exportar");
    const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
    switch (format) {
      case "step": {
        const s = cast(body.shape);
        const data = await bytes(s.blobSTEP());
        return { data, mime: "application/step", ext: "step" };
      }
      case "stl": {
        const s = cast(body.shape);
        const data = await bytes(s.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 }));
        return { data, mime: "model/stl", ext: "stl" };
      }
      case "3mf": return { data: to3MF(this.lastMesh, name), mime: "model/3mf", ext: "3mf" };
      case "obj": return { data: new TextEncoder().encode(toOBJ(this.lastMesh, name)), mime: "model/obj", ext: "obj" };
      case "glb": return { data: toGLB(this.lastMesh), mime: "model/gltf-binary", ext: "glb" };
    }
  }
}
