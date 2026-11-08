// Mapa de handlers do worker do núcleo: um por tipo de pedido, cada um devolve o resultado e os
// buffers a transferir (sem cópia) para a interface. Sem imports de WASM, para se poder testar.
import type { KernelService } from "./service.ts";
import type { MeshData } from "./mesh.ts";
import type { RequestOf, RequestType, ResponseMap } from "./protocol.ts";

export interface Handled<K extends RequestType> {
  result: ResponseMap[K];
  transfer: Transferable[];
}

/** Um tipo de pedido sem handler é erro de compilação. */
export type Handlers = { [K in RequestType]: (req: RequestOf<K>) => Promise<Handled<K>> };

/** Os métodos do serviço que os handlers usam (o teste passa um serviço falso). */
export type HandlerService = Pick<KernelService, RequestType>;

export const meshBuffers = (m: MeshData): ArrayBuffer[] =>
  [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.lines.buffer] as ArrayBuffer[];

const none = <K extends RequestType>(result: ResponseMap[K]): Handled<K> => ({ result, transfer: [] });

export function makeHandlers(s: HandlerService): Handlers {
  return {
    rebuild: async (r) => {
      const result = await s.rebuild(r.doc, r.force, r.parts);
      return { result, transfer: result.mesh ? meshBuffers(result.mesh) : [] };
    },
    snapshot: async (r) => none(await s.snapshot(r.doc, r.parts, r.feature)),
    studyCase: async (r) => none(await s.studyCase(r.doc, r.parts, r.study)),
    meshSeeds: async (r) => none(await s.meshSeeds(r.doc, r.parts, r.study)),
    panels: async (r) => none(await s.panels(r.doc, r.parts, r.faces)),
    assemblyStudyCase: async (r) => none(await s.assemblyStudyCase(r.project, r.assembly, r.study)),
    curvature: async (r) => {
      const result = s.curvature(r.kind);
      return { result, transfer: [result.values.buffer as ArrayBuffer] };
    },
    deviation: async () => none(s.deviation()),
    continuity: async () => none(s.continuity()),
    normals: async () => {
      const result = s.normals();
      return { result, transfer: [result.normals.buffer as ArrayBuffer] };
    },
    combs: async (r) => none(s.combs(r.edges)),
    assembly: async (r) => {
      const result = await s.assembly(r.project, r.asmId, r.force);
      return { result, transfer: Object.values(result.parts).flatMap(meshBuffers) };
    },
    interference: async () => {
      const result = await s.interference();
      return { result, transfer: result.pairs.flatMap((p) => meshBuffers(p.mesh)) };
    },
    drawing: async (r) => none(await s.drawing(r.project, r.drawingId, r.force)),
    signatures: async (r) => none(await s.signatures(r.project)),
    export: async (r) => {
      const result = await s.export(r.format, r.name);
      return { result, transfer: [result.data.buffer as ArrayBuffer] };
    },
  };
}

/**
 * Corre o handler do pedido. A lista de transferência sai sem repetidos (um buffer repetido faz o
 * `postMessage` falhar com DataCloneError).
 */
export async function handle(handlers: Handlers, req: RequestOf<RequestType>): Promise<Handled<RequestType>> {
  const h = handlers[req.type] as (r: typeof req) => Promise<Handled<RequestType>>;
  const { result, transfer } = await h(req);
  return { result, transfer: [...new Set(transfer)] };
}
