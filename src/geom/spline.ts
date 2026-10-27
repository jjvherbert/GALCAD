// Geometria pura (sem OCC) para as superfícies do estilo GSD: reamostragem por comprimento de arco,
// splines cúbicas vetoriais (natural, com tangentes impostas ou periódica), superfície de Gordon
// (secções × guias), Hermite cúbica/quíntica para concordâncias G1/G2 e círculo por 3 pontos.
import type { Vec3 } from "../doc/types.ts";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const norm = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, mul(sub(b, a), t));

/** Comprimentos acumulados de uma poligonal. */
export function cumulative(p: Vec3[]): number[] {
  const s = [0];
  for (let i = 1; i < p.length; i++) s.push(s[i - 1] + dist(p[i - 1], p[i]));
  return s;
}

/** Ponto da poligonal ao comprimento de arco `t` (0…total). */
export function atLength(p: Vec3[], s: number[], t: number): Vec3 {
  if (t <= 0) return p[0];
  const total = s[s.length - 1];
  if (t >= total) return p[p.length - 1];
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= t) lo = m; else hi = m; }
  const k = (t - s[lo]) / (s[hi] - s[lo] || 1);
  return lerp(p[lo], p[hi], k);
}

/** `n` pontos igualmente espaçados em comprimento de arco (inclui as extremidades). */
export function resample(p: Vec3[], n: number): Vec3[] {
  const s = cumulative(p);
  const total = s[s.length - 1];
  return Array.from({ length: n }, (_, i) => atLength(p, s, (total * i) / (n - 1)));
}

/** Parâmetro normalizado (0…1, por comprimento de arco) do ponto da poligonal mais próximo de `q`. */
export function closestParam(p: Vec3[], q: Vec3): { t: number; d: number } {
  const s = cumulative(p);
  const total = s[s.length - 1] || 1;
  let best = { t: 0, d: Infinity };
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], ab = sub(p[i + 1], a);
    const l2 = dot(ab, ab);
    const k = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2)) : 0;
    const d = dist(q, add(a, mul(ab, k)));
    if (d < best.d) best = { t: (s[i] + k * (s[i + 1] - s[i])) / total, d };
  }
  return best;
}

/**
 * Reparametriza uma poligonal (por comprimento de arco normalizado) de forma que os parâmetros
 * `from[k]` passem a `to[k]` (mapa linear por troços; `from` e `to` crescentes, com 0 e 1 nas pontas).
 * Devolve `n` pontos igualmente espaçados no parâmetro novo.
 */
export function reparam(p: Vec3[], from: number[], to: number[], n: number): Vec3[] {
  const s = cumulative(p);
  const total = s[s.length - 1];
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    let k = 0;
    while (k < to.length - 2 && u > to[k + 1]) k++;
    const w = (u - to[k]) / (to[k + 1] - to[k] || 1);
    out.push(atLength(p, s, total * (from[k] + w * (from[k + 1] - from[k]))));
  }
  return out;
}

/** Condição nos extremos de uma spline: natural (2.ª derivada nula) ou derivada imposta. */
export type EndCond = { kind: "natural" } | { kind: "clamped"; d: Vec3 };
const NATURAL: EndCond = { kind: "natural" };

/**
 * Spline cúbica vetorial C2 que interpola `pts` nos parâmetros `t` (crescentes).
 * Com `periodic`, o último ponto tem de coincidir com o primeiro (curva fechada C2).
 */
