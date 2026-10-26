// Operações de edição de esboços (puras: devolvem um esboço novo). Usadas pelo editor e testáveis em Node.
import type { ConstraintType, Expr, SketchConstraint, SketchEntity, SketchFeature } from "../doc/types.ts";
import { DIMENSION_TYPES } from "../doc/types.ts";
import { type P2, allEntities, entityPoints, isImplicit, measure } from "./geometry.ts";

export type SketchData = Pick<SketchFeature, "entities" | "constraints">;

/** Gerador de ids curtos únicos no esboço, por prefixo (p, l, c, a, s, k). */
export function newId(s: SketchData, prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of [...Object.keys(s.entities), ...s.constraints.map((c) => c.id)]) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

const clone = (s: SketchData): SketchData => ({ entities: { ...s.entities }, constraints: s.constraints.slice() });

export function addPoint(s: SketchData, p: P2, construction = false): { s: SketchData; id: string } {
  const n = clone(s);
  const id = newId(n, "p");
  n.entities[id] = { type: "point", x: p[0], y: p[1], ...(construction ? { construction } : {}) };
  return { s: n, id };
}

export function addEntity(s: SketchData, prefix: string, e: SketchEntity): { s: SketchData; id: string } {
  const n = clone(s);
  const id = newId(n, prefix);
  n.entities[id] = e;
  return { s: n, id };
}

export function addConstraint(s: SketchData, type: ConstraintType, refs: string[], value?: Expr, extra: Partial<SketchConstraint> = {}): { s: SketchData; id: string } {
  const n = clone(s);
  // evitar duplicados exatos
  const dup = n.constraints.find((c) => c.type === type && c.refs.join() === refs.join() && !DIMENSION_TYPES.has(type));
  if (dup) return { s: n, id: dup.id };
  const id = newId(n, "k");
  n.constraints.push({ id, type, refs, ...(value !== undefined ? { value } : {}), ...extra });
  return { s: n, id };
}

/** Linha entre dois pontos existentes (ou novos), com relação horizontal/vertical automática. */
export function addLine(s: SketchData, a: string, b: string, opts: { construction?: boolean; infer?: boolean } = {}): { s: SketchData; id: string } {
  let r = addEntity(s, "l", { type: "line", p1: a, p2: b, ...(opts.construction ? { construction: true } : {}) });
  const id = r.id;
  if (opts.infer !== false) {
    const ents = allEntities(r.s);
    const pa = ents[a] as { x: number; y: number }, pb = ents[b] as { x: number; y: number };
    const ang = Math.abs((Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI);
    if (ang < 2 || ang > 178) r = addConstraint(r.s, "horizontal", [id]);
    else if (Math.abs(ang - 90) < 2) r = addConstraint(r.s, "vertical", [id]);
  }
  return { s: r.s, id };
}

/** Retângulo por dois cantos: 4 linhas que partilham os cantos, 2 horizontais e 2 verticais. */
export function addRectangle(s: SketchData, c1: P2, c2: P2, firstCorner?: string): { s: SketchData; lines: string[]; points: string[] } {
  let cur = s;
  const corners: P2[] = [c1, [c2[0], c1[1]], c2, [c1[0], c2[1]]];
  const pts: string[] = [];
  corners.forEach((c, i) => {
    if (i === 0 && firstCorner) { pts.push(firstCorner); return; }
    const r = addPoint(cur, c);
    cur = r.s;
    pts.push(r.id);
  });
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = addLine(cur, pts[i], pts[(i + 1) % 4], { infer: false });
    cur = r.s;
    lines.push(r.id);
  }
  cur = addConstraint(cur, "horizontal", [lines[0]]).s;
  cur = addConstraint(cur, "horizontal", [lines[2]]).s;
  cur = addConstraint(cur, "vertical", [lines[1]]).s;
  cur = addConstraint(cur, "vertical", [lines[3]]).s;
  return { s: cur, lines, points: pts };
}

export function addCircle(s: SketchData, center: string, r: number): { s: SketchData; id: string } {
  return addEntity(s, "c", { type: "circle", c: center, r });
}

/** Arco pelo centro e dois pontos, no sentido anti-horário de `start` para `end` (o raio é o do início). */
export function addArc(s: SketchData, center: string, start: P2, end: P2, ccw = true): { s: SketchData; id: string } {
  const ents = allEntities(s);
  const c = ents[center] as { x: number; y: number };
  const r = Math.hypot(start[0] - c.x, start[1] - c.y);
  let a0 = Math.atan2(start[1] - c.y, start[0] - c.x);
  let a1 = Math.atan2(end[1] - c.y, end[0] - c.x);
  if (!ccw) [a0, a1] = [a1, a0];
  const ps: P2 = [c.x + r * Math.cos(a0), c.y + r * Math.sin(a0)];
  const pe: P2 = [c.x + r * Math.cos(a1), c.y + r * Math.sin(a1)];
  let cur = addPoint(s, ps);
  const sid = cur.id;
  cur = addPoint(cur.s, pe);
  const eid = cur.id;
  return addEntity(cur.s, "a", { type: "arc", c: center, s: sid, e: eid, r, a0, a1 });
}

