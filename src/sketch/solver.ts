// Resolução de esboços com o PlaneGCS (solver do FreeCAD, LGPL), via WebAssembly.
import { GcsWrapper, SolveStatus, Algorithm, DebugMode, init_planegcs_module, type SketchPrimitive } from "@salusoft89/planegcs";
import type { SketchConstraint, SketchEntity, SketchFeature } from "../doc/types.ts";
import { DIMENSION_TYPES } from "../doc/types.ts";
import { evalExpr, type Scope } from "../doc/expr.ts";
import { allEntities, arcSign, curveRef, isImplicit, measure } from "./geometry.ts";

let wrapper: GcsWrapper | null = null;

/** Inicializa o solver uma vez. No browser, passar o URL do .wasm. */
export async function initSolver(wasmUrl?: string): Promise<void> {
  if (wrapper) return;
  const mod = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  wrapper = new GcsWrapper(new mod.GcsSystem(), mod);
  wrapper.debug_mode = DebugMode.NoDebug;
}

export type DragTarget =
  | { kind: "point"; id: string; x: number; y: number }
  | { kind: "radius"; id: string; r: number };

export interface SolveResult {
  ok: boolean;
  /** Entidades com as posições resolvidas (sem as implícitas). */
  entities: Record<string, SketchEntity>;
  /** Graus de liberdade restantes (0 = totalmente definido). */
  dof: number;
  conflicting: string[];
  redundant: string[];
  /** Erros de avaliação de cotas (expressões), por id de restrição. */
  valueErrors: Record<string, string>;
  message?: string;
}

const kindOf = (ents: Record<string, SketchEntity>, id: string) => ents[id]?.type;