export class Spline {
  private m: Vec3[]; // segundas derivadas nos nós
  readonly t: number[];
  readonly pts: Vec3[];
  readonly periodic: boolean;
  constructor(t: number[], pts: Vec3[], start: EndCond = NATURAL, end: EndCond = NATURAL, periodic = false) {
    this.t = t;
    this.pts = pts;
    this.periodic = periodic;
    const n = pts.length;
    if (n < 2 || t.length !== n) throw new Error("Spline: pontos e parâmetros incompatíveis");
    this.m = periodic ? solvePeriodic(t, pts) : solveOpen(t, pts, start, end);
  }
  /** Ponto (k=0), 1.ª (k=1) ou 2.ª (k=2) derivada no parâmetro u. */
  eval(u: number, k: 0 | 1 | 2 = 0): Vec3 {
    const { t, pts, m } = this;
    const n = t.length;
    if (n === 2 && !this.periodic && m.every((x) => len(x) === 0)) {
      const h = t[1] - t[0];
      if (k === 0) return lerp(pts[0], pts[1], (u - t[0]) / h);
      return k === 1 ? mul(sub(pts[1], pts[0]), 1 / h) : [0, 0, 0];
    }
    let i = 0;
    if (u >= t[n - 1]) i = n - 2;
    else if (u > t[0]) { let lo = 0, hi = n - 1; while (hi - lo > 1) { const c = (lo + hi) >> 1; if (t[c] <= u) lo = c; else hi = c; } i = lo; }
    const h = t[i + 1] - t[i];
    const a = (t[i + 1] - u) / h, b = (u - t[i]) / h;
    const P0 = pts[i], P1 = pts[i + 1], M0 = m[i], M1 = m[i + 1];
    if (k === 0) {
      // S = a·P0 + b·P1 + ((a³−a)·M0 + (b³−b)·M1)·h²/6
      return add(add(mul(P0, a), mul(P1, b)), mul(add(mul(M0, a * a * a - a), mul(M1, b * b * b - b)), (h * h) / 6));
    }
    if (k === 1) return add(mul(sub(P1, P0), 1 / h), mul(add(mul(M0, -(3 * a * a - 1)), mul(M1, 3 * b * b - 1)), h / 6));
    return add(mul(M0, a), mul(M1, b));
  }
}

/** Sistema tridiagonal (Thomas) com lados direitos vetoriais. */
function thomas(sub_: number[], diag: number[], sup: number[], rhs: Vec3[]): Vec3[] {
  const n = diag.length;
  const c = sup.slice(), d = rhs.map((x) => x.slice() as Vec3), b = diag.slice();
  for (let i = 1; i < n; i++) {
    const w = sub_[i] / b[i - 1];
    b[i] -= w * c[i - 1];
    d[i] = sub(d[i], mul(d[i - 1], w));
  }
  const x: Vec3[] = new Array(n);
  x[n - 1] = mul(d[n - 1], 1 / b[n - 1]);
  for (let i = n - 2; i >= 0; i--) x[i] = mul(sub(d[i], mul(x[i + 1], c[i])), 1 / b[i]);
  return x;
}

function solveOpen(t: number[], p: Vec3[], start: EndCond, end: EndCond): Vec3[] {
  const n = p.length;
  const h = (i: number) => t[i + 1] - t[i];
  const lo = new Array(n).fill(0), di = new Array(n).fill(0), up = new Array(n).fill(0);
  const r: Vec3[] = Array.from({ length: n }, () => [0, 0, 0]);
  const slope = (i: number) => mul(sub(p[i + 1], p[i]), 1 / h(i));
  if (start.kind === "natural") di[0] = 1;
  else { di[0] = h(0) / 3; up[0] = h(0) / 6; r[0] = sub(slope(0), start.d); }
  if (end.kind === "natural") di[n - 1] = 1;
  else { lo[n - 1] = h(n - 2) / 6; di[n - 1] = h(n - 2) / 3; r[n - 1] = sub(end.d, slope(n - 2)); }
  for (let i = 1; i < n - 1; i++) {
    lo[i] = h(i - 1) / 6; di[i] = (h(i - 1) + h(i)) / 3; up[i] = h(i) / 6;
    r[i] = sub(slope(i), slope(i - 1));
  }
  return thomas(lo, di, up, r);
}

