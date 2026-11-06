// Planos padrão e orientações de vista do visualizador 3D.
import type { Frame } from "../kernel/frame.ts";
import type { StdPlane, Vec3 } from "../doc/types.ts";

export const STD: Record<StdPlane, Frame> = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
};

/** Orientações padrão (Z para cima): direção da câmara para o alvo invertida, e vetor "para cima". */
export const VIEWS = {
  front: { dir: [0, -1, 0], up: [0, 0, 1], label: "Frente", key: "Ctrl+1" },
  back: { dir: [0, 1, 0], up: [0, 0, 1], label: "Trás", key: "Ctrl+2" },
  left: { dir: [-1, 0, 0], up: [0, 0, 1], label: "Esquerda", key: "Ctrl+3" },
  right: { dir: [1, 0, 0], up: [0, 0, 1], label: "Direita", key: "Ctrl+4" },
  top: { dir: [0, 0, 1], up: [0, 1, 0], label: "Topo", key: "Ctrl+5" },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0], label: "Baixo", key: "Ctrl+6" },
  iso: { dir: [1, -1, 1], up: [0, 0, 1], label: "Isométrica", key: "Ctrl+7" },
} satisfies Record<string, { dir: Vec3; up: Vec3; label: string; key: string }>;
export type ViewName = keyof typeof VIEWS;
