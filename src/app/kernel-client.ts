// Cliente do worker do núcleo: pedidos com id e reconstruções coalescidas (só a mais recente conta).
import type { CadDocument } from "../doc/types.ts";
import type { ExportFormat, ExportResponse, RebuildResponse, Request, Response } from "../kernel/protocol.ts";

export class KernelClient {
  private worker = new Worker(new URL("../kernel/worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private inFlight = false;
  private queued: { doc: CadDocument; waiters: { resolve: (r: RebuildResponse | null) => void; reject: (e: Error) => void }[] } | null = null;

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
   * Reconstrói o documento. Se já houver uma reconstrução em curso, este pedido fica em espera
   * e substitui qualquer outro em espera; os pedidos substituídos resolvem com null.
   */
  rebuild(doc: CadDocument): Promise<RebuildResponse | null> {
    return new Promise((resolve, reject) => {
      if (this.queued) {
        for (const w of this.queued.waiters) w.resolve(null);
        this.queued = { doc, waiters: [{ resolve, reject }] };
      } else {
        this.queued = { doc, waiters: [{ resolve, reject }] };
      }
      void this.pump();
    });
  }

  private async pump() {
    if (this.inFlight || !this.queued) return;
    const job = this.queued;
    this.queued = null;
    this.inFlight = true;
    try {
      const r = await this.call<RebuildResponse>({ type: "rebuild", doc: job.doc });
      for (const w of job.waiters) w.resolve(this.queued ? null : r);
    } catch (e) {
      for (const w of job.waiters) w.reject(e as Error);
    } finally {
      this.inFlight = false;
      void this.pump();
    }
  }

  export(format: ExportFormat, name: string): Promise<ExportResponse> {
    return this.call<ExportResponse>({ type: "export", format, name });
  }
}
