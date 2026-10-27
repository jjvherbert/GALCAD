// Operações de edição de um desenho (puras): criar vistas e anotações, mover, cotas inteligentes,
// importar cotas do modelo e balões automáticos.
import type { Anchor, Annotation, CadProject, DrawingDoc, DrawingView, NewAnnotation, NewView } from "../doc/project.ts";
import type { Curve2D, DrawingResponse } from "../kernel/protocol.ts";
import { itemOfComponent } from "../assembly/bom.ts";
import { type ViewPlacement, applyPmi, placements, rootAssembly, toSheet, toView } from "./render.ts";
import { curveAnchor, curvePoints, dist } from "./geom2d.ts";

type P = [number, number];

export function nextId(prefix: string, ids: string[]): string {
  const n = ids.reduce((m, id) => (id.startsWith(prefix) ? Math.max(m, Number(id.slice(prefix.length)) || 0) : m), 0);
  return `${prefix}${n + 1}`;
}

const viewIds = (d: DrawingDoc) => d.views.map((v) => v.id);
const annIds = (d: DrawingDoc) => d.annotations.map((a) => a.id);

export function addView(d: DrawingDoc, v: NewView): { doc: DrawingDoc; id: string } {
  const id = nextId("v", viewIds(d));
  const label = { model: "Vista", projected: "Projetada", section: "Corte", detail: "Pormenor", auxiliary: "Auxiliar" }[v.kind];
  const view = { ...v, id, name: v.name ?? `${label} ${id.slice(1)}` } as DrawingView;
  return { doc: { ...d, views: [...d.views, view] }, id };
}

export function addAnnotation(d: DrawingDoc, a: NewAnnotation): { doc: DrawingDoc; id: string } {
  const id = nextId("a", annIds(d));
  return { doc: { ...d, annotations: [...d.annotations, { ...a, id } as Annotation] }, id };
}

/** Próxima letra livre para cortes/pormenores/referências (A, B, C…). */
export function nextLetter(d: DrawingDoc): string {
  const used = new Set([...d.views.flatMap((v) => (v.kind === "section" || v.kind === "detail" ? [v.label] : [])), ...d.annotations.flatMap((a) => (a.kind === "datum" ? [a.letter] : []))]);
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(65 + i); if (!used.has(l)) return l; }
  return "Z";
}

/** Apaga uma vista e as que dependem dela (e as anotações ligadas). */
export function deleteView(d: DrawingDoc, id: string): DrawingDoc {
  const gone = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const v of d.views) if (v.kind !== "model" && gone.has(v.parent) && !gone.has(v.id)) { gone.add(v.id); grew = true; }
  }
  const usesGone = (a: Annotation): boolean => {
    const anchors: (Anchor | undefined)[] = a.kind === "dim" ? [a.a, a.b] : a.kind === "note" || a.kind === "gdt" ? [a.leader] : a.kind === "datum" || a.kind === "weld" ? [a.anchor] : a.kind === "surface" ? [a.anchor] : [];
    if (a.kind === "balloon" && gone.has(a.view)) return true;
    if (a.kind === "dim" && a.model && gone.has(a.model.view)) return true;
    return anchors.some((x) => x && gone.has(x.view));
  };
  return { ...d, views: d.views.filter((v) => !gone.has(v.id)), annotations: d.annotations.filter((a) => !usesGone(a)) };
}

export function moveView(d: DrawingDoc, id: string, at: P): DrawingDoc {
  return { ...d, views: d.views.map((v) => (v.id === id ? { ...v, at } : v)) };
}

/** Move uma anotação: as cotas mudam a distância (offset) ou o ângulo; as outras mudam a posição. */
export function moveAnnotation(d: DrawingDoc, id: string, delta: P, res: DrawingResponse | null, pointer: P): DrawingDoc {
  const pl = placements(d, res);
  return {
    ...d,
    annotations: d.annotations.map((a) => {
      if (a.id !== id) return a;
      if (a.kind !== "dim") return { ...a, at: [a.at[0] + delta[0], a.at[1] + delta[1]] } as Annotation;
      if (a.type === "radius" || a.type === "diameter") {
        const v = "view" in a.a ? pl[a.a.view] : undefined;
        const c = v && "edge" in a.a ? res?.views[a.a.view]?.edges[a.a.edge] : undefined;
        if (v && c && (c.k === "c" || c.k === "a")) {
          const C = toSheet(v, c.c);
          return { ...a, angle: (Math.atan2(pointer[1] - C[1], pointer[0] - C[0]) * 180) / Math.PI, offset: Math.max(4, dist(pointer, C) - c.r * v.s) };
        }
        return a;
      }
      if (a.type === "horizontal") return { ...a, offset: a.offset + delta[1] };
      if (a.type === "vertical") return { ...a, offset: a.offset - delta[0] };
      return { ...a, offset: a.offset + delta[1] };
    }),
  };
}

