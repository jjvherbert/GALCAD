// Serviço do núcleo: reconstrução, malhas e exportação. Usado pelo worker (e em testes).
import { cast } from "replicad";
import type { CurvatureKind, CurvatureResponse, ExportFormat, ExportResponse, MassProps, RebuildResponse, SheetInfo, SketchView } from "./protocol.ts";
import type { Ctx } from "./context.ts";
import type { NamedBody } from "./naming.ts";
import { curvature } from "./analysis.ts";
import type { CadDocument } from "../doc/types.ts";
import { Engine } from "./rebuild.ts";
import { meshBody, type MeshData } from "./mesh.ts";
import { bbox, explore, makeCompound, oc, volume, type TopoDS_Shape } from "./occ.ts";

const surfaceArea = (s: TopoDS_Shape) => {
  const o = oc();
  const props = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(s, props, false, false);
  const a = props.Mass();
  props.delete();
  return a;
};

/** Corpo sólido + corpos de superfície numa só forma (malha, exportação, análises). */
function sceneOf(ctx: Ctx): { scene: NamedBody | null; owner: (name: string) => string } {
  const parts: [string, NamedBody][] = [...(ctx.body ? [["", ctx.body] as [string, NamedBody]] : []), ...ctx.sheets];
  const owners = new Map<string, string>();
  for (const [id, b] of parts) for (const f of b.faces) owners.set(f.name, id);
  const owner = (n: string) => owners.get(n) ?? "";
  if (!parts.length) return { scene: null, owner };
  if (parts.length === 1) return { scene: parts[0][1], owner };
  return { scene: { shape: makeCompound(parts.map(([, b]) => b.shape)), faces: parts.flatMap(([, b]) => b.faces) }, owner };
}
import { to3MF, toGLB, toOBJ } from "../io/mesh-export.ts";

export class KernelService {
  private engine = new Engine();
  private lastMesh: MeshData | null = null;
  private lastScene: NamedBody | null = null;

  /** Reconstrói; `force` descarta a cache (reconstrução completa, Ctrl+Q). */
  async rebuild(doc: CadDocument, force = false): Promise<RebuildResponse> {
    if (force) this.engine.clear();
    const r = await this.engine.rebuild(doc);
    const body = r.ctx.body;
    const { scene, owner } = sceneOf(r.ctx);
    const mesh = scene ? meshBody(scene, undefined, owner) : null;
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