/** Converte uma restrição do documento nas primitivas do PlaneGCS. */
function toPrimitives(c: SketchConstraint, ents: Record<string, SketchEntity>, value: number | undefined): SketchPrimitive[] {
  const [a, b, c3] = c.refs;
  const ka = kindOf(ents, a), kb = kindOf(ents, b);
  const id = c.id;
  const line = (lid: string) => ents[lid] as Extract<SketchEntity, { type: "line" }>;
  const center = (cid: string) => (ents[cid] as Extract<SketchEntity, { type: "circle" | "arc" }>).c;
  const need = (ok: boolean) => { if (!ok) throw new Error(`Restrição "${c.type}" com referências inválidas`); };
  const v = () => { if (value === undefined) throw new Error("Cota sem valor"); return value; };
  const P = (o: object) => o as SketchPrimitive;

  /**
   * Distância ponto–reta com sinal: o ponto fica do lado da reta em que está agora (o `p2l_distance`
   * do PlaneGCS não tem sinal e, com valores pequenos, a geometria salta para o outro lado). Um ponto
   * auxiliar F (o pé da perpendicular) fica na reta, F→P faz ±90° com a reta e |FP| é a cota.
   * Mesmas equações livres que o `p2l_distance` (F traz 2 parâmetros e 2 equações).
   */
  const signedPointLine = (pid: string, lid: string, dist?: object): SketchPrimitive[] => {
    const d = dist ? 1 : v();
    const l = line(lid), q = ents[pid] as Extract<SketchEntity, { type: "point" }>;
    const p1 = ents[l.p1] as Extract<SketchEntity, { type: "point" }>, p2 = ents[l.p2] as Extract<SketchEntity, { type: "point" }>;
    if (Math.abs(d) < 1e-9) return [P({ id, type: "point_on_line_pl", p_id: pid, l_id: lid })];
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len2 = dx * dx + dy * dy || 1;
    const t = ((q.x - p1.x) * dx + (q.y - p1.y) * dy) / len2;
    const cross = dx * (q.y - p1.y) - dy * (q.x - p1.x);
    const side = Math.abs(cross) > 1e-9 * Math.max(1, len2) ? Math.sign(cross) : 1;
    const f = `${id}#f`;
    return [
      P({ id: f, type: "point", x: p1.x + t * dx, y: p1.y + t * dy, fixed: false }),
      P({ id: `${id}#on`, type: "point_on_line_pl", p_id: f, l_id: lid }),
      P({ id: `${id}#side`, type: "l2l_angle_pppp", l1p1_id: l.p1, l1p2_id: l.p2, l2p1_id: f, l2p2_id: pid, angle: (side * Math.PI) / 2 }),
      P({ id, type: "p2p_distance", p1_id: f, p2_id: pid, distance: dist ?? Math.abs(d) }),
    ];
  };

  /**
   * Distância com condição de arco (mín./máx. a círculos e arcos): valor = D + s1·r1 + s2·r2, com D a
   * distância entre centros (ou centro–ponto/reta). Um ponto auxiliar #d guarda D em x e D + s1·r1
   * em y; duas diferenças ligam-nos aos raios e ao valor (2 parâmetros, 2 equações: os graus de
   * liberdade são os de uma cota normal) e a cota de base usa D como parâmetro.
   */
  const arcDistance = (): SketchPrimitive[] => {
    const ra = curveRef(ents, a), rb = curveRef(ents, b), arc = c.arc!;
    const kA = kindOf(ents, ra.id), kB = kindOf(ents, rb.id);
    need((kA === "point" || kA === "line") && (kB === "point" || kB === "line") && !(kA === "line" && kB === "line"));
    const s1 = ra.curve ? arcSign(arc[0]) : 0, s2 = rb.curve ? arcSign(arc[1]) : 0;
    const val = v();
    const D0 = measure(ents, { type: "distance", refs: [ra.id, rb.id] });
    const d = `${id}#d`, X = { o_id: d, prop: "x" }, Y = { o_id: d, prop: "y" };
    // A + s·r = B
    const rel = (rid: string, A: object | number, s: number, curve: string, B: object | number) => {
      const r = { o_id: curve, prop: "radius" };
      if (s > 0) return P({ id: rid, type: "difference", param1: A, param2: B, difference: r });
      if (s < 0) return P({ id: rid, type: "difference", param1: B, param2: A, difference: r });
      return P({ id: rid, type: "difference", param1: A, param2: B, difference: 0 });
    };
    const base = kA === "point" && kB === "point"
      ? [P({ id, type: "p2p_distance", p1_id: ra.id, p2_id: rb.id, distance: X })]
      : kA === "point" ? signedPointLine(ra.id, rb.id, X) : signedPointLine(rb.id, ra.id, X);
    return [
      P({ id: d, type: "point", x: D0, y: D0 + s1 * ra.r, fixed: false }),
      rel(`${id}#d1`, X, s1, a, Y),
      rel(`${id}#d2`, Y, s2, b, val),
      ...base,
    ];
  };

  switch (c.type) {
    case "coincident": need(ka === "point" && kb === "point"); return [P({ id, type: "p2p_coincident", p1_id: a, p2_id: b })];
    case "pointOn":
      need(ka === "point");
      if (kb === "line") return [P({ id, type: "point_on_line_pl", p_id: a, l_id: b })];
      if (kb === "circle") return [P({ id, type: "point_on_circle", p_id: a, c_id: b })];
      if (kb === "arc") return [P({ id, type: "point_on_arc", p_id: a, a_id: b })];
      need(false); break;
    case "midpoint": need(ka === "point" && kb === "line"); return [P({ id, type: "p2p_symmetric_ppp", p1_id: line(b).p1, p2_id: line(b).p2, p_id: a })];
    case "horizontal":
    case "vertical": {
      const t = c.type === "horizontal" ? "horizontal" : "vertical";
      if (ka === "line" && !b) return [P({ id, type: `${t}_l`, l_id: a })];
      need(ka === "point" && kb === "point");
      return [P({ id, type: `${t}_pp`, p1_id: a, p2_id: b })];
    }
    case "parallel": need(ka === "line" && kb === "line"); return [P({ id, type: "parallel", l1_id: a, l2_id: b })];
    case "perpendicular": need(ka === "line" && kb === "line"); return [P({ id, type: "perpendicular_ll", l1_id: a, l2_id: b })];
    case "collinear":
      need(ka === "line" && kb === "line");
      return [
        P({ id: `${id}#1`, type: "point_on_line_pl", p_id: line(b).p1, l_id: a }),
        P({ id: `${id}#2`, type: "point_on_line_pl", p_id: line(b).p2, l_id: a }),
      ];
    case "tangent": {
      if (ka === "line" && kb === "circle") return [P({ id, type: "tangent_lc", l_id: a, c_id: b })];
      if (ka === "circle" && kb === "line") return [P({ id, type: "tangent_lc", l_id: b, c_id: a })];
      if (ka === "line" && kb === "arc") return [P({ id, type: "tangent_la", l_id: a, a_id: b })];
      if (ka === "arc" && kb === "line") return [P({ id, type: "tangent_la", l_id: b, a_id: a })];
      if (ka === "circle" && kb === "circle") return [P({ id, type: "tangent_cc", c1_id: a, c2_id: b })];
      if (ka === "circle" && kb === "arc") return [P({ id, type: "tangent_ca", c_id: a, a_id: b })];
      if (ka === "arc" && kb === "circle") return [P({ id, type: "tangent_ca", c_id: b, a_id: a })];
      if (ka === "arc" && kb === "arc") return [P({ id, type: "tangent_aa", a1_id: a, a2_id: b })];
      need(false); break;
    }
    case "equal": {
      if (ka === "line" && kb === "line") return [P({ id, type: "equal_length", l1_id: a, l2_id: b })];
      if (ka === "circle" && kb === "circle") return [P({ id, type: "equal_radius_cc", c1_id: a, c2_id: b })];
      if (ka === "circle" && kb === "arc") return [P({ id, type: "equal_radius_ca", c1_id: a, a2_id: b })];
      if (ka === "arc" && kb === "circle") return [P({ id, type: "equal_radius_ca", c1_id: b, a2_id: a })];
      if (ka === "arc" && kb === "arc") return [P({ id, type: "equal_radius_aa", a1_id: a, a2_id: b })];
      need(false); break;
    }
    case "concentric":
      need((ka === "circle" || ka === "arc") && (kb === "circle" || kb === "arc"));
      return [P({ id, type: "p2p_coincident", p1_id: center(a), p2_id: center(b) })];
    case "symmetric":
      need(ka === "point" && kb === "point" && kindOf(ents, c3) === "line");
      return [P({ id, type: "p2p_symmetric_ppl", p1_id: a, p2_id: b, l_id: c3 })];
    case "fix": {
      need(ka === "point");
      const p = ents[a] as Extract<SketchEntity, { type: "point" }>;
      return [P({ id: `${id}#x`, type: "coordinate_x", p_id: a, x: p.x }), P({ id: `${id}#y`, type: "coordinate_y", p_id: a, y: p.y })];
    }
    case "distance":
      if (c.arc) return arcDistance();
      if (ka === "line" && !b) return [P({ id, type: "p2p_distance", p1_id: line(a).p1, p2_id: line(a).p2, distance: v() })];
      if (ka === "point" && kb === "point") return [P({ id, type: "p2p_distance", p1_id: a, p2_id: b, distance: v() })];
      if (ka === "point" && kb === "line") return signedPointLine(a, b);
      if (ka === "line" && kb === "point") return signedPointLine(b, a);
      need(false); break;
    case "distanceX":
    case "distanceY": {
      need(ka === "point" && kb === "point");
      const prop = c.type === "distanceX" ? "x" : "y";
      return [P({ id, type: "difference", param1: { o_id: a, prop }, param2: { o_id: b, prop }, difference: v() })];
    }
    case "radius":
      if (ka === "circle") return [P({ id, type: "circle_radius", c_id: a, radius: v() })];
      if (ka === "arc") return [P({ id, type: "arc_radius", a_id: a, radius: v() })];
      need(false); break;
    case "diameter":
      if (ka === "circle") return [P({ id, type: "circle_diameter", c_id: a, diameter: v() })];
      if (ka === "arc") return [P({ id, type: "arc_diameter", a_id: a, diameter: v() })];
      need(false); break;
    case "angle":
      need(ka === "line" && kb === "line");
      if (!c.flip) return [P({ id, type: "l2l_angle_ll", l1_id: a, l2_id: b, angle: (v() * Math.PI) / 180 })];
      {
        // setor guardado: ângulo com sinal entre os sentidos invertidos (nunca salta para o suplementar)
        const la = line(a), lb = line(b), [a1, a2] = c.flip & 1 ? [la.p2, la.p1] : [la.p1, la.p2], [b1, b2] = c.flip & 2 ? [lb.p2, lb.p1] : [lb.p1, lb.p2];
        return [P({ id, type: "l2l_angle_pppp", l1p1_id: a1, l1p2_id: a2, l2p1_id: b1, l2p2_id: b2, angle: (v() * Math.PI) / 180 })];
      }
  }
  return [];
}

