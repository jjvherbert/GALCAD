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
  /** Tema da interface; «system» segue o sistema operativo. */
  theme: "light" | "dark" | "system";
  /** Quadrícula de fundo no esboço. */
  sketchGrid: boolean;
  /** Limite por tentativa de malha (s). */
  meshTimeout: number;
  /** Limite de cada passo do solver (s). */
  solveTimeout: number;
  /** Limite sem resposta do núcleo geométrico (s); passado esse tempo, o núcleo é reiniciado. */
  kernelTimeout: number;
  /** Endereço do agente de solvers (só no browser; o token nunca é guardado). */
  agentUrl: string;
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
  theme: "system",
  sketchGrid: false,
  meshTimeout: 120,
  solveTimeout: 3600,
  kernelTimeout: 300,
  agentUrl: "http://127.0.0.1:8765",
};

const KEY = "cad-prototipo:settings";

/** Limites aceites para os campos numéricos (os mesmos do diálogo). */
export const LIMITS = {
  arrowStep: [1, 90],
  meshTimeout: [10, 7200],
  solveTimeout: [60, 7 * 24 * 3600],
  kernelTimeout: [30, 3600],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** Junta o que veio do armazenamento com os valores por defeito, descartando valores inválidos. */
export function sanitizeSettings(s: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  const pick = <T,>(v: unknown, ok: readonly T[], dflt: T): T => (ok.includes(v as T) ? (v as T) : dflt);
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const gestures = { ...d.gestures };
  if (s.gestures && typeof s.gestures === "object")
    for (const k of Object.keys(gestures) as GestureDir[]) if (typeof s.gestures[k] === "string") gestures[k] = s.gestures[k];
  return {
    reverseWheel: bool(s.reverseWheel, d.reverseWheel),
    arrowStep: clamp(s.arrowStep, LIMITS.arrowStep, d.arrowStep),
    gestures,
    displayStyle: pick(s.displayStyle, ["shadedEdges", "shaded", "wireframe"] as const, d.displayStyle),
    showPlanes: bool(s.showPlanes, d.showPlanes),
    theme: pick(s.theme, ["light", "dark", "system"] as const, d.theme),
    sketchGrid: bool(s.sketchGrid, d.sketchGrid),
    meshTimeout: clamp(s.meshTimeout, LIMITS.meshTimeout, d.meshTimeout),
    solveTimeout: clamp(s.solveTimeout, LIMITS.solveTimeout, d.solveTimeout),
    kernelTimeout: clamp(s.kernelTimeout, LIMITS.kernelTimeout, d.kernelTimeout),
    agentUrl: typeof s.agentUrl === "string" && /^https?:\/\/\S+$/.test(s.agentUrl) ? s.agentUrl : d.agentUrl,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch { /* sem armazenamento */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignorar */ }
}