/** Lado da vista projetada pela posição do clique em relação à vista-mãe. */
export function sideOf(parent: ViewPlacement, at: P): "right" | "left" | "above" | "below" {
  const c: P = [(parent.box[0] + parent.box[2]) / 2, (parent.box[1] + parent.box[3]) / 2];
  const dx = at[0] - c[0], dy = at[1] - c[1];
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "above" : "below";
}

const isLine = (c: Curve2D): c is Extract<Curve2D, { k: "l" }> => c.k === "l";
const dirOf = (c: Extract<Curve2D, { k: "l" }>): P => { const l = dist(c.a, c.b) || 1; return [(c.b[0] - c.a[0]) / l, (c.b[1] - c.a[1]) / l]; };

/**
 * Cota inteligente a partir de uma ou duas arestas escolhidas (como a Smart Dimension):
 * círculo → diâmetro; arco → raio; uma reta → comprimento; duas retas paralelas → distância;
 * duas retas concorrentes → ângulo. `place` é o ponto de colocação na folha.
 */
export function smartDimension(res: DrawingResponse | null, pl: Record<string, ViewPlacement>, picks: { view: string; edge: string }[], place: P): Extract<NewAnnotation, { kind: "dim" }> | null {
  const curve = (p: { view: string; edge: string }) => res?.views[p.view]?.edges[p.edge];
  const [p1, p2] = picks;
  const c1 = p1 && curve(p1);
  if (!c1) return null;
  const v = pl[p1.view];
  if (!v) return null;
  if (!p2) {
    if (c1.k === "c" || c1.k === "a") {
      const C = toSheet(v, c1.c);
      return { kind: "dim", type: c1.k === "c" ? "diameter" : "radius", a: { view: p1.view, edge: p1.edge, at: "center" }, offset: Math.max(4, dist(place, C) - c1.r * v.s), angle: (Math.atan2(place[1] - C[1], place[0] - C[0]) * 180) / Math.PI };
    }
    const pts = curvePoints(c1);
    const A = toSheet(v, pts[0]), B = toSheet(v, pts[pts.length - 1]);
    const d: P = [B[0] - A[0], B[1] - A[1]];
    const type = Math.abs(d[1]) < 1e-6 * (Math.abs(d[0]) + 1) ? "horizontal" : Math.abs(d[0]) < 1e-6 * (Math.abs(d[1]) + 1) ? "vertical" : "aligned";
    return { kind: "dim", type, a: { view: p1.view, edge: p1.edge, at: "start" }, b: { view: p1.view, edge: p1.edge, at: "end" }, offset: offsetFor(type, A, B, place) };
  }
  const c2 = curve(p2);
  if (!c2) return null;
  if (isLine(c1) && isLine(c2)) {
    const d1 = dirOf(c1), d2 = dirOf(c2);
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) > 1e-6) return { kind: "dim", type: "angle", a: { view: p1.view, edge: p1.edge, at: "mid" }, b: { view: p2.view, edge: p2.edge, at: "mid" }, offset: Math.max(10, dist(place, toSheet(v, c1.a))) };
    // paralelas: distância perpendicular, medida entre os pontos médios projetados
    const A = toSheet(v, curveAnchor(c1, "mid")), B = toSheet(pl[p2.view] ?? v, curveAnchor(c2, "mid"));
    const type = Math.abs(d1[0]) < 1e-6 ? "horizontal" : Math.abs(d1[1]) < 1e-6 ? "vertical" : "aligned";
    return { kind: "dim", type, a: { view: p1.view, edge: p1.edge, at: "mid" }, b: { view: p2.view, edge: p2.edge, at: "mid" }, offset: offsetFor(type, A, B, place) };
  }
  // centro a centro (círculos) ou centro a reta
  const at = (c: Curve2D) => (c.k === "c" || c.k === "a" ? "center" : "mid") as "center" | "mid";
  const A = toSheet(v, curveAnchor(c1, at(c1))), B = toSheet(pl[p2.view] ?? v, curveAnchor(c2, at(c2)));
  const type = Math.abs(A[1] - B[1]) < Math.abs(A[0] - B[0]) ? "horizontal" : "vertical";
  return { kind: "dim", type, a: { view: p1.view, edge: p1.edge, at: at(c1) }, b: { view: p2.view, edge: p2.edge, at: at(c2) }, offset: offsetFor(type, A, B, place) };
}

function offsetFor(type: "horizontal" | "vertical" | "aligned", A: P, B: P, place: P): number {
  if (type === "horizontal") { const ref = place[1] >= Math.max(A[1], B[1]) ? Math.max(A[1], B[1]) : Math.min(A[1], B[1]); return place[1] - ref; }
  if (type === "vertical") { const ref = place[0] <= Math.min(A[0], B[0]) ? Math.min(A[0], B[0]) : Math.max(A[0], B[0]); return -(place[0] - ref); }
  const l = dist(A, B) || 1;
  const n: P = [-(B[1] - A[1]) / l, (B[0] - A[0]) / l];
  const M: P = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  return (place[0] - M[0]) * n[0] + (place[1] - M[1]) * n[1];
}

