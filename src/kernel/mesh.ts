// Malha de visualização do corpo, com cada grupo de triângulos/linhas ligado ao nome topológico.
import { cast } from "replicad";
import type { Vec3 } from "../doc/types.ts";
import { type NamedBody, namedEdges } from "./naming.ts";
import { edgeProps, faceProps, hash, v3 } from "./occ.ts";

export interface FaceGroup {
  start: number; // índice no array de triângulos (em índices, não triângulos)
  count: number;
  name: string;
  type: string;
  center: Vec3;
  normal?: Vec3;
}

export interface EdgeGroup {
  start: number; // índice no array de linhas (em vértices)
  count: number;
  name: string;
  mid: Vec3;
  dir?: Vec3;
  type: string;
}

export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  faces: FaceGroup[];
  lines: Float32Array;
  edges: EdgeGroup[];
}

const r4 = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e4) / 1e4) as Vec3;

export function meshBody(body: NamedBody, tolerance?: number): MeshData {
  const shape = cast(body.shape);
  const { min, max } = (() => {
    const b = shape.boundingBox;
    return { min: b.bounds[0] as Vec3, max: b.bounds[1] as Vec3 };
  })();
  const size = Math.max(1, v3.dist(min, max));
  const tol = tolerance ?? size * 2e-4;
  const m = shape.mesh({ tolerance: tol, angularTolerance: 0.25 });
  const e = shape.meshEdges({ tolerance: tol, angularTolerance: 0.25 });

  const faceByHash = new Map<number, (typeof body.faces)[number][]>();
  for (const f of body.faces) faceByHash.set(hash(f.face), [...(faceByHash.get(hash(f.face)) ?? []), f]);
  const faces: FaceGroup[] = m.faceGroups.map((g) => {
    const nf = faceByHash.get(g.faceId)?.[0];
    const p = nf ? faceProps(nf.face) : undefined;
    return { start: g.start, count: g.count, name: nf?.name ?? "?", type: p?.type ?? "?", center: r4(p?.center ?? [0, 0, 0]), normal: p?.normal && r4(p.normal) };
  });

  const edgeByHash = new Map<number, ReturnType<typeof namedEdges>[number]>();
  for (const ne of namedEdges(body)) edgeByHash.set(hash(ne.edge), ne);
  const edges: EdgeGroup[] = e.edgeGroups.map((g) => {
    const ne = edgeByHash.get(g.edgeId);
    const p = ne ? edgeProps(ne.edge) : undefined;
    return { start: g.start, count: g.count, name: ne?.name ?? "?", mid: r4(p?.mid ?? [0, 0, 0]), dir: p?.dir && r4(p.dir), type: p?.type ?? "?" };
  });
  shape.delete();
  return {
    vertices: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    triangles: Uint32Array.from(m.triangles),
    faces,
    lines: Float32Array.from(e.lines),
    edges,
  };
}
