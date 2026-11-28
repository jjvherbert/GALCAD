// Setas das cargas na vista 3D (C1c): o que desenhar por cada carga estrutural, já avaliado. Puro (sem
// three.js nem store) para se poder testar; o desenho fica em `viewport-loads.ts`.
import { type FemStudy, loadEdges, loadFaces } from "../doc/study.ts";
import { evalExpr, type Scope } from "../doc/expr.ts";
import { csysAxes, csysToGlobal, type V3 } from "../sim/case.ts";

export type GlyphKind = "force" | "pointForce" | "coupling" | "pressure" | "gravity";

export interface LoadGlyph {
  kind: GlyphKind;
  /** Índice da condição em `study.loads` (o rótulo é «C<index+1>»). */
  index: number;
  color: number;
  /** Faces (chaves do 3D) e arestas onde a carga se distribui; vazias nas cargas num ponto. */
  faces: string[];
  edges: string[];
  /** Ponto de aplicação (mm), nas cargas concentradas e no acoplamento. */
  point?: V3;
  /** Direção e intensidade (N ou mm/s²), nas globais; a pressão usa `p`. */
  vec?: V3;
  /** Pressão (MPa), positiva a empurrar contra a face. */
  p?: number;
  /** Intensidade (|f| N, |p| MPa ou |g| mm/s²). */
  mag: number;
  /** Comprimento relativo da seta (0.25..1) face à maior carga da mesma grandeza. */
  scale: number;
}

/** Cores por carga (com uma só carga usa-se a cor do tipo, a mesma das faces). */
export const GLYPH_PALETTE = [0xf59e0b, 0x7c3aed, 0x0891b2, 0x16a34a, 0xdb2777, 0x92400e, 0x2563eb, 0x65a30d];
const TYPE_COLOR: Record<GlyphKind, number> = { force: 0xf59e0b, pointForce: 0xf59e0b, coupling: 0xdb2777, pressure: 0xdc2626, gravity: 0xf59e0b };

/** Grandeza física (as setas só se comparam dentro da mesma). */
export const glyphQuantity = (k: GlyphKind) => (k === "pressure" ? "p" : k === "gravity" ? "g" : "f");

const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);

/**
 * Setas das cargas estruturais do estudo. As expressões avaliam-se com `scope`; uma carga que não se
 * consegue avaliar (variável em falta, referencial degenerado) ou nula fica sem seta.
 * `key` converte o nome da face na chave do 3D (montagens: "caminho|face").
 */
export function loadGlyphs(s: FemStudy, scope: Scope, key: (name: string) => string = (n) => n): LoadGlyph[] {
  const ev3 = (e: readonly (number | string)[]) => e.map((x) => evalExpr(x, scope)) as V3;
  const out: Omit<LoadGlyph, "color" | "scale">[] = [];
  s.loads.forEach((l, index) => {
    try {
      const faces = () => loadFaces(s, l).map((f) => key(f.name));
      const edges = () => loadEdges(s, l).map((e) => e.name);
      switch (l.kind) {
        case "force": {
          let f = ev3(l.f);
          if (l.csys) {
            const ax = csysAxes({ type: l.csys.type, a: ev3(l.csys.a), b: ev3(l.csys.b) });
            if (!ax) return;
            f = csysToGlobal(ax, f);
          }
          out.push({ kind: "force", index, faces: faces(), edges: edges(), vec: f, mag: len(f) });
          break;
        }
        case "pointForce": {
          const f = ev3(l.f);
          out.push({ kind: "pointForce", index, faces: [], edges: [], point: ev3(l.point), vec: f, mag: len(f) });
          break;
        }
        case "coupling": {
          if (!l.f) return;
          const f = ev3(l.f);
          out.push({ kind: "coupling", index, faces: [], edges: [], point: ev3(l.point), vec: f, mag: len(f) });
          break;
        }
        case "pressure": {
          const p = evalExpr(l.p, scope);
          out.push({ kind: "pressure", index, faces: faces(), edges: [], p, mag: Math.abs(p) });
          break;
        }
        case "gravity": {
          const g = ev3(l.g);
          out.push({ kind: "gravity", index, faces: [], edges: [], vec: g, mag: len(g) });
          break;
        }
      }
    } catch {
      /* expressão por avaliar: sem seta (o Verificar aponta o erro) */
    }
  });
  const shown = out.filter((g) => g.mag > 0 && Number.isFinite(g.mag));
  const max = new Map<string, number>();
  for (const g of shown) max.set(glyphQuantity(g.kind), Math.max(max.get(glyphQuantity(g.kind)) ?? 0, g.mag));
  return shown.map((g, i) => ({
    ...g,
    color: shown.length === 1 ? TYPE_COLOR[g.kind] : GLYPH_PALETTE[i % GLYPH_PALETTE.length],
    scale: Math.max(0.25, g.mag / max.get(glyphQuantity(g.kind))!),
  }));
}

const fmt = (x: number) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-2 && x !== 0) ? x.toExponential(2) : String(+x.toPrecision(3)));

/** Intensidade com unidades, para a legenda (gravidade em m/s²). */
export function glyphMagnitude(g: Pick<LoadGlyph, "kind" | "mag" | "p">): string {
  if (g.kind === "pressure") return `${fmt(g.p ?? g.mag)} MPa`;
  if (g.kind === "gravity") return `${fmt(g.mag / 1000)} m/s²`;
  return `${fmt(g.mag)} N`;
}

export const GLYPH_LABELS: Record<GlyphKind, string> = { force: "Força", pointForce: "Força pontual", coupling: "Acoplamento", pressure: "Pressão", gravity: "Gravidade" };
