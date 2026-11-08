// Serviço do núcleo: reconstrução, malhas e exportação. Usado pelo worker (e em testes).
import { cast } from "replicad";
import type { AssemblyInstance, AssemblyResponse, NormalsResponse, PanelsResponse, SnapshotResponse, StudyCaseResponse, CombsResponse, ContinuityResponse, CurvatureKind, CurvatureResponse, DeviationResponse, DrawingResponse, ExportFormat, InterferenceResponse, SignatureResponse, ExportResponse, MassProps, RebuildResponse, SheetInfo, SketchView } from "./protocol.ts";
import type { Ctx } from "./context.ts";
import type { NamedBody } from "./naming.ts";
import { combs, continuity, curvature, deviation, exactNormals } from "./analysis.ts";
import type { NamedEdge } from "./naming.ts";
import type { CadDocument } from "../doc/types.ts";
import { Engine } from "./rebuild.ts";
import type { CadProject, PartProperties } from "../doc/project.ts";
import { DEFAULT_DENSITY } from "../doc/types.ts";
import { resolveVariables } from "../doc/variables.ts";
import { configuredDoc, runChecks, splitPartKey } from "../doc/knowledge.ts";
import type { PartDoc } from "../doc/project.ts";
import type { BuildEnv } from "./context.ts";
import { freezeGeom, publish } from "./features/external.ts";
import { type AsmBody, assemblyStudyCase, singleSolid, studyCase } from "./sim.ts";
import { pmiStates } from "./pmi.ts";
import { panelGeometry } from "./panels.ts";

import type { Vec3 } from "../doc/types.ts";
import { type PartBuild, assemblyMass, solveAssembly, toInstances } from "./assembly.ts";
import { buildDrawing } from "./drawing.ts";
import { partSignature } from "./signature.ts";
import { assemblyMesh } from "../assembly/combine.ts";
import { meshBody, type MeshData } from "./mesh.ts";
import { Arena, T, bbox, explore, makeCompound, oc, setArena, volume } from "./occ.ts";


import { to3MF, toGLB, toOBJ } from "../io/mesh-export.ts";
import { hashText, sceneOf, surfaceArea } from "./service-scene.ts";
export { sceneOf };
import { step242 as buildStep242 } from "./service-step.ts";
import { interference as detectInterference } from "./service-interference.ts";

export class KernelService {
  /** Um motor (com a sua cache) por peça do projeto. */
  private engines = new Map<string, Engine>();
  private lastMesh: MeshData | null = null;
  private lastScene: NamedBody | null = null;
  private lastCurves: NamedEdge[] = [];
  private lastKind: "part" | "assembly" = "part";
  private lastPart: { doc: CadDocument & { properties?: PartProperties }; ctx: Ctx } | null = null;
  private lastAsmInstances: AssemblyInstance[] = [];

  engineFor(id: string): Engine {
    let e = this.engines.get(id);
    if (!e) { e = new Engine(); this.engines.set(id, e); }
    return e;
  }