function geometryPrimitives(ents: Record<string, SketchEntity>): SketchPrimitive[] {
  const out: SketchPrimitive[] = [];
  const P = (o: object) => out.push(o as SketchPrimitive);
  // pontos primeiro: o PlaneGCS exige que as referências existam antes
  for (const [id, e] of Object.entries(ents)) if (e.type === "point") P({ id, type: "point", x: e.x, y: e.y, fixed: !!e.fixed });
  for (const [id, e] of Object.entries(ents)) {
    if (e.type === "line") P({ id, type: "line", p1_id: e.p1, p2_id: e.p2 });
    else if (e.type === "circle") P({ id, type: "circle", c_id: e.c, radius: e.r });
    else if (e.type === "arc") {
      P({ id, type: "arc", c_id: e.c, start_id: e.s, end_id: e.e, radius: e.r, start_angle: e.a0, end_angle: e.a1 });
      P({ id: `${id}#rules`, type: "arc_rules", a_id: id });
    }
  }
  return out;
}

const baseId = (pid: string) => pid.split("#")[0];

/** Resolve o esboço. Com `drag`, puxa um ponto/raio para a posição do rato (restrição temporária). */
export function solveSketch(sketch: Pick<SketchFeature, "entities" | "constraints">, scope: Scope = () => undefined, dragTargets?: DragTarget | DragTarget[]): SolveResult {
  const drags = dragTargets === undefined ? [] : Array.isArray(dragTargets) ? dragTargets : [dragTargets];
  if (!wrapper) throw new Error("Solver não inicializado (initSolver)");
  const g = wrapper;
  const ents = allEntities(sketch);
  const valueErrors: Record<string, string> = {};
  const prims = geometryPrimitives(ents);

  for (const c of sketch.constraints) {
    if (c.driven) continue; // cotas de referência não comandam a geometria
    let value: number | undefined;
    if (DIMENSION_TYPES.has(c.type)) {
      try {
        value = evalExpr(c.value ?? measure(ents, c), scope);
      } catch (e) {
        valueErrors[c.id] = (e as Error).message;
        continue;
      }
    }
    try {
      prims.push(...toPrimitives(c, ents, value));
    } catch (e) {
      valueErrors[c.id] = (e as Error).message;
    }
  }
  // Cota mín./máx.: o raio entra na equação; sem outra restrição o solver crescia o círculo em vez de
  // o mover. Uma restrição temporária (só usa os graus de liberdade que sobram) prefere manter o raio.
  const held = new Set<string>();
  for (const c of sketch.constraints) {
    if (c.driven || !c.arc || valueErrors[c.id]) continue;
    c.refs.forEach((rid, i) => { if (arcSign(c.arc![i]) !== 0 && (ents[rid]?.type === "circle" || ents[rid]?.type === "arc")) held.add(rid); });
  }
  for (const d of drags) if (d.kind !== "point") held.delete(d.id);
  for (const rid of held) {
    const e = ents[rid] as Extract<SketchEntity, { type: "circle" | "arc" }>, t = e.type;
    prims.push({ id: `#holdr:${rid}`, type: t === "arc" ? "arc_radius" : "circle_radius", [t === "arc" ? "a_id" : "c_id"]: rid, radius: e.r, temporary: true } as unknown as SketchPrimitive);
  }
  drags.forEach((drag, k) => {
    if (drag.kind === "point") {
      prims.push({ id: `#dragx${k}`, type: "coordinate_x", p_id: drag.id, x: drag.x, temporary: true } as SketchPrimitive);
      prims.push({ id: `#dragy${k}`, type: "coordinate_y", p_id: drag.id, y: drag.y, temporary: true } as SketchPrimitive);
    } else {
      const t = ents[drag.id]?.type;
      prims.push({ id: `#dragr${k}`, type: t === "arc" ? "arc_radius" : "circle_radius", [t === "arc" ? "a_id" : "c_id"]: drag.id, radius: drag.r, temporary: true } as unknown as SketchPrimitive);
    }
  });

  g.clear_data();
  g.push_primitives_and_params(prims);
  const status = g.solve(Algorithm.DogLeg);
  const conflicting = [...new Set(g.get_gcs_conflicting_constraints().map(baseId))];
  const redundant = [...new Set(g.get_gcs_redundant_constraints().map(baseId))];
  const ok = (status === SolveStatus.Success || status === SolveStatus.Converged) && conflicting.length === 0;
  if (ok) g.apply_solution();
  const dof = g.gcs.dof();

  const solved: Record<string, SketchEntity> = {};
  const byId = new Map(g.sketch_index.get_primitives().map((p) => [p.id, p as unknown as Record<string, number>]));
  for (const [id, e] of Object.entries(sketch.entities)) {
    const p = byId.get(id);
    if (!ok || !p) { solved[id] = e; continue; }
    if (e.type === "point") solved[id] = { ...e, x: p.x, y: p.y };
    else if (e.type === "circle") solved[id] = { ...e, r: p.radius };
    else if (e.type === "arc") solved[id] = { ...e, r: p.radius, a0: p.start_angle, a1: p.end_angle };
    else solved[id] = e;
  }
  return {
    ok,
    entities: solved,
    dof: drags.length ? -1 : dof,
    conflicting,
    redundant,
    valueErrors,
    message: ok ? undefined : conflicting.length ? "Restrições em conflito" : "O solver não convergiu",
  };
}

