// Laminados compósitos: propriedades das camadas pela ISO 12215-5:2019 (anexo C) e teoria clássica
// dos laminados (CLT) — matrizes A, B, D, módulos equivalentes e extensões/tensões por camada.
// Unidades: MPa, mm, kg/m² (massa seca de reforço), N/mm (esforços de membrana), N·mm/mm (momentos).
//
// As tabelas e fórmulas do anexo C são as da galkeel-app (lib/dossiers/calc-iso-12215-5-laminate.ts),
// já conferidas contra a norma; aqui só se acrescenta a passagem a camadas ortotrópicas para a CLT.

export type FibreKind = "glass" | "carbon";
export type PlyType = "csm" | "wr" | "ud" | "dbx" | "qx" | "rovimat";
export type LaminationProcess = "hand-simple" | "hand-complex" | "rtm";

// ---------------------------------------------------------------------------
// Tabela C.4 — fibras e matriz (poliéster/epóxi genérica)
// ---------------------------------------------------------------------------

interface FibreProps { rho: number; e1: number; e2: number; g: number; nu: number }

const FIBRES: Record<FibreKind, FibreProps> = {
  glass: { rho: 2.56, e1: 73000, e2: 73000, g: 30000, nu: 0.22 },
  carbon: { rho: 1.78, e1: 235000, e2: 20000, g: 50000, nu: 0.27 },
};
const MATRIX = { rho: 1.2, e: 3300, g: 1222, nu: 0.32 };

export const PLY_TYPE_LABELS: Record<PlyType, string> = {
  csm: "Manta (CSM)",
  wr: "Tecido 0/90° (WR / BD+)",
  ud: "Unidirecional (UD)",
  dbx: "Biaxial ±45° (DBx)",
  qx: "Quadriaxial 0/90/±45° (QX)",
  rovimat: "Rovimat (tecido 800 + manta 300, vidro)",
};

export const PROCESS_LABELS: Record<LaminationProcess, string> = {
  "hand-simple": "Manual, formas simples",
  "hand-complex": "Manual, formas complexas",
  rtm: "Infusão / RTM",
};

// ---------------------------------------------------------------------------
// Tabela C.2 — teor em fibra, espessura e massa
// ---------------------------------------------------------------------------

/** Teor em massa ψ a partir do teor em volume φ. */
export function psiFromPhi(phi: number, fibre: FibreKind): number {
  const rf = FIBRES[fibre].rho;
  return (phi * rf) / (phi * rf + (1 - phi) * MATRIX.rho);
}

/** Teor em volume φ a partir do teor em massa ψ. */
export function phiFromPsi(psi: number, fibre: FibreKind): number {
  return psi / (psi + ((1 - psi) * FIBRES[fibre].rho) / MATRIX.rho);
}

/** Espessura (mm) de uma camada com `w` kg/m² de reforço seco e teor em volume φ. */
export function plyThicknessMm(w: number, phi: number, fibre: FibreKind): number {
  return w / (phi * FIBRES[fibre].rho);
}

/** Massa de reforço (kg/m²) de uma camada de espessura `t` mm. */
export function plyMassKgM2(t: number, phi: number, fibre: FibreKind): number {
  return t * phi * FIBRES[fibre].rho;
}

/** Massa volúmica do compósito (g/cm³ = t/m³). */
export function compositeDensity(phi: number, fibre: FibreKind): number {
  return FIBRES[fibre].rho * phi + MATRIX.rho * (1 - phi);
}

// ---------------------------------------------------------------------------
// Tabela C.7 — teor em fibra de referência por processo
// ---------------------------------------------------------------------------

