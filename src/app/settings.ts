// Preferências do utilizador (por browser). Valores por defeito ao estilo do SolidWorks.
export type GestureDir = "up" | "upRight" | "right" | "downRight" | "down" | "downLeft" | "left" | "upLeft";

export interface Settings {
  /** Inverter o sentido do zoom da roda (por defeito: roda para a frente = afastar, como no SolidWorks). */
  reverseWheel: boolean;
  /** Passo de rotação das setas (graus); Shift+setas = 90°. */
  arrowStep: number;
  /** Comandos dos gestos do rato (arrastar com o botão direito). */
  gestures: Record<GestureDir, string>;
  /** Estilo de visualização. */
  displayStyle: "shadedEdges" | "shaded" | "wireframe";
  showPlanes: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  reverseWheel: false,
  arrowStep: 15,
  gestures: {
    up: "view.top", down: "view.front", left: "view.left", right: "view.right",
    upLeft: "view.normal", upRight: "view.iso", downLeft: "sketch.new", downRight: "view.fit",
  },
  displayStyle: "shadedEdges",
  showPlanes: false,
};

const KEY = "cad-prototipo:settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...s, gestures: { ...DEFAULT_SETTINGS.gestures, ...s.gestures } };
    }
  } catch { /* sem armazenamento */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignorar */ }
}