/** Ids de entidades que referem um ponto. */
const usersOf = (ents: Record<string, SketchEntity>, pid: string) => Object.entries(ents).filter(([, e]) => entityPoints(e).includes(pid)).map(([id]) => id);

/**
 * Apaga entidades e restrições. Apagar uma curva apaga também os seus pontos que deixem de ser usados;
 * restrições que refiram entidades apagadas também desaparecem.
 */
export function deleteItems(s: SketchData, ids: string[]): SketchData {
  const n = clone(s);
  const gone = new Set<string>();
  const constraintIds = new Set(n.constraints.map((c) => c.id));
  for (const id of ids) {
    if (constraintIds.has(id)) { n.constraints = n.constraints.filter((c) => c.id !== id); continue; }
    if (isImplicit(id) || !n.entities[id]) continue;
    const e = n.entities[id];
    gone.add(id);
    delete n.entities[id];
    if (e.type === "point") {
      // apagar um ponto apaga as curvas que dele dependem
      for (const u of usersOf(n.entities, id)) { gone.add(u); delete n.entities[u]; }
    }
  }
  // pontos órfãos de curvas apagadas (que não sejam pontos isolados intencionais)
  for (const id of [...gone]) {
    const e = s.entities[id];
    if (!e || e.type === "point") continue;
    for (const p of entityPoints(e)) {
      if (!n.entities[p]) continue;
      if (usersOf(n.entities, p).length === 0) { gone.add(p); delete n.entities[p]; }
    }
  }
  n.constraints = n.constraints.filter((c) => !c.refs.some((r) => gone.has(r)));
  return n;
}

export function toggleConstruction(s: SketchData, ids: string[]): SketchData {
  const n = clone(s);
  const curves = ids.filter((id) => n.entities[id] && n.entities[id].type !== "point");
  const on = curves.some((id) => !n.entities[id].construction);
  for (const id of curves) n.entities[id] = { ...n.entities[id], construction: on || undefined };
  return n;
}

/** Junta dois pontos num só (substitui `drop` por `keep` em todas as entidades e restrições). */
export function mergePoints(s: SketchData, keep: string, drop: string): SketchData {
  if (keep === drop || isImplicit(drop)) return s;
  const n = clone(s);
  const swap = (x: string) => (x === drop ? keep : x);
  for (const [id, e] of Object.entries(n.entities)) {
    if (e.type === "line") n.entities[id] = { ...e, p1: swap(e.p1), p2: swap(e.p2) };
    else if (e.type === "circle") n.entities[id] = { ...e, c: swap(e.c) };
    else if (e.type === "arc") n.entities[id] = { ...e, c: swap(e.c), s: swap(e.s), e: swap(e.e) };
    else if (e.type === "spline") n.entities[id] = { ...e, pts: e.pts.map(swap) };
  }
  delete n.entities[drop];
  n.constraints = n.constraints.map((c) => ({ ...c, refs: c.refs.map(swap) })).filter((c) => !(c.type === "coincident" && c.refs[0] === c.refs[1]));
  return n;
}

// ---------------------------------------------------------------------------
// Restrições a partir da seleção
// ---------------------------------------------------------------------------

type Kind = SketchEntity["type"];
const kinds = (s: SketchData, ids: string[]) => { const e = allEntities(s); return ids.map((id) => e[id]?.type as Kind | undefined); };
const isCurve = (k?: Kind) => k === "circle" || k === "arc";

/** Restrições aplicáveis à seleção atual (para ativar os botões). */
export function applicableConstraints(s: SketchData, sel: string[]): ConstraintType[] {
  const k = kinds(s, sel);
  const n = sel.length;
  const all = (t: Kind) => k.every((x) => x === t);
  const out: ConstraintType[] = [];
  if (n === 2 && all("point")) out.push("coincident", "horizontal", "vertical");
  if (n === 2 && k.includes("point") && (k.includes("line") || k.includes("circle") || k.includes("arc"))) out.push("pointOn");
  if (n === 2 && k.includes("point") && k.includes("line")) out.push("midpoint");
  if (n >= 1 && all("line")) out.push("horizontal", "vertical");
  if (n === 2 && all("line")) out.push("parallel", "perpendicular", "collinear", "equal");
  if (n >= 2 && all("line")) out.push("equal");
  if (n === 2 && ((k.includes("line") && k.some(isCurve)) || k.every(isCurve))) out.push("tangent");
  if (n >= 2 && k.every(isCurve)) out.push("equal", "concentric");
  if (n === 3 && k.filter((x) => x === "point").length === 2 && k.includes("line")) out.push("symmetric");
  if (n >= 1 && all("point")) out.push("fix");
  return [...new Set(out)];
}