const GUIDANCE_PHI: Record<FibreKind, Record<LaminationProcess, Partial<Record<PlyType, number>>>> = {
  glass: {
    "hand-simple": { csm: 0.167, wr: 0.3, ud: 0.364, dbx: 0.319, qx: 0.319, rovimat: 0.246 },
    "hand-complex": { csm: 0.134, wr: 0.24, ud: 0.291, dbx: 0.255, qx: 0.255, rovimat: 0.197 },
    rtm: { csm: 0.135, wr: 0.135, ud: 0.135, dbx: 0.135, qx: 0.135, rovimat: 0.135 },
  },
  carbon: {
    "hand-simple": { wr: 0.389, ud: 0.459, dbx: 0.41, qx: 0.41 },
    "hand-complex": { wr: 0.319, ud: 0.378, dbx: 0.337, qx: 0.337 },
    rtm: { wr: 0.188, ud: 0.188, dbx: 0.188, qx: 0.188 },
  },
};

/** φ de referência (Tabela C.7); `null` se a combinação não existe (manta ou rovimat de carbono). */
export function guidancePhi(fibre: FibreKind, ply: PlyType, process: LaminationProcess): number | null {
  return GUIDANCE_PHI[fibre][process][ply] ?? null;
}

// ---------------------------------------------------------------------------
// Tabela C.5 — constantes elásticas (ζ = 1)
// ---------------------------------------------------------------------------

export interface ElasticConstants {
  eUD1: number; eUD2: number; gUD12: number; nuUD12: number;
  eCSM: number; gCSM: number;
  eBD: number; gBD: number; nuBD: number;
  eDBx: number; gDBx: number; nuDBx: number;
  eQX: number; gQX: number; nuQX: number;
}

export function elasticConstants(phi: number, fibre: FibreKind): ElasticConstants {
  const f = FIBRES[fibre];
  const em = MATRIX.e;
  const gm = MATRIX.g;
  const eUD1 = 0.975 * (f.e1 * phi + em * (1 - phi));
  const etaE = (f.e2 / em - 1) / (f.e2 / em + 1);
  const eUD2 = (em * (1 + etaE * phi)) / (1 - etaE * phi);
  const etaG = (f.g / gm - 1) / (f.g / gm + 1);
  const gUD12 = (gm * (1 + etaG * phi)) / (1 - etaG * phi);
  const nuUD12 = f.nu * phi + MATRIX.nu * (1 - phi);
  const eCSM = (3 / 8) * eUD1 + (5 / 8) * eUD2;
  const gCSM = (1 / 8) * eUD1 + (1 / 4) * eUD2;
  const eBD = 0.5 * (eUD1 + eUD2);
  const gBD = gUD12;
  const nuBD = (nuUD12 * eUD2) / eBD;
  const eDBx = (4 * eBD) / (eBD / gBD + 2 * (1 - nuBD));
  const gDBx = eBD / (2 * (1 + nuBD));
  const nuDBx = (eDBx / (4 * eBD)) * (eBD / gBD - 2 * (1 - nuBD));
  const a11 = eBD / (1 - nuBD ** 2) + eDBx / (1 - nuDBx ** 2);
  const a12 = (nuBD * eBD) / (1 - nuBD ** 2) + (nuDBx * eDBx) / (1 - nuDBx ** 2);
  const eQX = 0.5 * (a11 - a12 ** 2 / a11);
  const gQX = 0.5 * (gBD + gDBx);
  const nuQX = a12 / a11;
  return { eUD1, eUD2, gUD12, nuUD12, eCSM, gCSM, eBD, gBD, nuBD, eDBx, gDBx, nuDBx, eQX, gQX, nuQX };
}

// ---------------------------------------------------------------------------
// Tabela C.6 — extensões de rotura (%)
// ---------------------------------------------------------------------------

/** Extensões de rotura (%): tração, compressão, flexão e distorção. */
export interface PlyStrains { ut: number; uc: number; uf: number; gamma: number }

const STRAINS: Record<FibreKind, Partial<Record<PlyType, PlyStrains>>> = {
  glass: {
    ud: { ut: 1.9, uc: 1.4, uf: 2.02, gamma: 1.7 },
    csm: { ut: 1.35, uc: 1.7, uf: 1.88, gamma: 2.0 },
    wr: { ut: 1.55, uc: 1.4, uf: 1.84, gamma: 1.7 },
    dbx: { ut: 1.06, uc: 1.02, uf: 1.3, gamma: 1.8 },
    qx: { ut: 1.3, uc: 1.2, uf: 1.56, gamma: 1.7 },
  },
  carbon: {
    ud: { ut: 1.0, uc: 0.7, uf: 1.21, gamma: 1.5 },
    wr: { ut: 1.0, uc: 0.7, uf: 1.21, gamma: 1.4 },
    dbx: { ut: 0.77, uc: 0.75, uf: 1.12, gamma: 1.02 },
    qx: { ut: 0.92, uc: 0.74, uf: 1.21, gamma: 1.02 },
  },
};

