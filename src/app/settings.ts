// Preferências do utilizador (por browser). Valores por defeito ao estilo do SolidWorks.
import type { PluginFlags } from "../plugins/registry.ts";

export type GestureDir = "up" | "upRight" | "right" | "downRight" | "down" | "downLeft" | "left" | "upLeft";
/** Onde o gesto é feito: na vista 3D (Design), no esboço ou na bancada FEM. Cada contexto tem os seus 8 comandos. */
export type GestureContext = "3d" | "sketch" | "fem";
export const GESTURE_DIRS: GestureDir[] = ["up", "upRight", "right", "downRight", "down", "downLeft", "left", "upLeft"];
export const GESTURE_CONTEXTS: GestureContext[] = ["3d", "sketch", "fem"];

export interface Settings {
  /** Inverter o sentido do zoom da roda (por defeito: roda para a frente = afastar, como no SolidWorks). */
  reverseWheel: boolean;
  /** Passo de rotação das setas (graus); Shift+setas = 90°. */
  arrowStep: number;
  /** Comandos dos gestos do rato (arrastar com o botão direito), por contexto. No esboço, `sk:<ferramenta>` ativa
   *  uma ferramenta do esboço e `sk:exit` sai do esboço; nos outros contextos são ids de comandos. */
  gestures: Record<GestureContext, Record<GestureDir, string>>;
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
  /** Cartão «O que faz» dos comandos aberto (global; por defeito fechado). */
  helpExpanded: boolean;
  /** Plugins opcionais (por defeito desligados). */
  plugins: PluginFlags;
}

export const DEFAULT_SETTINGS: Settings = {
  reverseWheel: false,
  arrowStep: 15,
  gestures: {
    "3d": {
      up: "view.top", down: "view.front", left: "view.left", right: "view.right",
      upLeft: "view.normal", upRight: "view.iso", downLeft: "sketch.new", downRight: "view.fit",
    },
    sketch: {
      up: "sk:dim", left: "sk:line", right: "sk:circle", down: "sk:rect",
      upLeft: "sk:arc", upRight: "sk:point", downLeft: "sk:trim", downRight: "sk:exit",
    },
    fem: {
      up: "sim.add.force", down: "sim.add.fixed", left: "sim.add.pressure", right: "sim.run",
      upLeft: "sim.mesh.finer", upRight: "sim.mesh.preview", downLeft: "sim.mesh.coarser", downRight: "view.fit",
    },
  },
  displayStyle: "shadedEdges",
  showPlanes: false,
  theme: "system",
  sketchGrid: false,
  meshTimeout: 120,
  solveTimeout: 3600,
  kernelTimeout: 300,
  agentUrl: "http://127.0.0.1:8765",
  helpExpanded: false,
  plugins: { galkeelHull: false },
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
  const gestures = sanitizeGestures(s.gestures);
  const plugins = s.plugins && typeof s.plugins === "object" ? s.plugins : ({} as Partial<PluginFlags>);
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
    helpExpanded: bool(s.helpExpanded, d.helpExpanded),
    plugins: { galkeelHull: bool(plugins.galkeelHull, d.plugins.galkeelHull) },
  };
}

/** Gestos guardados → formato por contexto. O formato antigo (um só mapa direção → comando, de antes dos contextos)
 *  passa a ser o do contexto «3d»; direções em falta ou inválidas ficam com o valor por defeito. */
export function sanitizeGestures(g: unknown): Settings["gestures"] {
  const d = DEFAULT_SETTINGS.gestures;
  const out = { "3d": { ...d["3d"] }, sketch: { ...d.sketch }, fem: { ...d.fem } };
  if (!g || typeof g !== "object") return out;
  const o = g as Record<string, unknown>;
  const flat = GESTURE_DIRS.some((k) => typeof o[k] === "string");
  const src: Partial<Record<GestureContext, unknown>> = flat ? { "3d": o } : o;
  for (const c of GESTURE_CONTEXTS) {
    const m = src[c];
    if (!m || typeof m !== "object") continue;
    for (const k of GESTURE_DIRS) {
      const v = (m as Record<string, unknown>)[k];
      if (typeof v === "string" && v) out[c][k] = v;
    }
  }
  return out;
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