/** Aplica uma restrição geométrica à seleção. */
export function applyConstraint(s: SketchData, type: ConstraintType, sel: string[]): SketchData {
  const k = kinds(s, sel);
  let cur = s;
  const add = (t: ConstraintType, refs: string[]) => { cur = addConstraint(cur, t, refs).s; };
  const pointFirst = () => { const i = k.indexOf("point"); return [sel[i], ...sel.filter((_, j) => j !== i)]; };
  switch (type) {
    case "horizontal":
    case "vertical":
      if (k.every((x) => x === "line")) sel.forEach((id) => add(type, [id]));
      else add(type, sel);
      break;
    case "equal":
      for (let i = 1; i < sel.length; i++) add(type, [sel[0], sel[i]]);
      break;
    case "concentric":
      for (let i = 1; i < sel.length; i++) add(type, [sel[0], sel[i]]);
      break;
    case "fix": sel.forEach((id) => add("fix", [id])); break;
    case "pointOn":
    case "midpoint": add(type, pointFirst()); break;
    case "symmetric": {
      const pts = sel.filter((_, i) => k[i] === "point");
      const line = sel[k.indexOf("line")];
      add(type, [...pts, line]);
      break;
    }
    case "coincident": {
      // juntar os pontos é mais limpo do que uma restrição de coincidência; os implícitos (origem) ficam
      const [keep, drop] = isImplicit(sel[1]) ? [sel[1], sel[0]] : [sel[0], sel[1]];
      return isImplicit(drop) ? cur : mergePoints(cur, keep, drop);
    }
    default: add(type, sel);
  }
  return cur;
}

/** Cota inteligente: escolhe o tipo de cota pelos elementos selecionados. Valor = medida atual. */
export function smartDimension(s: SketchData, sel: string[], mode: "auto" | "horizontal" | "vertical" = "auto"): { type: ConstraintType; refs: string[] } | null {
  const k = kinds(s, sel);
  const ents = allEntities(s);
  // só eixos/origem: nada para cotar (são fixos)
  if (sel.every((id) => isImplicit(id))) return null;
  if (sel.length === 1 && k[0] === "line") {
    const l = ents[sel[0]] as Extract<SketchEntity, { type: "line" }>;
    if (mode === "horizontal") return signed(s, "distanceX", [l.p1, l.p2]);
    if (mode === "vertical") return signed(s, "distanceY", [l.p1, l.p2]);
    return { type: "distance", refs: [sel[0]] };
  }
  if (sel.length === 1 && k[0] === "circle") return { type: "diameter", refs: sel };
  if (sel.length === 1 && k[0] === "arc") return { type: "radius", refs: sel };
  if (sel.length === 2 && k.every((x) => x === "point")) {
    if (mode === "horizontal") return signed(s, "distanceX", sel);
    if (mode === "vertical") return signed(s, "distanceY", sel);
    return { type: "distance", refs: sel };
  }
  if (sel.length === 2 && k.includes("point") && k.includes("line")) {
    const i = k.indexOf("point");
    return { type: "distance", refs: [sel[i], sel[1 - i]] };
  }
  if (sel.length === 2 && k.every((x) => x === "line")) {
    const ang = measure(ents, { type: "angle", refs: sel });
    if (Math.abs(Math.sin((ang * Math.PI) / 180)) < 1e-6) {
      // paralelas: distância de um extremo de uma à outra
      const l2 = ents[sel[1]] as Extract<SketchEntity, { type: "line" }>;
      return { type: "distance", refs: [l2.p1, sel[0]] };
    }
    return ang >= 0 ? { type: "angle", refs: sel } : { type: "angle", refs: [sel[1], sel[0]] };
  }
  return null;
}

/** Cotas X/Y com sinal: ordenar as referências para que o valor seja positivo. */
function signed(s: SketchData, type: "distanceX" | "distanceY", refs: string[]) {
  const v = measure(allEntities(s), { type, refs });
  return v >= 0 ? { type, refs } : { type, refs: [refs[1], refs[0]] };
}

export const roundDim = (v: number) => Math.round(v * 1000) / 1000;

/** Rótulos curtos das restrições geométricas (glifos no esboço). */
export const CONSTRAINT_GLYPH: Partial<Record<ConstraintType, string>> = {
  horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "⋯", tangent: "T",
  equal: "=", concentric: "◎", midpoint: "M", symmetric: "S", fix: "⚓", pointOn: "∈", coincident: "•",
};

export const CONSTRAINT_LABEL: Record<ConstraintType, string> = {
  coincident: "Coincidente", pointOn: "Ponto em", midpoint: "Ponto médio", horizontal: "Horizontal", vertical: "Vertical",
  parallel: "Paralela", perpendicular: "Perpendicular", collinear: "Colinear", tangent: "Tangente", equal: "Igual",
  concentric: "Concêntrica", symmetric: "Simétrica", fix: "Fixar", distance: "Distância", distanceX: "Distância horizontal",
  distanceY: "Distância vertical", radius: "Raio", diameter: "Diâmetro", angle: "Ângulo",
};