export function plyStrains(fibre: FibreKind, ply: PlyType): PlyStrains | null {
  return STRAINS[fibre][ply] ?? null;
}

// ---------------------------------------------------------------------------
// Camada do anexo C (Tabela C.8): módulo e resistências na direção principal
// ---------------------------------------------------------------------------

export interface PlyInput {
  fibre: FibreKind;
  ply: PlyType;
  /** Massa seca de reforço, kg/m². */
  w: number;
  /** Teor de fibra em volume φ (0–1). */
  phi: number;
}

export interface PlyResult {
  input: PlyInput;
  t: number; e: number; g: number;
  strains: PlyStrains;
  sigmaUt: number; sigmaUc: number; sigmaUf: number; tauU: number;
}

/** Rovimat 800/300: 800 g/m² de tecido + 300 g/m² de manta (Tabela C.11). */
const ROVIMAT_WR_SHARE = 800 / 1100;
const ROVIMAT_PHI_REF = 0.246;

/** Partes de uma rovimat: tecido e manta, cada uma com o seu φ (a proporção da Tabela C.7). */
function rovimatParts(input: PlyInput): PlyInput[] {
  const k = input.phi / ROVIMAT_PHI_REF;
  return [
    { fibre: "glass", ply: "wr", w: input.w * ROVIMAT_WR_SHARE, phi: Math.min(0.9, 0.3 * k) },
    { fibre: "glass", ply: "csm", w: input.w * (1 - ROVIMAT_WR_SHARE), phi: Math.min(0.9, 0.167 * k) },
  ];
}

function modulusFor(ply: Exclude<PlyType, "rovimat">, c: ElasticConstants): { e: number; g: number } {
  switch (ply) {
    case "csm": return { e: c.eCSM, g: c.gCSM };
    case "wr": return { e: c.eBD, g: c.gBD };
    case "dbx": return { e: c.eDBx, g: c.gDBx };
    case "qx": return { e: c.eQX, g: c.gQX };
    case "ud": return { e: c.eUD1, g: c.gUD12 };
  }
}

function withStrengths(input: PlyInput, t: number, e: number, g: number, strains: PlyStrains): PlyResult {
  return {
    input, t, e, g, strains,
    sigmaUt: (e * strains.ut) / 100,
    sigmaUc: (e * strains.uc) / 100,
    sigmaUf: (e * strains.uf) / 100,
    tauU: (g * strains.gamma) / 100,
  };
}

/** Propriedades de uma camada (direção principal 1; σ = E·ε/100, τ = G·γ/100 — Tabela C.8); `null` se inválida. */
export function plyResult(input: PlyInput): PlyResult | null {
  if (!(input.w > 0) || !(input.phi > 0 && input.phi < 1)) return null;
  if (input.ply === "rovimat") {
    if (input.fibre !== "glass") return null;
    const [wr, csm] = rovimatParts(input).map(plyResult);
    if (!wr || !csm) return null;
    const t = wr.t + csm.t;
    const min = (k: keyof PlyStrains) => Math.min(wr.strains[k], csm.strains[k]);
    return withStrengths(input, t, (wr.t * wr.e + csm.t * csm.e) / t, (wr.t * wr.g + csm.t * csm.g) / t,
      { ut: min("ut"), uc: min("uc"), uf: min("uf"), gamma: min("gamma") });
  }
  const strains = plyStrains(input.fibre, input.ply);
  if (!strains) return null;
  const { e, g } = modulusFor(input.ply, elasticConstants(input.phi, input.fibre));
  return withStrengths(input, plyThicknessMm(input.w, input.phi, input.fibre), e, g, strains);
}

