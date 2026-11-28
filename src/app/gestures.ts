// Reconhecedor dos gestos do botão direito (estilo «mouse gestures» do SolidWorks): 8 direções.
// Escolha documentada: só conta a partir de 25 px e dentro de ±15° de cada direção. Entre setores (ex.: 25° acima
// da horizontal) o arrasto é ambíguo e devolve null — não se corre nada, em vez de adivinhar o comando errado.
import type { GestureDir } from "./settings.ts";

export const GESTURE_MIN_PX = 25;
export const GESTURE_TOL_DEG = 15;

// por ordem de ângulo, 0° = direita, 90° = cima (y do ecrã cresce para baixo)
const BY_ANGLE: GestureDir[] = ["right", "upRight", "up", "upLeft", "left", "downLeft", "down", "downRight"];

/** Direção do gesto de `a` para `b` (pixels do ecrã), ou null se curto demais ou ambíguo. */
export function gestureDir(a: [number, number], b: [number, number]): GestureDir | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) <= GESTURE_MIN_PX) return null;
  const ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const k = Math.round(ang / 45);
  if (Math.abs(ang - k * 45) > GESTURE_TOL_DEG) return null;
  return BY_ANGLE[((k % 8) + 8) % 8];
}