/** Spline periódica: sistema cíclico resolvido por eliminação densa (os casos são pequenos). */
function solvePeriodic(t: number[], p: Vec3[]): Vec3[] {
  const n = p.length - 1; // o último ponto repete o primeiro
  if (n < 2) throw new Error("Spline periódica: são precisos pelo menos 3 pontos");
  const h = (i: number) => t[i + 1] - t[i];
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const r: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const hp = i === 0 ? h(n - 1) : h(i - 1), hn = h(i);
    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    A[i][prev] += hp / 6; A[i][i] += (hp + hn) / 3; A[i][next] += hn / 6;
    const pi = p[i], pn = p[i + 1], pp = i === 0 ? p[n - 1] : p[i - 1];
    r.push(sub(mul(sub(pn, pi), 1 / hn), mul(sub(pi, pp), 1 / hp)));
  }
  const m = gauss(A, r);
  return [...m, m[0]];
}

function gauss(A: number[][], b: Vec3[]): Vec3[] {
  const n = A.length;
  const M = A.map((row) => row.slice());
  const r = b.map((x) => x.slice() as Vec3);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[piv][c])) piv = i;
    [M[c], M[piv]] = [M[piv], M[c]];
    [r[c], r[piv]] = [r[piv], r[c]];
    for (let i = c + 1; i < n; i++) {
      const w = M[i][c] / M[c][c];
      if (!w) continue;
      for (let k = c; k < n; k++) M[i][k] -= w * M[c][k];
      r[i] = sub(r[i], mul(r[c], w));
    }
  }
  const x: Vec3[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = r[i];
    for (let k = i + 1; k < n; k++) s = sub(s, mul(x[k], M[i][k]));
    x[i] = mul(s, 1 / M[i][i]);
  }
  return x;
}

/** Parâmetros por comprimento de corda (acumulado) de uma sequência de pontos. */
export function chordParams(p: Vec3[]): number[] {
  const s = cumulative(p);
  // pontos coincidentes: espaçamento mínimo para a spline continuar definida
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] < 1e-9) s[i] = s[i - 1] + 1e-6;
  return s;
}

// ---------------------------------------------------------------------------
// Multi-secção (skinning) e superfície de Gordon
// ---------------------------------------------------------------------------

export interface SkinInput {
  /** Secções já amostradas com o mesmo número de pontos (mesmo sentido e costura alinhada). */
  sections: Vec3[][];
  /** Parâmetro de cada secção na direção transversal (crescente). */
  v: number[];
  /** Derivadas impostas (∂S/∂v) ao longo da primeira/última secção, um vetor por ponto. */
  startD?: Vec3[];
  endD?: Vec3[];
  /** Amostras por troço entre secções na grelha de saída. */
  perSpan?: number;
}

/** Grelha [u][v] da superfície que interpola as secções (splines C2 transversais). */
export function skinGrid(inp: SkinInput): { grid: Vec3[][]; vs: number[] } {
  const { sections, v } = inp;
  const nu = sections[0].length;
  const per = inp.perSpan ?? 8;
  const vs: number[] = [];
  for (let i = 0; i + 1 < v.length; i++) for (let k = 0; k < per; k++) vs.push(v[i] + ((v[i + 1] - v[i]) * k) / per);
  vs.push(v[v.length - 1]);
  const grid: Vec3[][] = [];
  for (let j = 0; j < nu; j++) {
    const col = sections.map((s) => s[j]);
    const sp = new Spline(v, col,
      inp.startD ? { kind: "clamped", d: inp.startD[j] } : NATURAL,
      inp.endD ? { kind: "clamped", d: inp.endD[j] } : NATURAL);
    grid.push(vs.map((x) => sp.eval(x)));
  }
  return { grid, vs };
}

export interface GordonInput {
  /** Secções C_i(u), amostradas em `nu` pontos já reparametrizados de modo que a guia j esteja em u = uG[j]. */
  sections: Vec3[][];
  /** Guias G_j(v), amostradas em `nv` pontos reparametrizados de modo que a secção i esteja em v = vS[i]. */
  guides: Vec3[][];
  uG: number[]; // parâmetros (0…1) das guias nas secções
  vS: number[]; // parâmetros (0…1) das secções nas guias
  closedU?: boolean;
  startD?: Vec3[]; // ∂S/∂v na primeira secção (por ponto u)
  endD?: Vec3[];
}

