// Folha de desenho → primitivas: formato e esquadria (ISO 5457), legenda (ISO 7200), vistas,
// cortes, pormenores, cotas (ISO 129-1), tolerâncias geométricas (ISO 1101), referências,
// estados de superfície, soldaduras, notas, balões e tabela de BOM. Pura: serve a UI e as exportações.
import type { Annotation, CadProject, DrawingDoc, DrawingView } from "../doc/project.ts";
import type { Curve2D, DrawingResponse, ViewResult } from "../kernel/protocol.ts";
import { BOM_COLUMNS, bomCell, computeBom, customColumns, itemOfComponent } from "../assembly/bom.ts";
import { curvePoints, dist, hatchTriangles } from "./geom2d.ts";
import {
  type Layer, type P, type Prim, add, arrow, gdtSymbol, mul, projectionSymbol, surfaceSymbol, textWidth, weldGlyph,
} from "./prims.ts";

import { type Ctx, type Layout, type ViewPlacement, FRAME, TITLE_H, TITLE_W, fmtNum, placements, sheetSize, toSheet, toView } from "./render-base.ts";
import { anchorPoint, dimension, fromPmi } from "./render-dim.ts";

export { SHEET_SIZES, sheetSize, FRAME, TITLE_W, TITLE_H, type ViewPlacement, type Layout, fmtNum, placements, toSheet, toView } from "./render-base.ts";
export { anchorPoint, applyPmi, pmiTol } from "./render-dim.ts";

const scaleText = (s: number) => {
  if (s >= 1) { const k = Math.round(s * 100) / 100; return `${fmtNum(k)}:1`; }
  const k = Math.round((1 / s) * 100) / 100;
  return `1:${fmtNum(k)}`;
};

function curvePrims(c: Curve2D, pl: ViewPlacement, layer: Layer, ref?: string): Prim {
  switch (c.k) {
    case "l": return { t: "line", a: toSheet(pl, c.a), b: toSheet(pl, c.b), layer, ref };
    case "c": return { t: "circle", c: toSheet(pl, c.c), r: c.r * pl.s, layer, ref };
    case "a": return { t: "arc", c: toSheet(pl, c.c), r: c.r * pl.s, a0: c.a0, a1: c.a1, layer, ref };
    case "p": return { t: "poly", pts: c.pts.map((p) => toSheet(pl, p)), layer, ref };
  }
}

// ---------------------------------------------------------------------------
// Folha: esquadria, zonas e legenda
// ---------------------------------------------------------------------------

function frame(d: DrawingDoc, w: number, h: number): Prim[] {
  const out: Prim[] = [];
  const x0 = FRAME.left, y0 = FRAME.bottom, x1 = w - FRAME.right, y1 = h - FRAME.top;
  out.push({ t: "poly", closed: true, pts: [[0, 0], [w, 0], [w, h], [0, h]], layer: "thin" });
  out.push({ t: "poly", closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], layer: "frame" });
  // zonas de referência (ISO 5457): números na horizontal, letras na vertical, de ~50 mm
  const nx = Math.max(2, Math.round((x1 - x0) / 50)), ny = Math.max(2, Math.round((y1 - y0) / 50));
  for (let i = 0; i < nx; i++) {
    const xa = x0 + ((x1 - x0) * i) / nx, xb = x0 + ((x1 - x0) * (i + 1)) / nx;
    if (i) for (const [ya, yb] of [[y1, y1 + 5], [y0 - 5, y0]]) out.push({ t: "line", a: [xa, ya], b: [xa, yb], layer: "thin" });
    for (const y of [y1 + 2.5, y0 - 2.5]) out.push({ t: "text", at: [(xa + xb) / 2, y], text: String(i + 1), h: 2.5, align: "middle", valign: "middle", layer: "text" });
  }
  for (let j = 0; j < ny; j++) {
    const ya = y1 - ((y1 - y0) * j) / ny, yb = y1 - ((y1 - y0) * (j + 1)) / ny;
    if (j) for (const [xa, xb] of [[x0 - 5, x0], [x1, x1 + 5]]) out.push({ t: "line", a: [xa, ya], b: [xb, ya], layer: "thin" });
    for (const x of [x0 - 2.5, x1 + 5]) out.push({ t: "text", at: [x, (ya + yb) / 2], text: String.fromCharCode(65 + j), h: 2.5, align: "middle", valign: "middle", layer: "text" });
  }
  // marcas de centragem
  for (const [a, b] of [[[w / 2, 0], [w / 2, y0 + 5]], [[w / 2, h], [w / 2, y1 - 5]], [[0, h / 2], [x0 + 5, h / 2]], [[w, h / 2], [x1 - 5, h / 2]]] as [P, P][]) out.push({ t: "line", a, b, layer: "frame" });
  void d;
  return out;
}