// ---------------------------------------------------------------------------
// Camadas ortotrópicas para a CLT
// ---------------------------------------------------------------------------

/** Camada ortotrópica em estado plano de tensão: módulos (MPa), espessura (mm), ângulo das fibras (graus, a partir de x). */
export interface OrthoPly {
  e1: number; e2: number; g12: number; nu12: number;
  t: number;
  theta: number;
  /** Extensões de rotura (%) nos eixos do material, para os critérios por camada. */
  strains?: PlyStrains;
  /** Origem (rótulo para relatórios). */
  label?: string;
}

/**
 * Camadas ortotrópicas equivalentes a uma camada do anexo C, com o ângulo de referência `theta`:
 * - UD: E1 = E_UD1, E2 = E_UD2, G12, ν12 da Tabela C.5;
 * - tecido 0/90 (WR): o BD da norma, E1 = E2 = E_BD, G_BD, ν_BD;
 * - biaxial ±45 (DBx): o mesmo BD rodado 45° (a norma obtém E_DBx exatamente assim);
 * - quadriaxial (QX): metade BD a 0° e metade a 45° (a fórmula de E_QX da norma é essa média);
 * - manta (CSM): isotrópica, E = E_CSM, G = G_CSM, ν = E/(2G) − 1;
 * - rovimat: tecido + manta, cada um com o seu φ.
 * Assim a CLT reproduz os módulos no plano da Tabela C.5 e acrescenta a rigidez fora do eixo e à flexão.
 */
export function isoPlyToOrtho(input: PlyInput, theta = 0): OrthoPly[] | null {
  const ref = plyResult(input);
  if (!ref) return null;
  const label = PLY_TYPE_LABELS[input.ply];
  if (input.ply === "rovimat") {
    return rovimatParts(input).flatMap((p) => (isoPlyToOrtho(p, theta) ?? []).map((o) => ({ ...o, label })));
  }
  const c = elasticConstants(input.phi, input.fibre);
  const t = ref.t;
  const strains = ref.strains;
  const bd = (tt: number, th: number): OrthoPly => ({ e1: c.eBD, e2: c.eBD, g12: c.gBD, nu12: c.nuBD, t: tt, theta: th, strains, label });
  switch (input.ply) {
    case "ud": return [{ e1: c.eUD1, e2: c.eUD2, g12: c.gUD12, nu12: c.nuUD12, t, theta, strains, label }];
    case "wr": return [bd(t, theta)];
    case "dbx": return [bd(t, theta + 45)];
    case "qx": return [bd(t / 2, theta), bd(t / 2, theta + 45)];
    case "csm": return [{ e1: c.eCSM, e2: c.eCSM, g12: c.gCSM, nu12: c.eCSM / (2 * c.gCSM) - 1, t, theta, strains, label }];
  }
}

/** Erro de uma camada ortotrópica fisicamente impossível, ou `null` se é válida. */
export function orthoPlyError(p: OrthoPly): string | null {
  if (!(p.e1 > 0 && p.e2 > 0 && p.g12 > 0)) return "Os módulos E1, E2 e G12 têm de ser positivos.";
  if (!(p.t > 0)) return "A espessura da camada tem de ser positiva.";
  if (!Number.isFinite(p.theta)) return "O ângulo da camada tem de ser um número.";
  // Estabilidade (matriz de flexibilidade definida positiva): 1 − ν12·ν21 > 0.
  if (!(Math.abs(p.nu12) < Math.sqrt(p.e1 / p.e2))) return "O coeficiente de Poisson ν12 tem de ter |ν12| < √(E1/E2).";
  return null;
}

// ---------------------------------------------------------------------------
// Teoria clássica dos laminados
// ---------------------------------------------------------------------------

/** Matriz 3×3 [xx, yy, xy] (γ de engenharia). */
export type M3 = [[number, number, number], [number, number, number], [number, number, number]];