/** Importa as cotas dos esboços paralelos a uma vista (associativas: seguem o modelo). */
export function importModelDims(d: DrawingDoc, res: DrawingResponse | null, viewId: string): { doc: DrawingDoc; count: number } {
  const r = res?.views[viewId];
  if (!r?.ok) return { doc: d, count: 0 };
  let doc = d;
  let count = 0;
  for (const m of r.modelDims) {
    if (doc.annotations.some((a) => a.kind === "dim" && a.model?.feature === m.feature && a.model.constraint === m.constraint && a.model.view === viewId)) continue;
    const type = m.type === "radius" || m.type === "diameter" ? m.type : m.type;
    doc = addAnnotation(doc, { kind: "dim", type, a: { view: viewId, point: m.a }, b: { view: viewId, point: m.b }, offset: type === "radius" || type === "diameter" ? 6 : 8 + 7 * (count % 3), model: { feature: m.feature, constraint: m.constraint, view: viewId } }).doc;
    count++;
  }
  return { doc, count };
}

/**
 * Importar o PMI 3D da peça para vistas do desenho (como «inserir itens do modelo»): cada item vai
 * para uma só vista — as cotas para a primeira onde a grandeza está no plano da vista, os rótulos para
 * a vista onde a face se vê de perfil (|n·z| mínimo). `viewId` omitido: todas as vistas pela ordem.
 * As anotações ficam ligadas ao item (conteúdo e ancoragem seguem o modelo).
 */