function titleBlock(d: DrawingDoc, project: CadProject, res: DrawingResponse | null, w: number): Prim[] {
  const out: Prim[] = [];
  const x1 = w - FRAME.right, x0 = x1 - TITLE_W, y0 = FRAME.bottom, y1 = y0 + TITLE_H;
  const firstModel = d.views.find((v): v is Extract<DrawingView, { kind: "model" }> => v.kind === "model");
  const src = firstModel ? res?.sources[firstModel.source.id] : undefined;
  const part = firstModel?.source.kind === "part" ? project.parts.find((p) => p.id === firstModel.source.id) : undefined;
  const asm = firstModel?.source.kind === "assembly" ? project.assemblies.find((a) => a.id === firstModel.source.id) : undefined;
  const density = part?.properties?.density ?? 7.85;
  const mass = src && part ? `${fmtNum((src.volume / 1000) * density / 1000, 3)} kg` : "";
  const material = d.title.material || part?.properties?.material || (asm ? "—" : "");
  const t = d.title;
  const title = t.title || part?.properties?.description || part?.name || asm?.name || d.name;
  const number = t.number || part?.properties?.number || "";
  out.push({ t: "poly", closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], layer: "frame" });
  // linhas: [y, colunas (larguras)], de cima para baixo, cada uma com 9 mm
  const rows: [string, string, number, boolean?][][] = [
    [["Proprietário", t.company, 110], ["Revisão", t.revision, 20], ["Data", t.date, 50]],
    [["Título", title, 110, true], ["Escala", d.sheet.scale.join(":"), 20], ["Projeção", "", 50]],
    [["N.º do desenho", number, 110, true], ["Folha", t.sheet, 20], ["Material", material, 50]],
    [["Desenhou", t.author, 37], ["Verificou", t.checker, 37], ["Aprovou", t.approver, 36], ["Massa", mass, 30], ["Tolerâncias gerais", t.generalTolerance, 40]],
  ];
  rows.forEach((cols, i) => {
    const ya = y1 - 9 * (i + 1), yb = ya + 9;
    if (i) out.push({ t: "line", a: [x0, yb], b: [x1, yb], layer: "frame" });
    let x = x0;
    cols.forEach(([label, value, cw, big], k) => {
      if (k) out.push({ t: "line", a: [x, ya], b: [x, yb], layer: "thin" });
      out.push({ t: "text", at: [x + 1, yb - 2.2], text: label, h: 1.8, layer: "text" });
      if (label === "Projeção") out.push(...projectionSymbol([x + cw / 2, ya + 3.8], d.sheet.projection, 0.55), { t: "text", at: [x + cw - 1, ya + 1], text: d.sheet.projection === "first" ? "1.º diedro" : "3.º diedro", h: 1.8, align: "end", layer: "text" });
      else if (value) {
        const h = big ? 4 : 2.5;
        const max = Math.floor((cw - 2) / (h * 0.6));
        out.push({ t: "text", at: [x + 1.5, ya + 1.6], text: value.length > max ? `${value.slice(0, max - 1)}…` : value, h, bold: big, layer: "text" });
      }
      x += cw;
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Anotações
// ---------------------------------------------------------------------------

function leader(from: P, to: P, ref: string, end: "arrow" | "dot" = "arrow"): Prim[] {
  const out: Prim[] = [{ t: "line", a: from, b: to, layer: "annot", ref }];
  if (end === "arrow") out.push(arrow(to, [to[0] - from[0], to[1] - from[1]], "annot"));
  else out.push({ t: "circle", c: to, r: 0.6, fill: true, layer: "annot", ref });
  return out;
}

function annotation(ctx: Ctx, project: CadProject, a0: Annotation): Prim[] {
  const a = a0.kind === "dim" ? a0 : fromPmi(ctx, a0);
  if (!a) return [];
  const ref = `ann:${a.id}`;
  switch (a.kind) {
    case "dim": return dimension(ctx, a);
    case "note": {
      const h = a.height ?? 3.5;
      const lines = a.text.split("\n");
      const out: Prim[] = lines.map((l, i) => ({ t: "text", at: [a.at[0], a.at[1] - i * h * 1.5], text: l, h, layer: "text", ref }) as Prim);
      const tip = a.leader ? anchorPoint(ctx, a.leader) : null;
      if (tip) out.push(...leader([a.at[0] - 1, a.at[1] + h / 2], tip, ref));
      return out;
    }
    case "gdt": {
      const h = 7;
      const cells: { w: number; draw: (x: number) => Prim[] }[] = [
        { w: h, draw: (x) => gdtSymbol(a.char, [x + h / 2, a.at[1] + h / 2], h) },
        { w: textWidth(`${a.dia ? "⌀" : ""}${a.tol}${a.modifier ? ` ${a.modifier}` : ""}`, 3.5) + 3, draw: (x) => [{ t: "text", at: [x + 1.5, a.at[1] + 2], text: `${a.dia ? "⌀" : ""}${a.tol}${a.modifier ? ` (${a.modifier})` : ""}`, h: 3.5, layer: "text", ref }] },
        ...a.datums.filter(Boolean).map((dl) => ({ w: Math.max(h, textWidth(dl, 3.5) + 3), draw: (x: number) => [{ t: "text", at: [x + 1.5, a.at[1] + 2], text: dl, h: 3.5, layer: "text", ref } as Prim] })),
      ];
      const out: Prim[] = [];
      let x = a.at[0];
      for (const c of cells) {
        out.push({ t: "poly", closed: true, pts: [[x, a.at[1]], [x + c.w, a.at[1]], [x + c.w, a.at[1] + h], [x, a.at[1] + h]], layer: "annot", ref }, ...c.draw(x));
        x += c.w;
      }
      const tip = a.leader ? anchorPoint(ctx, a.leader) : null;
      if (tip) out.push(...leader([a.at[0], a.at[1] + h / 2], tip, ref));
      return out;
    }
    case "datum": {
      const tip = anchorPoint(ctx, a.anchor) ?? a.at;
      const s = 7;
      const out: Prim[] = [
        { t: "poly", closed: true, pts: [[a.at[0] - s / 2, a.at[1]], [a.at[0] + s / 2, a.at[1]], [a.at[0] + s / 2, a.at[1] + s], [a.at[0] - s / 2, a.at[1] + s]], layer: "annot", ref },
        { t: "text", at: [a.at[0], a.at[1] + s / 2], text: a.letter, h: 3.5, align: "middle", valign: "middle", layer: "text", ref },
        { t: "line", a: [a.at[0], a.at[1]], b: tip, layer: "annot", ref },
      ];
      const dx = tip[0] - a.at[0], dy = tip[1] - a.at[1];
      const l = Math.hypot(dx, dy) || 1;
      const u: P = [dx / l, dy / l], n: P = [-u[1], u[0]];
      out.push({ t: "poly", closed: true, fill: true, pts: [add(tip, mul(n, 1.8)), add(tip, mul(n, -1.8)), add(tip, mul(u, -3))], layer: "annot", ref });
      return out;
    }
    case "surface": {
      const tip = (a.anchor && anchorPoint(ctx, a.anchor)) ?? a.at;
      return surfaceSymbol(tip, a.process, a.value).map((p) => ({ ...p, ref }));
    }
    case "weld": {
      const tip = anchorPoint(ctx, a.anchor) ?? [a.at[0] - 10, a.at[1] - 10];
      const L = 24;
      const out: Prim[] = [...leader(a.at, tip, ref), { t: "line", a: a.at, b: [a.at[0] + L, a.at[1]], layer: "annot", ref }];
      out.push({ t: "line", a: [a.at[0], a.at[1] - 1.2], b: [a.at[0] + L, a.at[1] - 1.2], layer: "hidden", ref });
      const mid: P = [a.at[0] + L / 2, a.otherSide ? a.at[1] - 1.2 : a.at[1]];
      out.push(...weldGlyph(a.symbol, mid, !!a.otherSide).map((p) => ({ ...p, ref })));
      const ty = a.otherSide ? a.at[1] - 5.5 : a.at[1] + 0.8;
      if (a.size) out.push({ t: "text", at: [mid[0] - 3, ty], text: a.size, h: 2.5, align: "end", layer: "text", ref });
      if (a.length) out.push({ t: "text", at: [mid[0] + 3, ty], text: a.length, h: 2.5, layer: "text", ref });
      if (a.allAround) out.push({ t: "circle", c: a.at, r: 1.5, layer: "annot", ref });
      return out;
    }
    case "balloon": {
      const view = ctx.d.views.find((v) => v.id === a.view);
      const asmId = view && rootAssembly(ctx.d, view);
      const item = asmId ? itemOfComponent(project, asmId, a.component) : null;
      const r = 5;
      const out: Prim[] = [{ t: "circle", c: a.at, r, layer: "annot", ref }, { t: "text", at: a.at, text: item ?? "?", h: 3.5, align: "middle", valign: "middle", layer: item ? "text" : "error", ref }];
      if (!item) ctx.warnings.push("Balão de um componente que já não está na montagem");
      const tip = a.edge ? anchorPoint(ctx, { view: a.view, edge: a.edge, at: "mid" }) : null;
      if (tip) {
        const l = dist(a.at, tip) || 1;
        out.push(...leader(add(a.at, mul([(tip[0] - a.at[0]) / l, (tip[1] - a.at[1]) / l], r)), tip, ref, "dot"));
      }
      return out;
    }
    case "bom": return bomTable(ctx, project, a);
  }
}

/** Montagem de origem de uma vista (pela cadeia de vistas-mãe). */
export function rootAssembly(d: DrawingDoc, v: DrawingView, depth = 0): string | null {
  if (v.kind === "model") return v.source.kind === "assembly" ? v.source.id : null;
  const p = d.views.find((x) => x.id === v.parent);
  return p && depth < 20 ? rootAssembly(d, p, depth + 1) : null;
}

function bomTable(ctx: Ctx, project: CadProject, a: Extract<Annotation, { kind: "bom" }>): Prim[] {
  const ref = `ann:${a.id}`;
  if (!project.assemblies.some((x) => x.id === a.source)) { ctx.warnings.push("Tabela de BOM sem montagem"); return [{ t: "text", at: a.at, text: "BOM: montagem inexistente", h: 3.5, layer: "error", ref }]; }
  const rows = computeBom(project, a.source, a.mode, ctx.res?.partVolumes ?? {});
  const cols = [...(a.columns?.length ? BOM_COLUMNS.filter((c) => a.columns!.includes(c.key)) : BOM_COLUMNS), ...customColumns(rows).map((k) => ({ key: k, label: k }))];
  const widths = cols.map((c) => Math.max(textWidth(c.label, 2.5) + 3, ...rows.map((r) => textWidth(bomCell(r, c.key), 2.5) + 3), c.key === "description" ? 40 : 10));
  const rh = 6;
  const W = widths.reduce((s, x) => s + x, 0);
  const out: Prim[] = [];
  const [x0, y0] = a.at;
  const n = rows.length + 1;
  out.push({ t: "poly", closed: true, pts: [[x0, y0], [x0 + W, y0], [x0 + W, y0 - n * rh], [x0, y0 - n * rh]], layer: "frame", ref });
  for (let i = 1; i < n; i++) out.push({ t: "line", a: [x0, y0 - i * rh], b: [x0 + W, y0 - i * rh], layer: i === 1 ? "frame" : "thin", ref });
  let x = x0;
  cols.forEach((c, k) => {
    if (k) out.push({ t: "line", a: [x, y0], b: [x, y0 - n * rh], layer: "thin", ref });
    out.push({ t: "text", at: [x + 1.5, y0 - rh + 1.8], text: c.label, h: 2.5, bold: true, layer: "text", ref });
    rows.forEach((r, i) => out.push({ t: "text", at: [x + 1.5 + (c.key === "description" ? r.level * 3 : 0), y0 - (i + 2) * rh + 1.8], text: bomCell(r, c.key), h: 2.5, layer: "text", ref }));
    x += widths[k];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

function viewPrims(ctx: Ctx, v: DrawingView, r: ViewResult, pl: ViewPlacement): Prim[] {
  const ref = `view:${v.id}`;
  const out: Prim[] = [];
  for (const c of r.visible) out.push(curvePrims(c, pl, "visible", ref));
  if (v.tangent !== "none") for (const c of r.tangent) out.push(curvePrims(c, pl, "tangent", ref));
  if (v.hidden) for (const c of r.hidden) out.push(curvePrims(c, pl, "hidden", ref));
  // tracejado de corte (ISO 128-50): 45°, ~3 mm na folha
  if (r.hatch.length) for (const [a, b] of hatchTriangles(r.hatch, 3 / pl.s)) out.push({ t: "line", a: toSheet(pl, a), b: toSheet(pl, b), layer: "hatch", ref });
  if (v.centerMarks !== false) {
    for (const m of r.centerMarks) {
      const c = toSheet(pl, m.c), e = m.r * pl.s + 2;
      out.push({ t: "line", a: [c[0] - e, c[1]], b: [c[0] + e, c[1]], layer: "center", ref }, { t: "line", a: [c[0], c[1] - e], b: [c[0], c[1] + e], layer: "center", ref });
    }
    for (const [a, b] of r.centerLines) {
      const A = toSheet(pl, a), B = toSheet(pl, b);
      const l = dist(A, B) || 1;
      const u: P = [(B[0] - A[0]) / l, (B[1] - A[1]) / l];
      out.push({ t: "line", a: add(A, mul(u, -2)), b: add(B, mul(u, 2)), layer: "center", ref });
    }
  }
  // rótulo e escala
  const sheetScale = ctx.d.sheet.scale[0] / ctx.d.sheet.scale[1];
  const label = v.kind === "section" ? `CORTE ${v.label}-${v.label}` : v.kind === "detail" ? `PORMENOR ${v.label}` : v.kind === "auxiliary" ? v.name.toUpperCase() : "";
  const sc = Math.abs(pl.s - sheetScale) > 1e-9 || v.kind === "detail" ? ` (${scaleText(pl.s)})` : "";
  if (label || sc) out.push({ t: "text", at: [(pl.box[0] + pl.box[2]) / 2, pl.box[1] - 7], text: `${label}${sc}`.trim(), h: 3.5, align: "middle", layer: "text", ref });
  return out;
}

/** Marcas na vista-mãe: linha de corte com setas e letras; círculo de pormenor. */
function parentMarks(ctx: Ctx, v: DrawingView): Prim[] {
  if (v.kind !== "section" && v.kind !== "detail") return [];
  const pl = ctx.pl[v.parent];
  const r = ctx.res?.views[v.id];
  if (!pl || !r?.ok) return [];
  const ref = `view:${v.id}`;
  if (v.kind === "detail") {
    const c = toSheet(pl, v.center), rad = v.radius * pl.s;
    return [{ t: "circle", c, r: rad, layer: "thin", ref }, { t: "text", at: [c[0] + rad * 0.75 + 1, c[1] + rad * 0.75 + 1], text: v.label, h: 5, layer: "text", ref }];
  }
  const A = toSheet(pl, v.a), B = toSheet(pl, v.b);
  const l = dist(A, B) || 1;
  const u: P = [(B[0] - A[0]) / l, (B[1] - A[1]) / l];
  // direção de observação: a normal do plano de corte projetada na vista-mãe
  const pf = ctx.res!.views[v.parent].frame, z = r.frame.z;
  const zx = z[0] * pf.x[0] + z[1] * pf.x[1] + z[2] * pf.x[2], zy = z[0] * pf.y[0] + z[1] * pf.y[1] + z[2] * pf.y[2];
  const look: P = [-zx, -zy]; // o observador olha no sentido oposto à normal da vista
  const out: Prim[] = [{ t: "line", a: A, b: B, layer: "center", ref }];
  for (const [p, s] of [[A, 1], [B, -1]] as [P, number][]) {
    const end = add(p, mul(u, s * 6));
    out.push({ t: "line", a: p, b: end, layer: "section", ref });
    const tail = add(p, mul(u, s * 3));
    out.push({ t: "line", a: tail, b: add(tail, mul(look, 7)), layer: "thin", ref }, arrow(add(tail, mul(look, 7)), look, "thin", 3.5));
    out.push({ t: "text", at: add(add(tail, mul(look, 9)), mul(u, s * -1)), text: v.label, h: 5, align: "middle", valign: "middle", layer: "text", ref });
  }
  return out;
}

export function renderDrawing(d: DrawingDoc, project: CadProject, res: DrawingResponse | null): Layout {
  const [w, h] = sheetSize(d);
  const pl = placements(d, res);
  const ctx: Ctx = { d, res, pl, warnings: [] };
  const prims: Prim[] = [...frame(d, w, h), ...titleBlock(d, project, res, w)];
  for (const v of d.views) {
    const r = res?.views[v.id];
    if (!r) continue;
    if (!r.ok) {
      prims.push({ t: "text", at: v.at, text: `${v.name}: ${r.error}`, h: 3, align: "middle", layer: "error", ref: `view:${v.id}` });
      ctx.warnings.push(`${v.name}: ${r.error}`);
      continue;
    }
    prims.push(...viewPrims(ctx, v, r, pl[v.id]), ...parentMarks(ctx, v));
  }
  const ann: Layout["ann"] = {};
  for (const a of d.annotations) {
    const ps = annotation(ctx, project, a);
    prims.push(...ps);
    const pts = ps.flatMap((p) => (p.t === "line" ? [p.a, p.b] : p.t === "poly" ? p.pts : p.t === "text" ? [p.at, add(p.at, [textWidth(p.text, p.h), p.h])] : [add(p.c, [-p.r, -p.r]), add(p.c, [p.r, p.r])]));
    if (pts.length) ann[a.id] = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }
  return { w, h, prims, views: pl, ann, warnings: ctx.warnings };
}

/** A aresta de uma vista mais próxima de um ponto da folha (para cotas e anotações). */
export function pickEdge(res: DrawingResponse | null, pl: Record<string, ViewPlacement>, q: P, tol: number, view?: string): { view: string; edge: string; curve: Curve2D; d: number } | null {
  let best: { view: string; edge: string; curve: Curve2D; d: number } | null = null;
  for (const [vid, p] of Object.entries(pl)) {
    if (view && vid !== view) continue;
    const r = res?.views[vid];
    if (!r?.ok) continue;
    const local = toView(p, q);
    for (const [name, c] of Object.entries(r.edges)) {
      const pts = curvePoints(c);
      let dmin = Infinity;
      if (c.k === "c" || c.k === "a") dmin = Math.abs(dist(local, c.c) - c.r);
      else for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((local[0] - a[0]) * dx + (local[1] - a[1]) * dy) / l2)) : 0;
        dmin = Math.min(dmin, Math.hypot(local[0] - a[0] - t * dx, local[1] - a[1] - t * dy));
      }
      const dd = dmin * p.s;
      if (dd < tol && (!best || dd < best.d)) best = { view: vid, edge: name, curve: c, d: dd };
    }
  }
  return best;
}

export type { Ctx as RenderCtx };
