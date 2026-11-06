// Tipos e constantes do editor de esboço 2D.
import type { ConstraintType } from "../doc/types.ts";
import type { P2 } from "../sketch/geometry.ts";

export type Tool = "select" | "line" | "rect" | "circle" | "arc" | "spline" | "point" | "dim" | "trim" | "extend" | "skfillet" | "offset" | "convert";
export type DimMode = "auto" | "horizontal" | "vertical";

export type Draw =
  | { kind: "line"; start: string; first: string; created: boolean }
  | { kind: "rect"; c1: P2; c1Id?: string }
  | { kind: "circle"; center: string }
  | { kind: "arc"; center: string; start?: P2; startId?: string; acc: number; last?: number }
  | { kind: "spline"; pts: string[] }
  | { kind: "dim"; picks: string[] };

export interface Snap { p: P2; id?: string; on?: string }

export const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "Selecionar", key: "Esc", icon: "↖" },
  { id: "line", label: "Linha", key: "L", icon: "╱" },
  { id: "rect", label: "Retângulo", key: "R", icon: "▭" },
  { id: "circle", label: "Círculo", key: "C", icon: "◯" },
  { id: "arc", label: "Arco (centro)", key: "A", icon: "◠" },
  { id: "spline", label: "Spline", key: "S", icon: "∿" },
  { id: "point", label: "Ponto", key: "P", icon: "·" },
  { id: "dim", label: "Cota inteligente", key: "D", icon: "↔" },
  { id: "trim", label: "Aparar", key: "T", icon: "✂" },
  { id: "extend", label: "Estender", key: "E", icon: "⟶" },
  { id: "skfillet", label: "Filete de canto", key: "G", icon: "◟" },
  { id: "offset", label: "Deslocar", key: "O", icon: "⧈" },
  { id: "convert", label: "Converter arestas", key: "K", icon: "⇲" },
];

export const GEOM_CONSTRAINTS: ConstraintType[] = ["coincident", "pointOn", "midpoint", "horizontal", "vertical", "parallel", "perpendicular", "collinear", "tangent", "equal", "concentric", "symmetric", "fix"];

export const fmt = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 3 });
