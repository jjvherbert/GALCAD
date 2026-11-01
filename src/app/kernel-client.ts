// Cliente do worker do núcleo: pedidos com id e reconstruções coalescidas (só a mais recente conta).
// Um pedido que não responde dentro do limite, um erro do worker ou um cancelamento pelo utilizador
// reiniciam o worker: as promessas pendentes são rejeitadas e nada fica pendurado.
import type { CadDocument } from "../doc/types.ts";
import type { CadProject, PartDoc } from "../doc/project.ts";
import type {
  AssemblyResponse, CurvatureKind, CurvatureResponse, ContinuityResponse, CombsResponse, DeviationResponse, NormalsResponse, PanelsResponse, SnapshotResponse, StudyCaseResponse, DrawingResponse, ExportFormat, ExportResponse,
  InterferenceResponse, RebuildResponse, Request, Response, SignatureResponse,
} from "../kernel/protocol.ts";

type Waiter<T> = { resolve: (r: T | null) => void; reject: (e: Error) => void };
type Job = { req: Request; force: boolean; waiters: Waiter<unknown>[] };

/** O que o cliente usa de um Worker (permite um worker falso nos testes). */
export interface WorkerLike {
  onmessage: ((e: MessageEvent<Response>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
  terminate(): void;
}

/** Porque é que o worker foi reiniciado e que pedidos estavam em curso (perderam-se). */
export interface RestartInfo {
  why: string;
  during: Request["type"][];
  /** true quando foi o utilizador a cancelar. */
  aborted: boolean;
}

export interface KernelClientOptions {
  create?: () => WorkerLike;
  /** Limite sem resposta do worker, em ms, lido a cada pedido (as definições podem mudar). */
  timeoutMs?: () => number;
  onRestart?: (info: RestartInfo) => void;
  /** Chamado quando o worker passa de livre a ocupado e vice-versa. */
  onBusy?: (busy: boolean) => void;
}

// o padrão literal `new Worker(new URL(...), ...)` tem de ficar assim para o Vite empacotar o worker
const createWorker = (): WorkerLike => new Worker(new URL("../kernel/worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;

const DEFAULT_TIMEOUT_MS = 300_000;

/** Rejeição de um pedido perdido porque o worker foi reiniciado (falha, limite de tempo ou cancelamento). */
export class KernelRestartError extends Error {
  readonly aborted: boolean;
  constructor(message: string, aborted: boolean) {
    super(message);
    this.name = "KernelRestartError";
    this.aborted = aborted;
  }
}

export class KernelClient {
  private readonly create: () => WorkerLike;
  private readonly timeoutMs: () => number;
  private readonly onRestart?: (info: RestartInfo) => void;
  private readonly onBusy?: (busy: boolean) => void;
  private wasBusy = false;
  private worker!: WorkerLike;
  private seq = 0;
  private pending = new Map<number, { type: Request["type"]; resolve: (v: never) => void; reject: (e: Error) => void }>();
  private inFlight = false;
  /** Um pedido de reconstrução em espera (peça, montagem ou desenho): o mais recente substitui os outros. */
  private queued: Job | null = null;
  /** Vigia: corre enquanto há pedidos pendentes e recomeça a cada resposta (o worker trata um pedido de cada vez). */
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Quantas vezes o worker foi reiniciado (diagnóstico e testes). */
  restarts = 0;

  constructor(opts: KernelClientOptions = {}) {
    this.create = opts.create ?? createWorker;
    this.timeoutMs = opts.timeoutMs ?? (() => DEFAULT_TIMEOUT_MS);
    this.onRestart = opts.onRestart;
    this.onBusy = opts.onBusy;
    this.spawn();
  }

  /** true enquanto o worker tem pedidos por responder. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  private notifyBusy() {
    if (this.busy === this.wasBusy) return;
    this.wasBusy = this.busy;
    this.onBusy?.(this.wasBusy);
  }

  private spawn() {
    const w = this.create();
    this.worker = w;
    w.onmessage = ({ data }: MessageEvent<Response>) => {
      if (w !== this.worker) return; // resposta tardia de um worker já substituído
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      this.arm(true);
      this.notifyBusy();
      if (data.ok) p.resolve(data.result as never);
      else p.reject(new Error(data.error));
    };
    // um aborto do WASM deixa o worker morto ou num estado inválido: recomeça-se com um worker novo
    w.onerror = (e) => { e.preventDefault(); if (w === this.worker) this.restart(e.message || "o worker terminou com erro"); };
    w.onmessageerror = () => { if (w === this.worker) this.restart("mensagem do worker ilegível"); };
  }

  /** Arma a vigia se houver pedidos pendentes; `reset` recomeça a contagem (houve resposta). */
  private arm(reset = false) {
    if (reset && this.watchdog !== undefined) { clearTimeout(this.watchdog); this.watchdog = undefined; }
    if (this.watchdog !== undefined || this.pending.size === 0) return;
    const ms = this.timeoutMs();
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      this.restart(`sem resposta há ${Math.round(ms / 1000)} s; o núcleo foi reiniciado`);
    }, ms);
  }

  private restart(why: string, aborted = false) {
    if (this.watchdog !== undefined) { clearTimeout(this.watchdog); this.watchdog = undefined; }
    const lost = [...this.pending.values()];
    this.pending.clear();
    try { this.worker.terminate(); } catch { /* já morto */ }
    this.restarts++;
    this.spawn();
    if (!aborted) console.error(`Núcleo: ${why}`);
    for (const p of lost) p.reject(new KernelRestartError(`Núcleo: ${why}`, aborted));
    this.notifyBusy();
    this.onRestart?.({ why, during: lost.map((p) => p.type), aborted });
  }

  /**
   * Cancela o que o núcleo está a fazer (reconstrução longa, exportação…): reinicia o worker e
   * rejeita os pedidos em curso. Uma reconstrução em espera corre a seguir no worker novo.
   * Devolve false se não havia nada a cancelar.
   */
  abort(): boolean {
    if (this.pending.size === 0) return false;
    this.restart("cancelado pelo utilizador", true);
    return true;
  }

  private call<T>(req: Request): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { type: req.type, resolve: resolve as (v: never) => void, reject });
      this.arm();
      this.notifyBusy();
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

  studyCase(doc: PartDoc, parts: PartDoc[], study: string): Promise<StudyCaseResponse> {
    return this.call<StudyCaseResponse>({ type: "studyCase", doc, parts, study });
  }

  panels(doc: PartDoc, parts: PartDoc[], faces: string[]): Promise<PanelsResponse> {
    return this.call<PanelsResponse>({ type: "panels", doc, parts, faces });
  }

  assemblyStudyCase(project: CadProject, assembly: string, study: string): Promise<StudyCaseResponse> {
    return this.call<StudyCaseResponse>({ type: "assemblyStudyCase", project, assembly, study });
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

  normals(): Promise<NormalsResponse> {
    return this.call<NormalsResponse>({ type: "normals" });
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
