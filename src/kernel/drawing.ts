// Desenhos 2D no núcleo: projeções com remoção de linhas ocultas (HLR do OpenCASCADE), cortes,
// pormenores, vistas auxiliares, marcas e linhas de centro, e as cotas dos esboços (importar cotas
// do modelo). As coordenadas das vistas estão em mm do modelo; a escala aplica-se ao desenhar a folha.
import { type CadProject, type DrawingDoc, type DrawingView } from "../doc/project.ts";
import { type DrawingResponse, type ViewResult } from "./protocol.ts";
import { type KernelService } from "./service.ts";
import { setArena } from "./occ.ts";
import { type Source, stdFrame, projectedFrame, failed } from "./drawing-common.ts";
import { viewFromShape } from "./drawing-view.ts";
import { sourceOf } from "./drawing-source.ts";
import { sectionView, detailView, auxiliaryView } from "./drawing-derived.ts";

export { projectedFrame, stdFrame } from "./drawing-common.ts";

const sheetScale = (d: DrawingDoc) => d.sheet.scale[0] / d.sheet.scale[1];

export async function buildDrawing(svc: KernelService, project: CadProject, id: string, _force: boolean): Promise<DrawingResponse> {
  const t0 = performance.now();
  const d = project.drawings.find((x) => x.id === id);
  if (!d) throw new Error(`Desenho ${id} inexistente`);
  const arena = svc.drawingArena;
  arena.free();
  const sources = new Map<string, Source>();
  const srcKey = (s: { kind: string; id: string }) => `${s.kind}:${s.id}`;
  const out: Record<string, ViewResult> = {};
  const srcInfo: DrawingResponse["sources"] = {};
  // primeiro reconstruir as fontes (cada peça usa a arena do seu motor), depois as vistas na arena do desenho
  for (const v of d.views) {
    if (v.kind !== "model") continue;
    const k = srcKey(v.source);
    if (sources.has(k)) continue;
    try {
      const s = await sourceOf(svc, project, v.source);
      sources.set(k, s);
      srcInfo[v.source.id] = { volume: s.volume, material: s.material };
    } catch (e) {
      out[v.id] = failed((e as Error).message);
    }
  }
  setArena(arena);
  const byId = new Map(d.views.map((v) => [v.id, v]));
  const rootSource = (v: DrawingView, seen = new Set<string>()): Source | null => {
    if (v.kind === "model") return sources.get(srcKey(v.source)) ?? null;
    if (seen.has(v.id)) return null;
    seen.add(v.id);
    const p = byId.get(v.parent);
    return p ? rootSource(p, seen) : null;
  };
  const compute = (v: DrawingView): ViewResult => {
    if (out[v.id]) return out[v.id];
    let r: ViewResult;
    try {
      const src = rootSource(v);
      if (!src) throw new Error("Vista sem modelo (a vista-mãe foi apagada?)");
      if (v.kind === "model") r = viewFromShape(src.shape, src, stdFrame(v.orientation), v.scale ?? sheetScale(d));
      else {
        const parentView = byId.get(v.parent)!;
        const P = compute(parentView);
        if (!P.ok) throw new Error("A vista-mãe tem erros");
        const scale = v.scale ?? P.scale;
        if (v.kind === "projected") r = viewFromShape(src.shape, src, projectedFrame(P.frame, v.side, d.sheet.projection), scale);
        else if (v.kind === "section") r = sectionView(src, P.frame, v, scale);
        else if (v.kind === "detail") r = detailView(P, v, v.scale ?? P.scale * 2);
        else r = auxiliaryView(src, P, v, scale);
      }
    } catch (e) {
      r = failed((e as Error).message);
    }
    out[v.id] = r;
    return r;
  };
  for (const v of d.views) compute(v);
  // volumes das peças das tabelas de BOM (massas)
  const partVolumes: Record<string, number> = {};
  const used = new Set<string>();
  const walk = (asmId: string, depth = 0) => {
    const a = project.assemblies.find((x) => x.id === asmId);
    for (const c of a?.components ?? []) { if (c.ref.kind === "part") used.add(c.ref.id); else if (depth < 32) walk(c.ref.id, depth + 1); }
  };
  for (const x of d.annotations) if (x.kind === "bom") walk(x.source);
  for (const pid of used) { try { partVolumes[pid] = (await svc.partBuild(project, pid)).volume; } catch { /* peça com erro: sem massa */ } }
  setArena(arena);
  return { views: out, sources: srcInfo, partVolumes, ms: Math.round(performance.now() - t0) };
}
