// Adaptador do XFOIL (M. Drela, MIT, GPL): polares de perfis 2D por painéis + camada-limite acoplada
// (método e^n). Como os outros solvers, corre como processo separado no agente local; este módulo só
// gera os comandos (a partir de números validados — nunca texto recebido) e lê a polar escrita pelo
// XFOIL. O perfil vem de um código NACA de 4/5 dígitos ou de coordenadas (formato Selig: bordo de
// fuga → extradorso → bordo de ataque → intradorso → bordo de fuga), por exemplo as do gerador NACA
// ou de um esboço do CAD.

export interface XfoilRequest {
  /** Código NACA ("0012", "2412", "23012") ou coordenadas adimensionais (x/c, y/c) no formato Selig. */
  airfoil: { naca: string } | { name: string; coords: [number, number][] };
  re: number;
  mach?: number;
  /** Fator de amplificação crítico do método e^n (9: túnel/ar calmo médio; 4–8: escoamento mais turbulento). */
  ncrit?: number;
  /** Ângulos de ataque em graus: de `from` a `to` com passo `step`. */
  alpha: { from: number; to: number; step: number };
  /** Transição forçada (x/c) no extradorso/intradorso; 1 = livre. */
  xtrTop?: number;
  xtrBot?: number;
  iter?: number;
  panels?: number;
}

export interface PolarRow { alpha: number; cl: number; cd: number; cdp: number; cm: number; xtrTop: number; xtrBot: number }

export interface PolarSummary {
  /** Declive da reta de sustentação (por grau e por radiano), ajustado na zona linear em torno de α0. */
  clAlphaDeg: number | null;
  clAlphaRad: number | null;
  /** Ângulo de sustentação nula (graus). */
  alpha0: number | null;
  /** CL máximo e ângulo, só quando há um máximo dentro da gama (senão o perfil não perdeu sustentação). */
  clMax: number | null;
  alphaClMax: number | null;
  cdMin: number;
  clAtCdMin: number;
  ldMax: number;
  alphaLdMax: number;
  /** Ângulos pedidos que não convergiram (o XFOIL omite-os da polar). */
  missing: number[];
}

export interface XfoilResult {
  ok: boolean;
  solver: string;
  airfoil: string;
  re: number;
  mach: number;
  ncrit: number;
  polar: PolarRow[];
  summary: PolarSummary;
  warnings: string[];
  hypotheses: string[];
  seconds: number;
  log: string;
}