/** Rigidez reduzida Q nos eixos do material. */
export function qMatrix(p: OrthoPly): M3 {
  const nu21 = (p.nu12 * p.e2) / p.e1;
  const den = 1 - p.nu12 * nu21;
  const q11 = p.e1 / den;
  const q22 = p.e2 / den;
  const q12 = (p.nu12 * p.e2) / den;
  return [[q11, q12, 0], [q12, q22, 0], [0, 0, p.g12]];
}

/** Rigidez reduzida transformada Q̄ nos eixos do laminado (camada rodada `theta` graus). */
export function qBar(p: OrthoPly): M3 {
  const [[q11, q12], [, q22], [, , q66]] = qMatrix(p);
  const th = (p.theta * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const c2 = c * c, s2 = s * s, sc = s * c;
  const b11 = q11 * c2 * c2 + 2 * (q12 + 2 * q66) * s2 * c2 + q22 * s2 * s2;
  const b22 = q11 * s2 * s2 + 2 * (q12 + 2 * q66) * s2 * c2 + q22 * c2 * c2;
  const b12 = (q11 + q22 - 4 * q66) * s2 * c2 + q12 * (s2 * s2 + c2 * c2);
  const b16 = (q11 - q12 - 2 * q66) * sc * c2 + (q12 - q22 + 2 * q66) * sc * s2;
  const b26 = (q11 - q12 - 2 * q66) * sc * s2 + (q12 - q22 + 2 * q66) * sc * c2;
  const b66 = (q11 + q22 - 2 * q12 - 2 * q66) * s2 * c2 + q66 * (s2 * s2 + c2 * c2);
  return [[b11, b12, b16], [b12, b22, b26], [b16, b26, b66]];
}

const zero3 = (): M3 => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

export interface Abd {
  A: M3; B: M3; D: M3;
  /** Espessura total (mm). */
  t: number;
  /** Cotas das interfaces, da face inferior (−t/2) à superior (+t/2); a camada 0 é a de baixo. */
  z: number[];
}

/** Matrizes A (N/mm), B (N) e D (N·mm) de uma pilha de camadas (a primeira é a de baixo). */
export function abd(plies: OrthoPly[]): Abd {
  const t = plies.reduce((s, p) => s + p.t, 0);
  const z = [-t / 2];
  for (const p of plies) z.push(z[z.length - 1] + p.t);
  const A = zero3(), B = zero3(), D = zero3();
  plies.forEach((p, k) => {
    const q = qBar(p);
    const z0 = z[k], z1 = z[k + 1];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      A[i][j] += q[i][j] * (z1 - z0);
      B[i][j] += (q[i][j] * (z1 * z1 - z0 * z0)) / 2;
      D[i][j] += (q[i][j] * (z1 ** 3 - z0 ** 3)) / 3;
    }
  });
  return { A, B, D, t, z };
}

/** Matriz ABD completa 6×6 [[A, B], [B, D]]. */
export function abdMatrix(l: Abd): number[][] {
  return [0, 1, 2, 3, 4, 5].map((i) => [0, 1, 2, 3, 4, 5].map((j) => {
    const m = i < 3 ? (j < 3 ? l.A : l.B) : j < 3 ? l.B : l.D;
    return m[i % 3][j % 3];
  }));
}

/** Inversa por Gauss–Jordan com pivô parcial; `null` se singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((r, i) => [...r, ...r.map((_, j) => (i === j ? 1 : 0))]);
  const scale = Math.max(...m.flat().map(Math.abs)) || 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12 * scale) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((r) => r.slice(n));
}

export interface LaminateModuli {
  /** Módulos de membrana equivalentes (MPa) e Poisson, de A⁻¹ (com o acoplamento B incluído). */
  ex: number; ey: number; gxy: number; nuxy: number;
  /** Módulos de flexão equivalentes (MPa), 12/(t³·d*). */
  exf: number; eyf: number;
}

/** Módulos equivalentes do laminado, a partir da flexibilidade completa (ABD)⁻¹; `null` se singular. */
export function laminateModuli(l: Abd): LaminateModuli | null {
  const inv = invert(abdMatrix(l));
  if (!inv) return null;
  const t = l.t;
  return {
    ex: 1 / (t * inv[0][0]),
    ey: 1 / (t * inv[1][1]),
    gxy: 1 / (t * inv[2][2]),
    nuxy: -inv[0][1] / inv[0][0],
    exf: 12 / (t ** 3 * inv[3][3]),
    eyf: 12 / (t ** 3 * inv[4][4]),
  };
}