/**
 * Entidades sub-definidas (ainda se podem mover), por teste de perturbação:
 * puxa cada ponto (e cada raio) ligeiramente e verifica se se move.
 */
export function freeEntities(sketch: Pick<SketchFeature, "entities" | "constraints">, scope: Scope = () => undefined): Set<string> {
  const free = new Set<string>();
  const ents = sketch.entities;
  const span = Math.max(1, ...Object.values(ents).flatMap((e) => (e.type === "point" ? [Math.abs(e.x), Math.abs(e.y)] : [])));
  const d = span * 1e-3;
  for (const [id, e] of Object.entries(ents)) {
    if (e.type === "point") {
      const r = solveSketch(sketch, scope, { kind: "point", id, x: e.x + d, y: e.y + d });
      const q = r.entities[id] as typeof e;
      if (r.ok && Math.hypot(q.x - e.x, q.y - e.y) > d * 0.05) free.add(id);
    } else if (e.type === "circle" || e.type === "arc") {
      const r = solveSketch(sketch, scope, { kind: "radius", id, r: e.r + d });
      const q = r.entities[id] as typeof e;
      if (r.ok && Math.abs(q.r - e.r) > d * 0.05) free.add(id);
    }
  }
  // uma curva é livre se algum dos seus pontos (ou o raio) for livre
  for (const [id, e] of Object.entries(ents)) {
    if (e.type === "line" && (free.has(e.p1) || free.has(e.p2))) free.add(id);
    if ((e.type === "circle" || e.type === "arc") && free.has(e.c)) free.add(id);
    if (e.type === "arc" && (free.has(e.s) || free.has(e.e))) free.add(id);
    if (e.type === "spline" && e.pts.some((p) => free.has(p))) free.add(id);
  }
  for (const id of [...free]) if (isImplicit(id)) free.delete(id);
  return free;
}

