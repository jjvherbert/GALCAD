// Resolução de esboços com o PlaneGCS (solver do FreeCAD, LGPL), via WebAssembly.
import { GcsWrapper, SolveStatus, Algorithm, DebugMode, init_planegcs_module, type SketchPrimitive } from "@salusoft89/planegcs";
import type { SketchConstraint, SketchEntity, SketchFeature } from "../doc/types.ts";
import { DIMENSION_TYPES } from "../doc/types.ts";
import { evalExpr, type Scope } from "../doc/expr.ts";
import { allEntities, isImplicit, measure } from "./geometry.ts";

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
      if (ka === "line" && !b) return [P({ id, type: "p2p_distance", p1_id: line(a).p1, p2_id: line(a).p2, distance: v() })];
      if (ka === "point" && kb === "point") return [P({ id, type: "p2p_distance", p1_id: a, p2_id: b, distance: v() })];
      if (ka === "point" && kb === "line") return [P({ id, type: "p2l_distance", p_id: a, l_id: b, distance: v() })];
      if (ka === "line" && kb === "point") return [P({ id, type: "p2l_distance", p_id: b, l_id: a, distance: v() })];
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
      return [P({ id, type: "l2l_angle_ll", l1_id: a, l2_id: b, angle: (v() * Math.PI) / 180 })];
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