  /** Reconstrói; `force` descarta a cache (reconstrução completa, Ctrl+Q). */
  /**
   * Ambiente de reconstrução de uma peça dentro de um projeto: as referências externas pedem as
   * publicações das outras peças (reconstruídas com a sua cache), com deteção de ciclos.
   */
  envFor(project: { parts: PartDoc[] }, stack: string[]): BuildEnv {
    const name = (id: string) => project.parts.find((p) => p.id === id)?.name ?? id;
    const linkedRefs = (id: string) => [...new Set((project.parts.find((x) => x.id === id)?.features ?? [])
      .filter((f) => f.type === "external" && f.mode === "linked" && !f.suppressed).map((f) => (f as { part: string }).part))];
    /** Caminho de `from` até uma peça da pilha, pelas referências ligadas (ou null). */
    const cycleFrom = (from: string, stk: string[], seen = new Set<string>()): string[] | null => {
      if (seen.has(from)) return null;
      seen.add(from);
      for (const next of linkedRefs(from)) {
        if (stk.includes(next)) return [from, next];
        const rest = cycleFrom(next, stk, seen);
        if (rest) return [from, ...rest];
      }
      return null;
    };
    const revs = new Map<string, string>();
    const revision = (id: string, seen = new Set<string>()): string => {
      const hit = revs.get(id);
      if (hit) return hit;
      const p = project.parts.find((x) => x.id === id);
      if (!p) return "inexistente";
      if (seen.has(id)) return "ciclo";
      seen.add(id);
      const refs = [...new Set(p.features.filter((f) => f.type === "external" && f.mode === "linked").map((f) => (f as { part: string }).part))];
      const r = hashText(JSON.stringify(p) + refs.map((x) => revision(x, seen)).join("|"));
      revs.set(id, r);
      return r;
    };
    return {
      partName: name,
      revision,
      external: async (part, pubName) => {
        if (stack.includes(part)) throw new Error(`Referência externa circular: ${[...stack, part].map(name).join(" → ")}`);
        // ciclo indireto (a origem, ou uma peça de que ela depende, volta a uma peça da pilha)
        const loop = cycleFrom(part, stack);
        if (loop) throw new Error(`Referência externa circular: ${[...stack, ...loop].map(name).join(" → ")}`);
        const p = project.parts.find((x) => x.id === part);
        if (!p) throw new Error("A peça de origem não existe no projeto");
        const pub = configuredDoc(p).publications?.find((x) => x.name === pubName);
        if (!pub) throw new Error(`A peça "${p.name}" não publica "${pubName}"`);
        const b = await this.partBuild(project as CadProject, part, stack);
        return publish(b.ctx, pub);
      },
    };
  }

