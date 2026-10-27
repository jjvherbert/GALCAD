// Serviço do núcleo: reconstrução, malhas e exportação. Usado pelo worker (e em testes).
import { cast } from "replicad";
import type { ExportFormat, ExportResponse, MassProps, RebuildResponse, SketchView } from "./protocol.ts";
import type { CadDocument } from "../doc/types.ts";
import { Engine, type RebuildResult } from "./rebuild.ts";
import { meshBody, type MeshData } from "./mesh.ts";
import { bbox, explore, oc, volume } from "./occ.ts";
import { to3MF, toGLB, toOBJ } from "../io/mesh-export.ts";

export class KernelService {
  private engine = new Engine();
  private last: RebuildResult | null = null;
  private lastMesh: MeshData | null = null;

  /** Reconstrói; `force` descarta a cache (reconstrução completa, Ctrl+Q). */
  async rebuild(doc: CadDocument, force = false): Promise<RebuildResponse> {
    if (force) this.engine.clear();
    const r = await this.engine.rebuild(doc);
    this.last = r;
    const body = r.ctx.body;
    const mesh = body ? meshBody(body) : null;
    this.lastMesh = mesh;
    const sketches: Record<string, SketchView> = {};
    for (const [id, s] of r.ctx.sketches) {
      sketches[id] = { frame: s.frame, entities: s.entities, ok: s.solve.ok, dof: s.solve.dof, profiles: { errors: s.profiles.errors, regions: s.profiles.regions.length } };
    }
    let mass: MassProps | null = null;
    if (body) {
      const v = volume(body.shape);
      const o = oc();
      const props = new o.GProp_GProps();
      o.BRepGProp.SurfaceProperties(body.shape, props, false, false);
      const area = props.Mass();
      props.delete();
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
    };
  }

  async export(format: ExportFormat, name: string): Promise<ExportResponse> {
    const body = this.last?.ctx.body;
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
