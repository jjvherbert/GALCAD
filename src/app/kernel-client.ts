// Cliente do worker do núcleo: pedidos com id e reconstruções coalescidas (só a mais recente conta).
import type { CadDocument } from "../doc/types.ts";
import type { CadProject, PartDoc } from "../doc/project.ts";
import type {
  AssemblyResponse, CurvatureKind, CurvatureResponse, ContinuityResponse, CombsResponse, DeviationResponse, SnapshotResponse, DrawingResponse, ExportFormat, ExportResponse,
  InterferenceResponse, RebuildResponse, Request, Response, SignatureResponse,
} from "../kernel/protocol.ts";

type Waiter<T> = { resolve: (r: T | null) => void; reject: (e: Error) => void };
type Job = { req: Request; force: boolean; waiters: Waiter<unknown>[] };

export class KernelClient {
  private worker = new Worker(new URL("../kernel/worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private inFlight = false;
  /** Um pedido de reconstrução em espera (peça, montagem ou desenho): o mais recente substitui os outros. */
  private queued: Job | null = null;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<Response>) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok) p.resolve(data.result as never);
      else p.reject(new Error(data.error));
    };
  }

  private call<T>(req: Request): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  /**
   * Reconstrução coalescida: se já houver uma em curso, este pedido fica em espera e substitui
   * qualquer outro em espera; os pedidos substituídos resolvem com null.
   */
  private coalesce<T>(req: Request, force: boolean): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const keepForce = !!this.queued?.force;
      if (this.queued) for (const w of this.queued.waiters) w.resolve(null);
      this.queued = { req: { ...req, force: force || keepForce } as Request, force: force || keepForce, waiters: [{ resolve: resolve as (r: unknown) => void, reject }] };
      void this.pump();
    });
  }

  private async pump() {
    if (this.inFlight || !this.queued) return;
    const job = this.queued;
    this.queued = null;
    this.inFlight = true;
    try {
      const r = await this.call<unknown>(job.req);
      for (const w of job.waiters) w.resolve(this.queued ? null : r);
    } catch (e) {
      for (const w of job.waiters) w.reject(e as Error);
    } finally {
      this.inFlight = false;
      void this.pump();
    }
  }

  rebuild(doc: CadDocument, force = false, parts: PartDoc[] = []): Promise<RebuildResponse | null> {
    return this.coalesce<RebuildResponse>({ type: "rebuild", doc, parts }, force);
  }

  snapshot(doc: PartDoc, parts: PartDoc[], feature: string): Promise<SnapshotResponse> {
    return this.call<SnapshotResponse>({ type: "snapshot", doc, parts, feature });
  }

  assembly(project: CadProject, id: string, force = false): Promise<AssemblyResponse | null> {
    return this.coalesce<AssemblyResponse>({ type: "assembly", project, asmId: id }, force);
  }

  drawing(project: CadProject, id: string, force = false): Promise<DrawingResponse | null> {
    return this.coalesce<DrawingResponse>({ type: "drawing", project, drawingId: id }, force);
  }

  signatures(project: CadProject): Promise<SignatureResponse> {
    return this.call<SignatureResponse>({ type: "signatures", project });
  }

  interference(): Promise<InterferenceResponse> {
    return this.call<InterferenceResponse>({ type: "interference" });
  }

  export(format: ExportFormat, name: string): Promise<ExportResponse> {
    return this.call<ExportResponse>({ type: "export", format, name });
  }

  continuity(): Promise<ContinuityResponse> {
    return this.call<ContinuityResponse>({ type: "continuity" });
  }

  combs(edges?: string[]): Promise<CombsResponse> {
    return this.call<CombsResponse>({ type: "combs", edges });
  }

  deviation(): Promise<DeviationResponse> {
    return this.call<DeviationResponse>({ type: "deviation" });
  }

  curvature(kind: CurvatureKind): Promise<CurvatureResponse> {
    return this.call<CurvatureResponse>({ type: "curvature", kind });
  }
}