  async rebuild(input: CadDocument & { id?: string; properties?: PartProperties }, force = false, parts: PartDoc[] = []): Promise<RebuildResponse> {
    // configuração ativa da tabela de configurações (variáveis, supressões, propriedades)
    const doc = configuredDoc(input);
    const engine = this.engineFor(doc.id ?? "_");
    if (force) engine.clear();
    const project = { parts: [...parts.filter((p) => p.id !== doc.id), doc as PartDoc] };
    const r = await engine.rebuild(doc, this.envFor(project, [doc.id ?? "_"]));
    const body = r.ctx.body;
    const { scene, owner } = sceneOf(r.ctx);
    const mesh = scene ? meshBody(scene, undefined, owner, [...r.ctx.curves.values()].flatMap((c) => c.edges)) : null;
    // cópia própria: o worker transfere os buffers da malha devolvida para a interface (ficam vazios aqui)
    this.lastMesh = mesh && { ...mesh, vertices: mesh.vertices.slice(), normals: mesh.normals.slice(), triangles: mesh.triangles.slice(), lines: mesh.lines.slice() };
    this.lastScene = scene;
    this.lastPart = { doc, ctx: r.ctx };
    this.lastKind = "part";
    this.lastCurves = [...r.ctx.curves.values()].flatMap((c) => c.edges);
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
    // verificações: variáveis + medidas do modelo (massa com a massa volúmica da configuração)
    const density = doc.properties?.density ?? DEFAULT_DENSITY;
    const measures: Record<string, number> = mass ? {
      volume: mass.volume, area: mass.area, massa: (mass.volume / 1000) * density,
      dimX: mass.bbox.max[0] - mass.bbox.min[0], dimY: mass.bbox.max[1] - mass.bbox.min[1], dimZ: mass.bbox.max[2] - mass.bbox.min[2],
    } : {};
    const checks = doc.checks?.length ? runChecks(doc.checks, (n) => r.variables.values[n] ?? measures[n]) : undefined;
    const pmi = doc.pmi?.length ? pmiStates(r.ctx, doc.pmi) : undefined;
    return {
      pmi,
      status: r.status,
      variables: r.variables,
      rules: r.rules.length ? r.rules : undefined,
      checks,
      config: doc.configurations?.active,
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
  /** Objetos das vistas do último desenho (libertados no desenho seguinte). */
  readonly drawingArena = new Arena();

  /** Peça reconstruída (cache do motor da peça) e a sua malha (cache por conteúdo). */
  async partBuild(project: CadProject, key: string, stack: string[] = []): Promise<PartBuild> {
    // "p1#Longa": a peça p1 na configuração "Longa" (motor e malha próprios por configuração)
    const { id, config } = splitPartKey(key);
    const base = project.parts.find((p) => p.id === id);
    if (!base) throw new Error(`Peça ${id} inexistente`);
    if (config && !base.configurations?.rows.some((r) => r.name === config)) throw new Error(`A peça "${base.name}" não tem a configuração "${config}"`);
    const doc = configuredDoc(base, config ?? base.configurations?.active);
    const r = await this.engineFor(key).rebuild(doc, this.envFor(project, [...stack, id]));
    const id_ = key;
    const ckey = JSON.stringify(doc);
    let cached = this.meshCache.get(id_);
    if (!cached || cached.key !== ckey) {
      const { scene, owner } = sceneOf(r.ctx);
      cached = { key: ckey, mesh: scene ? meshBody(scene, undefined, owner) : null };
      this.meshCache.set(id_, cached);
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
    this.lastAsmInstances = instances;
    this.lastKind = "assembly";
    this.lastScene = placed.length ? { shape: makeCompound(placed), faces: [] } : null;
    this.lastMesh = assemblyMesh({ parts: Object.fromEntries([...builds].filter(([, b]) => b.mesh).map(([k, b]) => [k, b.mesh!])), instances } as never);
    return {
      ok: asm.ok, dof: asm.dof, messages: asm.messages, mates: asm.mates, parts, instances, partMass, partErrors,
      mass: assemblyMass(asm.instances, builds), ms: Math.round(performance.now() - t0),
    };
  }

  /** Deteção de interferências entre as peças da última montagem (volume comum > 0). */
  interference(): Promise<InterferenceResponse> {
    return detectInterference(this.lastAsm, (p, k) => this.partBuild(p, k), () => setArena(this.asmArena));
  }

  /** Assinaturas geométricas de todas as peças (assistente de BOM). */
  async signatures(project: CadProject): Promise<SignatureResponse> {
    const parts: SignatureResponse["parts"] = {};
    for (const p of project.parts) {
      try {
        const b = await this.partBuild(project, p.id);
        setArena(this.asmArena);
        parts[p.id] = b.ctx.body ? partSignature(b.ctx.body, b.area) : { error: "Sem corpo sólido" };
      } catch (e) {
        parts[p.id] = { error: (e as Error).message };
      }
    }
    return { parts };
  }

  async drawing(project: CadProject, id: string, force = false): Promise<DrawingResponse> {
    return buildDrawing(this, project, id, force);
  }

  /** Desvio de tangência nas arestas entre faces. */
  deviation(): DeviationResponse {
    if (!this.lastScene) throw new Error("Não há modelo para analisar");
    return deviation(this.lastScene);
  }

  /** Cópia congelada de uma referência externa (geometria atual da publicação e revisão da origem). */
  async snapshot(doc: PartDoc, parts: PartDoc[], fid: string): Promise<SnapshotResponse> {
    const f = doc.features.find((x) => x.id === fid);
    if (!f || f.type !== "external") throw new Error("Referência externa inexistente");
    const env = this.envFor({ parts: [...parts.filter((p) => p.id !== doc.id), doc] }, [doc.id]);
    const arena = new Arena();
    setArena(arena);
    try {
      const g = await env.external(f.part, f.publication);
      return { revision: env.revision(f.part), ...freezeGeom(g) };
    } finally {
      setArena(this.asmArena);
      arena.free();
    }
  }

  private step242(): Promise<Uint8Array> {
    return buildStep242({ kind: this.lastKind, part: this.lastPart, asm: this.lastAsm, instances: this.lastAsmInstances }, (p, k) => this.partBuild(p, k), () => setArena(this.asmArena));
  }

  /** Caso de simulação de um estudo (a peça é reconstruída com a cache, na configuração ativa). */
  async studyCase(input: PartDoc, parts: PartDoc[], studyId: string): Promise<StudyCaseResponse> {
    const doc = configuredDoc(input);
    const study = doc.studies?.find((s) => s.id === studyId);
    if (!study) throw new Error("Estudo inexistente");
    const r = await this.engineFor(doc.id).rebuild(doc, this.envFor({ parts: [...parts.filter((p) => p.id !== doc.id), doc] }, [doc.id]));
    const out = studyCase(r.ctx, study);
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.files)) files[k] = typeof v === "string" ? v : new TextDecoder().decode(v);
    return { case: out.case, files, warnings: out.warnings };
  }

  /** Geometria de painéis (escantilhonamento): dimensões, flecha, centro e normal das faces pedidas. */
  async panels(input: PartDoc, parts: PartDoc[], faces: string[]): Promise<PanelsResponse> {
    const doc = configuredDoc(input);
    const r = await this.engineFor(doc.id).rebuild(doc, this.envFor({ parts: [...parts.filter((p) => p.id !== doc.id), doc] }, [doc.id]));
    const arena = new Arena();
    setArena(arena);
    try {
      return { panels: panelGeometry(r.ctx, faces) };
    } finally {
      arena.free();
      setArena(this.asmArena);
    }
  }

  /**
   * Caso de simulação de um estudo da montagem: resolve os mates, posiciona o sólido de cada
   * instância e junta-os num composto (um volume por corpo), com o contacto colado detetado.
   */
  async assemblyStudyCase(project: CadProject, id: string, studyId: string): Promise<StudyCaseResponse> {
    const asmDoc = project.assemblies.find((a) => a.id === id);
    if (!asmDoc) throw new Error("Montagem inexistente");
    const study = asmDoc.studies?.find((s) => s.id === studyId);
    if (!study) throw new Error("Estudo inexistente");
    const builds = new Map<string, PartBuild>();
    const get = async (pid: string) => { let b = builds.get(pid); if (!b) { b = await this.partBuild(project, pid); builds.set(pid, b); } return b; };
    const asm = await solveAssembly(project, id, get);
    if (!asm.ok) throw new Error(`A montagem não está resolvida: ${asm.messages.join("; ")}`);
    const arena = new Arena();
    setArena(arena);
    try {
      const o = oc();
      const bodies: AsmBody[] = asm.instances.flatMap((i) => {
        const b = builds.get(i.part);
        if (!b?.ctx.body) return [];
        const solid = singleSolid(b.ctx);
        const t = T(new o.gp_Trsf());
        const R = i.pose.R, p = i.pose.t;
        t.SetValues(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2]);
        return [{ path: i.path.join("/"), name: i.names.join(" / "), ctx: b.ctx, solid, placed: T(T(new o.BRepBuilderAPI_Transform(solid, t, true, false)).Shape()) }];
      });
      const out = assemblyStudyCase(bodies, study, resolveVariables(asmDoc.variables ?? []).scope, study.name);
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(out.files)) files[k] = typeof v === "string" ? v : new TextDecoder().decode(v);
      return { case: out.case, files, warnings: out.warnings };
    } finally {
      arena.free();
      setArena(this.asmArena);
    }
  }

  /** Normais exatas por vértice da última malha. */
  normals(): NormalsResponse {
    if (!this.lastScene || !this.lastMesh) throw new Error("Não há modelo para analisar");
    return { normals: exactNormals(this.lastScene, this.lastMesh) };
  }

  /** Continuidade G0–G3 nas arestas entre faces (classe A). */
  continuity(): ContinuityResponse {
    if (!this.lastScene) throw new Error("Não há modelo para analisar");
    return continuity(this.lastScene);
  }

  /** Pentes de curvatura (porcupine) das arestas escolhidas, ou de todas as arestas curvas e curvas 3D. */
  combs(edges?: string[]): CombsResponse {
    if (!this.lastScene && !this.lastCurves.length) throw new Error("Não há modelo para analisar");
    return combs(this.lastScene, this.lastCurves, edges);
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
      case "step242": return { data: await this.step242(), mime: "application/step", ext: "step" };
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