/**
 * Superfície de Gordon S = S_secções + S_guias − T, avaliada numa grelha [u][v] (nu × nv), que passa
 * exatamente pelas secções e pelas guias (rede compatível: cada guia corta cada secção).
 */
export function gordonGrid(g: GordonInput): Vec3[][] {
  const nu = g.sections[0].length, nv = g.guides[0].length;
  const us = Array.from({ length: nu }, (_, i) => i / (nu - 1));
  const vs = Array.from({ length: nv }, (_, i) => i / (nv - 1));
  const idxU = (u: number) => Math.round(u * (nu - 1));
  // interpolação em u (através das guias) com spline periódica se as secções forem fechadas
  const uSpline = (vals: Vec3[]) => {
    if (vals.length === 1) return () => vals[0];
    if (g.closedU) {
      const t = [...g.uG, g.uG[0] + 1];
      const sp = new Spline(t, [...vals, vals[0]], NATURAL, NATURAL, vals.length >= 2);
      return (u: number) => sp.eval(u < g.uG[0] ? u + 1 : u);
    }
    const sp = new Spline(g.uG, vals);
    return (u: number) => sp.eval(u);
  };
  const vSpline = (vals: Vec3[], j?: number) => {
    const sp = new Spline(g.vS, vals,
      g.startD && j !== undefined ? { kind: "clamped", d: g.startD[j] } : NATURAL,
      g.endD && j !== undefined ? { kind: "clamped", d: g.endD[j] } : NATURAL);
    return (v: number) => sp.eval(v);
  };
  // S1: secções interpoladas em v, coluna a coluna (u fixo)
  const S1 = us.map((_, j) => { const f = vSpline(g.sections.map((s) => s[j]), j); return vs.map((v) => f(v)); });
  // S2: guias interpoladas em u, linha a linha (v fixo)
  const S2rows = vs.map((_, k) => { const f = uSpline(g.guides.map((c) => c[k])); return us.map((u) => f(u)); });
  // T: interpolação tensorial dos pontos de interseção P_ij = C_i(uG_j)
  const P = g.sections.map((s) => g.uG.map((u) => s[idxU(u)]));
  // as colunas de T usam as mesmas derivadas impostas que S1 nas colunas das guias: assim ∂S/∂v na
  // primeira/última secção é a imposta sempre que as guias lhe são tangentes
  const Tcols = g.uG.map((u, j) => vSpline(P.map((row) => row[j]), idxU(u)));
  const Trows = vs.map((v) => { const f = uSpline(Tcols.map((c) => c(v))); return us.map((u) => f(u)); });
  return us.map((_, j) => vs.map((_, k) => sub(add(S1[j][k], S2rows[k][j]), Trows[k][j])));
}

// ---------------------------------------------------------------------------
// Concordância (blend) por Hermite
// ---------------------------------------------------------------------------

export interface HermiteEnd {
  p: Vec3;
  /** Derivada imposta (∂S/∂v) neste extremo; omitida = contacto (G0). */
  d?: Vec3;
  /** Segunda derivada imposta (G2); omitida = livre. */
  dd?: Vec3;
}

/**
 * Polos de Bézier no sentido transversal entre dois extremos: cúbica (G1) ou quíntica (G2).
 * Os extremos sem derivada usam a corda (contacto).
 */
