// Modelo de documento: tipos de base (expressões, variáveis, vetores) e referências topológicas.

/** Massa volúmica por defeito, g/cm³ (aço). Aqui e não em project.ts para o núcleo não importar a validação (zod). */
export const DEFAULT_DENSITY = 7.85;

/** Valor numérico ou expressão (ex.: "L/2", "2*Espessura + 1", "30 deg"). */
export type Expr = number | string;

export interface Variable {
  name: string;
  expr: string;
  comment?: string;
}

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// Referências
// ---------------------------------------------------------------------------

/** Pista geométrica guardada no momento da seleção, usada só como recurso quando o nome deixa de existir. */
export interface GeoHint {
  c: Vec3; // centroide
  n?: Vec3; // normal (faces planas) ou direção (arestas retas)
}

/** Referência persistente a uma face ou aresta, pelo nome topológico gerado pelo histórico. */
export interface TopoRef {
  kind: "face" | "edge";
  name: string;
  hint?: GeoHint;
}

export type StdPlane = "XY" | "XZ" | "YZ";
export type StdAxis = "X" | "Y" | "Z";

export type PlaneRef =
  | { kind: "std"; name: StdPlane }
  | { kind: "datum"; feature: string } // plano de referência
  | { kind: "csys"; feature: string; name: StdPlane } // plano de um sistema de coordenadas
  | { kind: "face"; ref: TopoRef }; // face plana do modelo

export type AxisRef =
  | { kind: "std"; name: StdAxis }
  | { kind: "datum"; feature: string } // eixo de referência
  | { kind: "csys"; feature: string; name: StdAxis }
  | { kind: "edge"; ref: TopoRef } // aresta reta ou circular (eixo do círculo)
  | { kind: "sketchLine"; sketch: string; entity: string }; // linha de um esboço (normalmente de construção)