const num = (x: unknown, what: string, lo: number, hi: number) => {
  const v = Number(x);
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what}: valor inválido (${String(x)}; entre ${lo} e ${hi})`);
  return v;
};

/** Pedido validado (limites físicos e de tamanho); deita fora tudo o que não é número ou código NACA. */
export function checkXfoilRequest(r: XfoilRequest): XfoilRequest {
  const a = r?.airfoil as Record<string, unknown> | undefined;
  let airfoil: XfoilRequest["airfoil"];
  if (a && typeof a.naca === "string") {
    if (!/^\d{4,5}$/.test(a.naca)) throw new Error("Código NACA inválido (4 ou 5 dígitos)");
    airfoil = { naca: a.naca };
  } else if (a && Array.isArray(a.coords)) {
    const coords = (a.coords as unknown[]).map((p, i) => {
      if (!Array.isArray(p) || p.length < 2) throw new Error(`Coordenada ${i + 1} inválida`);
      return [num(p[0], "x/c", -0.1, 1.1), num(p[1], "y/c", -0.5, 0.5)] as [number, number];
    });
    if (coords.length < 20 || coords.length > 1000) throw new Error("O perfil precisa de 20 a 1000 pontos");
    airfoil = { name: String(a.name ?? "Perfil").replace(/[^\w .+-]/g, "").slice(0, 40) || "Perfil", coords };
  } else throw new Error("Perfil em falta (código NACA ou coordenadas)");
  const al = r.alpha ?? ({} as XfoilRequest["alpha"]);
  const from = num(al.from, "α inicial", -30, 30), to = num(al.to, "α final", -30, 30);
  const step = Math.abs(num(al.step, "passo de α", 0.05, 10));
  if (Math.abs(to - from) / step > 200) throw new Error("Demasiados ângulos (máx. 200)");
  return {
    airfoil,
    re: num(r.re, "Reynolds", 1e4, 1e9),
    mach: num(r.mach ?? 0, "Mach", 0, 0.7),
    ncrit: num(r.ncrit ?? 9, "Ncrit", 1, 14),
    alpha: { from, to, step },
    xtrTop: num(r.xtrTop ?? 1, "transição no extradorso", 0, 1),
    xtrBot: num(r.xtrBot ?? 1, "transição no intradorso", 0, 1),
    iter: Math.round(num(r.iter ?? 150, "iterações", 10, 1000)),
    panels: Math.round(num(r.panels ?? 160, "painéis", 60, 400)),
  };
}

/** Ficheiro de coordenadas (formato Selig com nome na primeira linha). */
export function airfoilFile(name: string, coords: [number, number][]) {
  return `${name}\n${coords.map(([x, y]) => ` ${x.toFixed(6)}  ${y.toFixed(6)}`).join("\n")}\n`;
}

/**
 * Comandos para o XFOIL (stdin). A varredura começa em α = 0 (ou no ângulo mais próximo) e vai para
 * cada lado separadamente, com a camada-limite reiniciada, porque o XFOIL converge melhor partindo
 * da solução vizinha. Sem gráficos (PLOP G F).
 */
export function xfoilCommands(req: XfoilRequest, polarFile = "polar.txt", airfoilPath = "airfoil.dat") {
  const r = checkXfoilRequest(req);
  const lo = Math.min(r.alpha.from, r.alpha.to), hi = Math.max(r.alpha.from, r.alpha.to), s = r.alpha.step;
  const start = lo > 0 ? lo : hi < 0 ? hi : 0;
  const f = (x: number) => x.toFixed(3);
  const lines = ["PLOP", "G F", ""];
  lines.push("naca" in r.airfoil ? `NACA ${r.airfoil.naca}` : `LOAD ${airfoilPath}`);
  lines.push("PPAR", `N ${r.panels}`, "", "");
  lines.push("OPER", "VPAR", `N ${r.ncrit}`, `XTR ${r.xtrTop} ${r.xtrBot}`, "");
  lines.push(`ITER ${r.iter}`, `VISC ${r.re}`, `MACH ${r.mach}`, "PACC", polarFile, "");
  if (hi >= start) lines.push(`ASEQ ${f(start)} ${f(hi)} ${f(s)}`);
  if (lo < start) lines.push("INIT", `ASEQ ${f(start - s)} ${f(lo)} ${f(-s)}`);
  lines.push("PACC", "", "QUIT", "");
  return { stdin: lines.join("\n"), files: "coords" in r.airfoil ? { [airfoilPath]: airfoilFile(r.airfoil.name, r.airfoil.coords) } : {}, request: r };
}

/**
 * Segunda passagem para os ângulos que não convergiram: cada um é aproximado a partir do vizinho
 * convergido mais próximo em passos de 0,25° (camada-limite reiniciada), com o dobro das iterações
 * e mais 10 painéis.
 */
export function xfoilRetryCommands(req: XfoilRequest, missing: number[], converged: number[], polarFile = "polar2.txt", airfoilPath = "airfoil.dat") {
  // outra distribuição de painéis (+10): quebra os ciclos da transição a saltar entre dois nós
  const base = xfoilCommands({ ...req, iter: Math.min(1000, (req.iter ?? 150) * 2), panels: Math.min(400, (req.panels ?? 160) + 10) }, polarFile, airfoilPath);
  const head = base.stdin.split("\n");
  const cut = head.findIndex((l) => l.startsWith("ASEQ") || l === "INIT");
  const lines = head.slice(0, cut);
  const f = (x: number) => x.toFixed(3);
  missing.forEach((m, k) => {
    const near = converged.length ? converged.reduce((b, a) => (Math.abs(a - m) < Math.abs(b - m) ? a : b)) : 0;
    const d = m > near ? 0.25 : -0.25;
    // INIT só depois de haver uma solução (antes da primeira, a camada-limite inicial dá NaN)
    if (k > 0) lines.push("INIT");
    lines.push(`ALFA ${f(near)}`);
    if (Math.abs(m - near) > 0.26) lines.push(`ASEQ ${f(near + d)} ${f(m - d)} ${f(d)}`);
    lines.push(`ALFA ${f(m)}`);
  });
  lines.push("PACC", "", "QUIT", "");
  return { stdin: lines.join("\n"), files: base.files, request: base.request };
}

/** Lê a polar do XFOIL (colunas depois da linha de traços), ordenada por α e sem repetidos. */
export function parsePolar(text: string): PolarRow[] {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*-{5,}/.test(l));
  if (i < 0) return [];
  const rows = new Map<string, PolarRow>();
  for (const l of lines.slice(i + 1)) {
    const v = l.trim().split(/\s+/).map(Number);
    if (v.length < 7 || v.slice(0, 7).some((x) => !Number.isFinite(x))) continue;
    rows.set(v[0].toFixed(3), { alpha: v[0], cl: v[1], cd: v[2], cdp: v[3], cm: v[4], xtrTop: v[5], xtrBot: v[6] });
  }
  return [...rows.values()].sort((a, b) => a.alpha - b.alpha);
}

/** Grandezas de projeto da polar: declive e α0 (mínimos quadrados na zona linear), CLmax, CDmin, L/D. */
export function polarSummary(polar: PolarRow[], req?: XfoilRequest): PolarSummary {
  const missing: number[] = [];
  if (req) {
    const lo = Math.min(req.alpha.from, req.alpha.to), hi = Math.max(req.alpha.from, req.alpha.to);
    for (let a = lo; a <= hi + 1e-9; a += Math.abs(req.alpha.step)) if (!polar.some((p) => Math.abs(p.alpha - a) < 1e-3)) missing.push(Math.round(a * 1000) / 1000);
  }
  if (!polar.length) return { clAlphaDeg: null, clAlphaRad: null, alpha0: null, clMax: null, alphaClMax: null, cdMin: NaN, clAtCdMin: NaN, ldMax: NaN, alphaLdMax: NaN, missing };
  // zona linear: pontos a ±5° do ângulo de CL mais próximo de zero (onde o perfil ainda não perdeu)
  const near0 = polar.reduce((b, p) => (Math.abs(p.cl) < Math.abs(b.cl) ? p : b));
  const lin = polar.filter((p) => Math.abs(p.alpha - near0.alpha) <= 5);
  let clAlphaDeg: number | null = null, alpha0: number | null = null;
  if (lin.length >= 3) {
    const n = lin.length, sx = lin.reduce((s, p) => s + p.alpha, 0), sy = lin.reduce((s, p) => s + p.cl, 0);
    const sxx = lin.reduce((s, p) => s + p.alpha * p.alpha, 0), sxy = lin.reduce((s, p) => s + p.alpha * p.cl, 0);
    const k = (n * sxy - sx * sy) / (n * sxx - sx * sx), b = (sy - k * sx) / n;
    clAlphaDeg = k; alpha0 = -b / k;
  }
  // CLmax só se for um máximo interior (há pontos depois com CL menor)
  let iMax = 0;
  polar.forEach((p, i) => { if (p.cl > polar[iMax].cl) iMax = i; });
  const interior = iMax < polar.length - 1;
  const cdBest = polar.reduce((b, p) => (p.cd < b.cd ? p : b));
  const ldBest = polar.reduce((b, p) => (p.cl / p.cd > b.cl / b.cd ? p : b));
  return {
    clAlphaDeg, clAlphaRad: clAlphaDeg === null ? null : (clAlphaDeg * 180) / Math.PI, alpha0,
    clMax: interior ? polar[iMax].cl : null, alphaClMax: interior ? polar[iMax].alpha : null,
    cdMin: cdBest.cd, clAtCdMin: cdBest.cl, ldMax: ldBest.cl / ldBest.cd, alphaLdMax: ldBest.alpha, missing,
  };
}

export const XFOIL_HYPOTHESES = [
  "Escoamento 2D (perfil de envergadura infinita), subsónico; compressibilidade pela correção de Kármán–Tsien (válida abaixo do Mach crítico).",
  "Camada-limite integral acoplada ao escoamento potencial (método de painéis); transição pelo método e^n com o Ncrit indicado.",
  "Fiável na zona linear e até perto do CLmax; depois da perda (separação extensa) o XFOIL tende a sobrestimar CLmax e subestimar CD — confirmar com dados de túnel ou CFD.",
  "Ângulos que não convergem são omitidos da polar (listados nos avisos).",
  "Para uma asa finita, corrigir o declive pelo alongamento (cálculo «Asa finita») — resultado de apoio ao projeto, não substitui ensaio nem certificação.",
];

/** Coordenadas NACA de 4 dígitos (Abbott & von Doenhoff, 1959, §6.4), espaçamento cosseno, formato Selig. */
export function nacaCoords(code: string, nSide = 60, closedTE = false): [number, number][] {
  if (!/^\d{4}$/.test(code)) throw new Error("Gerador: só NACA de 4 dígitos");
  const m = Number(code[0]) / 100, p = Number(code[1]) / 10, t = Number(code.slice(2)) / 100;
  const a4 = closedTE ? -0.1036 : -0.1015;
  const pt = (x: number, upper: boolean): [number, number] => {
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 + a4 * x ** 4);
    let yc = 0, dy = 0;
    if (m > 0 && p > 0) {
      if (x < p) { yc = (m / (p * p)) * (2 * p * x - x * x); dy = (2 * m / (p * p)) * (p - x); }
      else { yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x); dy = (2 * m / ((1 - p) ** 2)) * (p - x); }
    }
    const th = Math.atan(dy), s = upper ? 1 : -1;
    return [x - s * yt * Math.sin(th), yc + s * yt * Math.cos(th)];
  };
  const xs = Array.from({ length: nSide + 1 }, (_, i) => 0.5 * (1 - Math.cos((Math.PI * i) / nSide)));
  const upper = [...xs].reverse().map((x) => pt(x, true));
  const lower = xs.slice(1).map((x) => pt(x, false));
  return [...upper, ...lower];
}