/**
 * Estado do esboço, como as cores do SolidWorks:
 * `under` azul (sub-definido), `defined` preto (totalmente definido),
 * `over` vermelho (sobredefinido: há restrições a mais, mesmo que coerentes),
 * `unsolved` amarelo (não resolve: restrições contraditórias ou o solver não converge).
 */
export type SketchState = "under" | "defined" | "over" | "unsolved";

export function sketchState(r: SolveResult | null): SketchState {
  if (!r) return "under";
  if (!r.ok) return "unsolved";
  if (r.redundant.length) return "over";
  return r.dof === 0 ? "defined" : "under";
}

/** Restrições a mostrar no painel de conflitos: as contraditórias, senão as redundantes. */
export function problemConstraints(r: SolveResult | null): string[] {
  if (!r) return [];
  return r.conflicting.length ? r.conflicting : r.redundant;
}

/**
 * Resolve uma alteração que acabou de criar/editar a cota `dimId`. Como o SolidWorks, se a cota
 * sobredefinir o esboço (contradiz as outras, ou é redundante com elas), passa a cota de referência
 * (conduzida: mostra o valor entre parênteses e não comanda). `prevRedundant` são as redundâncias
 * que já existiam antes, para não culpar a cota nova por problemas antigos.
 */
export function solveWithDrivenFallback(
  next: Pick<SketchFeature, "entities" | "constraints">, dimId: string, scope: Scope = () => undefined, prevRedundant: readonly string[] = [],
): { r: SolveResult; next: Pick<SketchFeature, "entities" | "constraints">; driven: boolean } {
  const r = solveSketch(next, scope);
  const c = next.constraints.find((k) => k.id === dimId);
  const overDefines = !r.ok || r.redundant.includes(dimId) || r.redundant.some((id) => !prevRedundant.includes(id));
  if (!c || c.driven || !DIMENSION_TYPES.has(c.type) || !overDefines) return { r, next, driven: false };
  const alt = { ...next, constraints: next.constraints.map((k) => (k.id === dimId ? { ...k, driven: true } : k)) };
  const r2 = solveSketch(alt, scope);
  // só fica conduzida se isso resolver de facto (senão devolve o resultado original, para ser recusado/mostrado)
  const better = r2.ok && (!r.ok || r2.redundant.length < r.redundant.length);
  return better ? { r: r2, next: alt, driven: true } : { r, next, driven: false };
}