export function importPmi(d: DrawingDoc, res: DrawingResponse | null, viewId?: string): { doc: DrawingDoc; count: number } {
  const pl = placements(d, res);
  const views = d.views.filter((v) => (!viewId || v.id === viewId) && res?.views[v.id]?.ok && pl[v.id]);
  const done = new Set(d.annotations.flatMap((a) => ("pmi" in a && a.pmi ? [a.pmi.item] : [])));
  // rótulos: melhor vista para cada item (só vistas onde a face não está de frente, |n·z| < 0,35)
  // cotas: a primeira vista onde a grandeza está em verdadeira grandeza; os diâmetros preferem a
  // vista em que o furo/veio aparece como círculo à da silhueta
  const best = new Map<string, { view: string; score: number }>();
  for (const v of views) for (const e of res!.views[v.id].pmi ?? []) {
    const score = e.kind === "dim" ? (e.prefix === "⌀" ? 1 : 0) : e.score;
    if (e.kind === "label" && score >= 0.35) continue;
    const b = best.get(e.item);
    if (!b || score < b.score - 1e-9) best.set(e.item, { view: v.id, score });
  }
  let doc = d, count = 0;
  const perAnchor = new Map<string, number>();
  // zonas ocupadas na folha (rótulos colocados e faixas das cotas fora da vista), para não sobrepor
  const taken: [number, number, number, number][] = [];
  const outside = new Map<string, number>();
  for (const v of views) {
    const p = pl[v.id];
    for (const e of res!.views[v.id].pmi ?? []) {
      if (done.has(e.item) || best.get(e.item)?.view !== v.id) continue;
      const link = { item: e.item, view: v.id };
      if (e.kind === "dim") {
        // cotas lineares fora da vista: acima (horizontais) ou à esquerda (verticais), escalonadas
        let offset = e.type === "radius" || e.type === "diameter" ? 6 : 10;
        if (e.type === "horizontal" || e.type === "vertical") {
          const key = `${v.id}:${e.type}`, n = outside.get(key) ?? 0;
          outside.set(key, n + 1);
          const A = toSheet(p, e.a), B = toSheet(p, e.b);
          offset = (e.type === "horizontal" ? p.box[3] - Math.max(A[1], B[1]) : Math.min(A[0], B[0]) - p.box[0]) + 16 + 8 * n;
          if (e.type === "horizontal") { const y = Math.max(A[1], B[1]) + offset; taken.push([Math.min(A[0], B[0]), Math.max(A[0], B[0]), y - 1, y + 6]); }
          else { const x = Math.min(A[0], B[0]) - offset; taken.push([x - 6, x + 1, Math.min(A[1], B[1]), Math.max(A[1], B[1])]); }
        }
        doc = addAnnotation(doc, { kind: "dim", type: e.type, a: { view: v.id, point: e.a }, b: { view: v.id, point: e.b }, offset, pmi: link }).doc;
      } else {
        // rótulos da mesma face afastam-se em escada ao longo da normal
        const akey = `${v.id}:${e.at.map((x) => x.toFixed(3)).join(",")}`, n = perAnchor.get(akey) ?? 0;
        perAnchor.set(akey, n + 1);
        // chamada inclinada para fora da vista (para o lado mais próximo), longe das cotas alinhadas com a normal
        const tip = toSheet(p, e.at), k = 20 + 11 * n;
        const side = tip[0] >= (p.box[0] + p.box[2]) / 2 ? 1 : -1;
        const perp: [number, number] = Math.abs(e.dir[0]) > 0.9 ? [0, side] : [side, 0];
        const u = [e.dir[0] + 0.9 * perp[0], e.dir[1] + 0.9 * perp[1]], ul = Math.hypot(u[0], u[1]) || 1;
        const at: [number, number] = [tip[0] + (u[0] / ul) * k, tip[1] + (u[1] / ul) * k];
        // rótulo fora do contorno da vista (âncoras interiores, ex.: furos)
        // extensão aproximada do rótulo a partir de `at` (quadro GD&T ~30 × 7 mm, referência 7 × 7)
        const ext = e.data.kind === "gdt" ? [0, 30, 0, 7] : e.data.kind === "datum" ? [-3.5, 3.5, 0, 7] : [0, 20, -2, 4];
        const inBox = (q: [number, number]) => q[0] + ext[1] > p.box[0] - 3 && q[0] + ext[0] < p.box[2] + 3 && q[1] + ext[3] > p.box[1] - 3 && q[1] + ext[2] < p.box[3] + 3;
        const hits = (q: [number, number]) => taken.some((r) => q[0] + ext[1] > r[0] && q[0] + ext[0] < r[1] && q[1] + ext[3] > r[2] && q[1] + ext[2] < r[3]);
        for (let i = 0; i < 80 && (inBox(at) || hits(at)); i++) { at[0] += (u[0] / ul) * 3; at[1] += (u[1] / ul) * 3; }
        taken.push([at[0] + ext[0] - 1, at[0] + ext[1] + 1, at[1] + ext[2] - 1, at[1] + ext[3] + 1]);
        const anchor: Anchor = { view: v.id, point: e.at };
        const d0 = e.data;
        const ann: NewAnnotation =
          d0.kind === "gdt" ? { kind: "gdt", at: [e.dir[0] < 0 ? at[0] - 24 : at[0], at[1]], leader: anchor, char: "flatness", tol: "", datums: [], pmi: link }
          : d0.kind === "datum" ? { kind: "datum", at, anchor, letter: d0.label, pmi: link }
          : d0.kind === "roughness" ? { kind: "surface", at, anchor, process: "any", value: "", pmi: link }
          : { kind: "note", at: [e.dir[0] < 0 ? at[0] - 20 : at[0], at[1]], text: e.text, leader: anchor, pmi: link };
        doc = addAnnotation(doc, (applyPmi({ ...ann, id: "" } as Annotation, e, anchor) ?? ann) as NewAnnotation).doc;
      }
      done.add(e.item);
      count++;
    }
  }
  return { doc, count };
}

/** Balões automáticos: um por componente de topo visível numa vista de montagem. */
export function autoBalloons(d: DrawingDoc, project: CadProject, res: DrawingResponse | null, viewId: string): { doc: DrawingDoc; count: number } {
  const v = d.views.find((x) => x.id === viewId);
  const r = res?.views[viewId];
  const pl = placements(d, res)[viewId];
  const asm = v && rootAssembly(d, v);
  if (!v || !r?.ok || !pl || !asm || !r.edgeComponent) return { doc: d, count: 0 };
  const done = new Set(d.annotations.flatMap((a) => (a.kind === "balloon" && a.view === viewId ? [a.component] : [])));
  const items = new Set<string>();
  let doc = d, count = 0;
  const center: P = [(pl.box[0] + pl.box[2]) / 2, (pl.box[1] + pl.box[3]) / 2];
  const rad = Math.hypot(pl.box[2] - pl.box[0], pl.box[3] - pl.box[1]) / 2 + 15;
  for (const [edge, comp] of Object.entries(r.edgeComponent)) {
    if (done.has(comp)) continue;
    const item = itemOfComponent(project, asm, comp);
    if (!item || items.has(item)) continue; // um balão por item
    const c = r.edges[edge];
    const tip = toSheet(pl, curveAnchor(c, "mid"));
    const dir: P = [tip[0] - center[0], tip[1] - center[1]];
    const l = Math.hypot(dir[0], dir[1]) || 1;
    const at: P = [center[0] + (dir[0] / l) * rad, center[1] + (dir[1] / l) * rad];
    doc = addAnnotation(doc, { kind: "balloon", at, view: viewId, component: comp, edge }).doc;
    done.add(comp); items.add(item); count++;
  }
  return { doc, count };
}

export { toView, toSheet };