/** Extensões e tensões numa cota de uma camada. */
export interface PlyPoint {
  z: number;
  /** Extensões nos eixos do laminado [εx, εy, γxy]. */
  strainXY: [number, number, number];
  /** Extensões nos eixos do material [ε1, ε2, γ12]. */
  strain12: [number, number, number];
  /** Tensões nos eixos do material [σ1, σ2, τ12] (MPa). */
  stress12: [number, number, number];
}

export interface PlyResponse { ply: number; bottom: PlyPoint; top: PlyPoint }

export interface LaminateResponse {
  /** Extensões da superfície média [εx⁰, εy⁰, γxy⁰] e curvaturas [κx, κy, κxy] (1/mm). */
  eps0: [number, number, number];
  kappa: [number, number, number];
  plies: PlyResponse[];
}

/** Resposta a esforços N = [Nx, Ny, Nxy] (N/mm) e M = [Mx, My, Mxy] (N·mm/mm); `null` se a ABD é singular. */
export function laminateResponse(plies: OrthoPly[], n: [number, number, number], m: [number, number, number] = [0, 0, 0]): LaminateResponse | null {
  const l = abd(plies);
  const inv = invert(abdMatrix(l));
  if (!inv) return null;
  const load = [...n, ...m];
  const def = inv.map((r) => r.reduce((s, v, j) => s + v * load[j], 0));
  const eps0: [number, number, number] = [def[0], def[1], def[2]];
  const kappa: [number, number, number] = [def[3], def[4], def[5]];
  const at = (p: OrthoPly, z: number): PlyPoint => {
    const ex = eps0[0] + z * kappa[0], ey = eps0[1] + z * kappa[1], gxy = eps0[2] + z * kappa[2];
    const th = (p.theta * Math.PI) / 180;
    const c = Math.cos(th), s = Math.sin(th);
    const e1 = c * c * ex + s * s * ey + s * c * gxy;
    const e2 = s * s * ex + c * c * ey - s * c * gxy;
    const g12 = -2 * s * c * ex + 2 * s * c * ey + (c * c - s * s) * gxy;
    const q = qMatrix(p);
    return {
      z,
      strainXY: [ex, ey, gxy],
      strain12: [e1, e2, g12],
      stress12: [q[0][0] * e1 + q[0][1] * e2, q[1][0] * e1 + q[1][1] * e2, q[2][2] * g12],
    };
  };
  return {
    eps0, kappa,
    plies: plies.map((p, k) => ({ ply: k, bottom: at(p, l.z[k]), top: at(p, l.z[k + 1]) })),
  };
}

// ---------------------------------------------------------------------------
// Critérios de rotura por camada — extensão máxima (ISO 12215-5, Tabela C.6)
// ---------------------------------------------------------------------------

export type FailureMode = "tração 1" | "compressão 1" | "tração 2" | "compressão 2" | "corte 12";

export interface PlyFailure {
  /** Índice de rotura (≥ 1 ⇒ rotura): maior razão extensão / extensão de rotura. */
  index: number;
  mode: FailureMode;
}

/**
 * Critério de extensão máxima nos eixos do material, com as extensões de rotura da Tabela C.6.
 * Hipótese: a direção 2 usa os mesmos limites da direção 1 — exato para camadas equilibradas
 * (WR, CSM, biaxiais), otimista para a direção transversal de uma UD. `null` sem extensões de rotura.
 */
export function plyFailureIndex(p: OrthoPly, strain12: [number, number, number]): PlyFailure | null {
  const s = p.strains;
  if (!s) return null;
  const [e1, e2, g] = strain12;
  const cands: [number, FailureMode][] = [
    e1 >= 0 ? [e1 / (s.ut / 100), "tração 1"] : [-e1 / (s.uc / 100), "compressão 1"],
    e2 >= 0 ? [e2 / (s.ut / 100), "tração 2"] : [-e2 / (s.uc / 100), "compressão 2"],
    [Math.abs(g) / (s.gamma / 100), "corte 12"],
  ];
  const [index, mode] = cands.reduce((a, b) => (b[0] > a[0] ? b : a));
  return { index, mode };
}