export function hermitePoles(a: HermiteEnd, b: HermiteEnd): Vec3[] {
  const chord = sub(b.p, a.p);
  const da = a.d ?? chord, db = b.d ?? chord;
  if (!a.dd && !b.dd) return [a.p, add(a.p, mul(da, 1 / 3)), sub(b.p, mul(db, 1 / 3)), b.p];
  // quíntica: S'(0) = 5(P1−P0), S''(0) = 20(P2 − 2P1 + P0); simétrico no fim
  const P1 = add(a.p, mul(da, 1 / 5));
  const P4 = sub(b.p, mul(db, 1 / 5));
  const P2 = a.dd ? sub(add(mul(a.dd, 1 / 20), mul(P1, 2)), a.p) : lerp(P1, P4, 1 / 3);
  const P3 = b.dd ? sub(add(mul(b.dd, 1 / 20), mul(P4, 2)), b.p) : lerp(P1, P4, 2 / 3);
  return [a.p, P1, P2, P3, P4, b.p];
}

/** Ponto de uma curva de Bézier (de Casteljau). */
export function bezier(poles: Vec3[], t: number): Vec3 {
  let q = poles.slice();
  while (q.length > 1) q = q.slice(1).map((p, i) => lerp(q[i], p, t));
  return q[0];
}

/** Derivadas de ordem k de uma Bézier em t (pela hodógrafa). */
export function bezierDeriv(poles: Vec3[], t: number, k: number): Vec3 {
  let q = poles.slice();
  for (let r = 0; r < k; r++) {
    const n = q.length - 1;
    if (n < 1) return [0, 0, 0];
    q = q.slice(1).map((p, i) => mul(sub(p, q[i]), n));
  }
  return bezier(q, t);
}

// ---------------------------------------------------------------------------
// Círculos
// ---------------------------------------------------------------------------

/** Círculo por 3 pontos: centro, raio e normal do plano (null se forem colineares). */
export function circle3(a: Vec3, b: Vec3, c: Vec3): { c: Vec3; r: number; n: Vec3 } | null {
  const ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18 * Math.max(1, dot(ab, ab) * dot(ac, ac))) return null;
  const k = add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab)));
  const ctr = add(a, mul(k, 1 / (2 * n2)));
  return { c: ctr, r: dist(ctr, a), n: norm(n) };
}

/** Arco de `a` até `c` que passa por `b` (n pontos). */
export function arcThrough3(a: Vec3, b: Vec3, c: Vec3, n: number): Vec3[] {
  const cc = circle3(a, b, c);
  if (!cc) return Array.from({ length: n }, (_, i) => lerp(a, c, i / (n - 1)));
  const x = norm(sub(a, cc.c)), y = cross(cc.n, x);
  const ang = (p: Vec3) => { const d = sub(p, cc.c); let t = Math.atan2(dot(d, y), dot(d, x)); if (t < 0) t += 2 * Math.PI; return t; };
  const tc = ang(c) || 2 * Math.PI;
  return Array.from({ length: n }, (_, i) => {
    const t = (tc * i) / (n - 1);
    return add(cc.c, add(mul(x, cc.r * Math.cos(t)), mul(y, cc.r * Math.sin(t))));
  });
}

/**
 * Arco de raio r entre a e b, no plano de normal `n` (os dois pontos têm de estar nesse plano, a
 * distância ≤ 2r). `side` escolhe um dos dois centros possíveis; `long` o arco maior.
 */
export function arcRadius(a: Vec3, b: Vec3, r: number, n: Vec3, nPts: number, side = 1, long = false): Vec3[] | null {
  const ab = sub(b, a);
  const d = len(ab);
  if (d < 1e-12 || d > 2 * r * (1 + 1e-9)) return null;
  const m = lerp(a, b, 0.5);
  const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
  const perp = norm(cross(n, ab));
  const c = add(m, mul(perp, side * h));
  const x = norm(sub(a, c)), y = norm(cross(n, x));
  let tb = Math.atan2(dot(sub(b, c), y), dot(sub(b, c), x));
  // arco menor por defeito (|tb| ≤ π), maior se pedido
  if (long) tb = tb > 0 ? tb - 2 * Math.PI : tb + 2 * Math.PI;
  return Array.from({ length: nPts }, (_, i) => {
    const t = (tb * i) / (nPts - 1);
    return add(c, add(mul(x, r * Math.cos(t)), mul(y, r * Math.sin(t))));
  });
}
