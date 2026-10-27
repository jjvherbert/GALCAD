// Desenhos 2D no núcleo (vistas por HLR) — implementado na etapa seguinte.
import type { CadProject } from "../doc/project.ts";
import type { DrawingResponse } from "./protocol.ts";
import type { KernelService } from "./service.ts";

export async function buildDrawing(_svc: KernelService, _project: CadProject, _id: string, _force: boolean): Promise<DrawingResponse> {
  return { views: {}, sources: {}, ms: 0 };
}