export interface LaminateFailure {
  /** Por camada: o pior entre a face inferior e a superior (`null` sem extensões de rotura). */
  plies: (PlyFailure | null)[];
  /** Camada crítica (índice em `plies`) e o seu índice de rotura; `null` se nenhuma camada tem limites. */
  critical: { ply: number; index: number; mode: FailureMode } | null;
}

export function laminateFailure(plies: OrthoPly[], resp: LaminateResponse): LaminateFailure {
  const per = resp.plies.map((r) => {
    const a = plyFailureIndex(plies[r.ply], r.bottom.strain12), b = plyFailureIndex(plies[r.ply], r.top.strain12);
    return a && b ? (b.index > a.index ? b : a) : a ?? b;
  });
  let critical: LaminateFailure["critical"] = null;
  per.forEach((f, k) => {
    if (f && (!critical || f.index > critical.index)) critical = { ply: k, index: f.index, mode: f.mode };
  });
  return { plies: per, critical };
}

export const FAILURE_MODES: FailureMode[] = ["tração 1", "compressão 1", "tração 2", "compressão 2", "corte 12"];

/** Divide camadas em subcamadas até serem n (divide sempre a mais espessa); `of` é a camada de origem. */
export function splitPlies(plies: OrthoPly[], n: number): { ply: OrthoPly; of: number }[] {
  const c = plies.map(() => 1);
  for (let k = plies.length; k < n; k++) {
    let j = 0;
    plies.forEach((p, i) => {
      if (p.t / c[i] > plies[j].t / c[j]) j = i;
    });
    c[j]++;
  }
  return plies.flatMap((p, i) => Array.from({ length: c[i] }, () => ({ ply: { ...p, t: p.t / c[i] }, of: i })));
}

type V3 = [number, number, number];

/**
 * Direções 1 e 2 do material de uma camada em casca, como na `*ORIENTATION` do CalculiX: eixo de
 * referência a, b ⟂ a, e θ em torno do eixo 3 local. Exato quando a normal da casca é a × b (placa plana
 * alinhada); nas cascas curvas é uma aproximação.
 */
export function plyDirections(axis: V3, theta: number): [V3, V3] {
  const unit = (v: V3): V3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const a = unit(axis), b = unit(Math.abs(a[2]) < 0.9 ? [-a[1], a[0], 0] : [0, -a[2], a[1]]);
  const c = Math.cos((theta * Math.PI) / 180), s = Math.sin((theta * Math.PI) / 180);
  return [[0, 1, 2].map((k) => c * a[k] + s * b[k]) as V3, [0, 1, 2].map((k) => -s * a[k] + c * b[k]) as V3];
}

/**
 * Índice de rotura de uma camada a partir do tensor das tensões em eixos globais (SXX, SYY, SZZ, SXY,
 * SYZ, SZX, em MPa): roda para os eixos do material e passa a extensões em tensão plana.
 */
export function plyStressFailure(p: OrthoPly, stress: number[], dirs: [V3, V3]): PlyFailure | null {
  if (!p.strains) return null;
  const [xx, yy, zz, xy, yz, zx] = stress;
  const S = [[xx, xy, zx], [xy, yy, yz], [zx, yz, zz]];
  const q = (u: V3, v: V3) => u.reduce((acc, ui, i) => acc + ui * v.reduce((t, vj, j) => t + S[i][j] * vj, 0), 0);
  const [d1, d2] = dirs, s1 = q(d1, d1), s2 = q(d2, d2), t12 = q(d1, d2);
  return plyFailureIndex(p, [s1 / p.e1 - (p.nu12 * s2) / p.e1, s2 / p.e2 - (p.nu12 * s1) / p.e1, t12 / p.g12]);
}
