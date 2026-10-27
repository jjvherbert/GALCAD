// Solver de mates de montagem (restrições entre corpos rígidos 3D), em TypeScript puro.
//
// Cada componente livre tem 6 incógnitas: translação t e vetor de rotação ω (Rodrigues), aplicados
// sobre a pose inicial: R = exp(ω)·R0, p = R0+t. Cada mate dá resíduos que se anulam quando é cumprido.
// Resolve-se com Levenberg–Marquardt e Jacobiano numérico; os graus de liberdade livres são
// 6·(livres) − característica(J). Como as normais podem ter de rodar 180°, tentam-se vários arranques.
import type { MateKind } from "../doc/project.ts";
import type { Vec3 } from "../doc/types.ts";

export type Mat3 = [number, number, number, number, number, number, number, number, number]; // por linhas

/** Geometria de referência de um mate, no referencial do componente. */
export type MateGeom =
  | { kind: "plane"; p: Vec3; n: Vec3 }
  | { kind: "axis"; p: Vec3; d: Vec3; r?: number }
  | { kind: "point"; p: Vec3 };

export interface Pose { R: Mat3; t: Vec3 }

export interface SolverComponent { id: string; fixed: boolean; pose: Pose }

export interface SolverMate {
  id: string;
  kind: MateKind;
  /** Componente (null = origem da montagem, fixa). */
  a: string | null;
  ga: MateGeom;
  b: string | null;
  gb: MateGeom;
  /** Distância (mm) ou ângulo (rad). */
  value?: number;
  align?: "aligned" | "anti";
}

export interface SolveResult {
  ok: boolean;
  poses: Map<string, Pose>;
  dof: number;
  residuals: Map<string, number>;
  /** Mates não cumpridos (conflito, impossível ou geometria incompatível). */
  failed: { id: string; error: string }[];
  iterations: number;
}

// --- álgebra -----------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const mv = (R: Mat3, v: Vec3): Vec3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
export function mm(A: Mat3, B: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return o;
}
export const transpose = (R: Mat3): Mat3 => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];

/** Matriz de rotação de um vetor de rotação (fórmula de Rodrigues). */
export function rodrigues(w: Vec3): Mat3 {
  const th = norm(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = mul(w, 1 / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Rotação a partir de ângulos (graus) em torno de X, depois Y, depois Z (eixos fixos). */
export function eulerXYZ(r: Vec3): Mat3 {
  const D = Math.PI / 180;
  return mm(rodrigues([0, 0, r[2] * D]), mm(rodrigues([0, r[1] * D, 0]), rodrigues([r[0] * D, 0, 0])));
}

export const composePose = (a: Pose, b: Pose): Pose => ({ R: mm(a.R, b.R), t: add(mv(a.R, b.t), a.t) });
export const applyPose = (P: Pose, p: Vec3): Vec3 => add(mv(P.R, p), P.t);

/** Matriz 4×4 por colunas (three.js). */
export const poseMatrix = (P: Pose): number[] => [P.R[0], P.R[3], P.R[6], 0, P.R[1], P.R[4], P.R[7], 0, P.R[2], P.R[5], P.R[8], 0, P.t[0], P.t[1], P.t[2], 1];

// --- resíduos ---------------------------------------------------------------------------

type World = { kind: "plane"; p: Vec3; n: Vec3 } | { kind: "axis"; p: Vec3; d: Vec3; r?: number } | { kind: "point"; p: Vec3 };

function toWorld(g: MateGeom, P: Pose): World {
  if (g.kind === "plane") return { kind: "plane", p: applyPose(P, g.p), n: mv(P.R, g.n) };
  if (g.kind === "axis") return { kind: "axis", p: applyPose(P, g.p), d: mv(P.R, g.d), r: g.r };
  return { kind: "point", p: applyPose(P, g.p) };
}

const dirOf = (g: World): Vec3 | null => (g.kind === "plane" ? g.n : g.kind === "axis" ? g.d : null);

/** Resíduos de um mate (zero quando cumprido). Lança se a combinação de geometrias não fizer sentido. */
function residuals(m: SolverMate, A: World, B: World): number[] {
  // ordenar para reduzir combinações: plane < axis < point
  const rank = { plane: 0, axis: 1, point: 2 } as const;
  if (rank[A.kind] > rank[B.kind]) [A, B] = [B, A];
  const v = m.value ?? 0;
  const s = m.align === "aligned" ? -1 : 1; // anti: n1 + n2 = 0
  const dirMatch = (d1: Vec3, d2: Vec3, defaultFree: boolean) =>
    m.align === undefined && defaultFree ? cross(d1, d2) : add(d1, mul(d2, s));
  switch (m.kind) {
    case "coincident":
    case "distance": {
      if (A.kind === "plane" && B.kind === "plane") return [...dirMatch(A.n, B.n, false), dot(sub(B.p, A.p), A.n) - v];
      if (A.kind === "plane" && B.kind === "axis") return [dot(B.d, A.n), dot(sub(B.p, A.p), A.n) - v];
      if (A.kind === "plane" && B.kind === "point") return [dot(sub(B.p, A.p), A.n) - v];
      if (A.kind === "axis" && B.kind === "axis") {
        if (m.kind === "distance") return [...cross(A.d, B.d), norm(cross(sub(B.p, A.p), A.d)) - v];
        return [...dirMatch(A.d, B.d, true), ...cross(sub(B.p, A.p), A.d)];
      }
      if (A.kind === "axis" && B.kind === "point") return m.kind === "distance" ? [norm(cross(sub(B.p, A.p), A.d)) - v] : cross(sub(B.p, A.p), A.d);
      if (A.kind === "point" && B.kind === "point") return m.kind === "distance" ? [norm(sub(B.p, A.p)) - v] : sub(B.p, A.p);
      break;
    }
    case "concentric": {
      if (A.kind === "axis" && B.kind === "axis") return [...dirMatch(A.d, B.d, true), ...cross(sub(B.p, A.p), A.d)];
      if (A.kind === "axis" && B.kind === "point") return cross(sub(B.p, A.p), A.d);
      break;
    }
    case "parallel": {
      const d1 = dirOf(A), d2 = dirOf(B);
      if (!d1 || !d2) break;
      if (A.kind === "plane" && B.kind === "axis") return [dot(A.n, B.d)];
      return m.align ? add(d1, mul(d2, s)) : cross(d1, d2);
    }
    case "perpendicular": {
      const d1 = dirOf(A), d2 = dirOf(B);
      if (!d1 || !d2) break;
      if (A.kind === "plane" && B.kind === "axis") return cross(A.n, B.d);
      return [dot(d1, d2)];
    }
    case "angle": {
      const d1 = dirOf(A), d2 = dirOf(B);
      if (!d1 || !d2) break;
      return [dot(d1, d2) - Math.cos(v)];
    }
    case "tangent": {
      if (A.kind === "plane" && B.kind === "axis" && B.r) return [dot(B.d, A.n), dot(sub(B.p, A.p), A.n) - s * B.r];
      if (A.kind === "axis" && B.kind === "axis" && A.r && B.r) return [...cross(A.d, B.d), norm(cross(sub(B.p, A.p), A.d)) - (A.r + B.r)];
      break;
    }
    case "lock": break; // tratado à parte
  }
  throw new Error(`Combinação não suportada: ${m.kind} entre ${A.kind} e ${B.kind}`);
}

// --- resolução ------------------------------------------------------------------------

/** Característica de uma matriz m×n (eliminação de Gauss com pivô, tolerância relativa). */
export function matrixRank(J: number[][], tol = 1e-7): number {
  const A = J.map((r) => r.slice());
  const m = A.length, n = A[0]?.length ?? 0;
  const scale = Math.max(1e-300, ...A.flat().map(Math.abs));
  let rank = 0;
  for (let c = 0; c < n && rank < m; c++) {
    let piv = rank;
    for (let r = rank + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) <= tol * scale) continue;
    [A[rank], A[piv]] = [A[piv], A[rank]];
    for (let r = rank + 1; r < m; r++) {
      const f = A[r][c] / A[rank][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[rank][k];
    }
    rank++;
  }
  return rank;
}

/** Resolve (JᵀJ + λD) dx = −Jᵀf por Cholesky simples (matriz simétrica definida positiva). */
function solveNormal(J: number[][], f: number[], lambda: number): number[] {
  const n = J[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const g = new Array(n).fill(0);
  for (let r = 0; r < J.length; r++) {
    const row = J[r];
    for (let i = 0; i < n; i++) {
      if (!row[i]) continue;
      g[i] -= row[i] * f[r];
      for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += lambda * (A[i][i] + 1e-9);
  // eliminação de Gauss (n pequeno)
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [g[c], g[piv]] = [g[piv], g[c]];
    if (Math.abs(A[c][c]) < 1e-300) continue;
    for (let r = c + 1; r < n; r++) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
      g[r] -= k * g[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = g[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = Math.abs(A[i][i]) < 1e-300 ? 0 : s / A[i][i];
  }
  return x;
}

/**
 * Resolve os mates. `size` é o comprimento característico (mm) para escalar translações e tolerâncias.
 */
export function solveMates(components: SolverComponent[], mates: SolverMate[], size = 100): SolveResult {
  const free = components.filter((c) => !c.fixed);
  const index = new Map(free.map((c, i) => [c.id, i]));
  const base = new Map(components.map((c) => [c.id, c.pose]));
  const n = free.length * 6;
  const L = Math.max(1, size);
  const tol = 1e-7 * L;

  // poses a partir das incógnitas (translação escalada por L)
  const posesOf = (x: number[], starts: Mat3[]): Map<string, Pose> => {
    const out = new Map<string, Pose>();
    for (const c of components) {
      const i = index.get(c.id);
      if (i === undefined) { out.set(c.id, c.pose); continue; }
      const o = i * 6;
      const R0 = mm(starts[i], c.pose.R);
      out.set(c.id, { R: mm(rodrigues([x[o + 3], x[o + 4], x[o + 5]]), R0), t: add(c.pose.t, [x[o] * L, x[o + 1] * L, x[o + 2] * L]) });
    }
    return out;
  };
  const ground: Pose = { R: I3, t: [0, 0, 0] };
  const poseOf = (poses: Map<string, Pose>, id: string | null) => (id === null ? ground : poses.get(id) ?? ground);

  // mates "lock": três pontos do componente b, vistos no referencial de a, ficam como estavam
  const lockRef = new Map<string, Vec3[]>();
  const lockPts: Vec3[] = [[0, 0, 0], [L, 0, 0], [0, L, 0]];
  const relPts = (poses: Map<string, Pose>, m: SolverMate) => {
    const A = poseOf(poses, m.a), B = poseOf(poses, m.b);
    const RT = transpose(A.R);
    return lockPts.map((q) => mv(RT, sub(applyPose(B, q), A.t)));
  };
  for (const m of mates) if (m.kind === "lock") lockRef.set(m.id, relPts(base, m));

  const failedGeom: { id: string; error: string }[] = [];
  const active = mates.filter((m) => {
    if (m.a === m.b) { failedGeom.push({ id: m.id, error: "As duas referências são do mesmo componente" }); return false; }
    if (m.kind === "lock") return true;
    try { residuals(m, toWorld(m.ga, ground), toWorld(m.gb, ground)); return true; } catch (e) { failedGeom.push({ id: m.id, error: (e as Error).message }); return false; }
  });

  const evalF = (poses: Map<string, Pose>) => {
    const f: number[] = [];
    const per: number[][] = [];
    for (const m of active) {
      let r: number[];
      if (m.kind === "lock") {
        const now = relPts(poses, m), ref = lockRef.get(m.id)!;
        r = now.flatMap((p, k) => sub(p, ref[k])).map((x) => x / L);
      } else {
        r = residuals(m, toWorld(m.ga, poseOf(poses, m.a)), toWorld(m.gb, poseOf(poses, m.b)));
        // resíduos de posição em mm → adimensionais
        r = r.map((x, k) => (isLengthResidual(m, k, r.length) ? x / L : x));
      }
      per.push(r);
      f.push(...r);
    }
    return { f, per };
  };

  const norm2 = (f: number[]) => f.reduce((s, x) => s + x * x, 0);
  const run = (starts: Mat3[]) => {
    let x = new Array(n).fill(0);
    let { f } = evalF(posesOf(x, starts));
    let cost = norm2(f);
    let lambda = 1e-3;
    let it = 0;
    for (; it < 200 && cost > 1e-24 && n > 0; it++) {
      const J = jacobian((xx) => evalF(posesOf(xx, starts)).f, x, f);
      const dx = solveNormal(J, f, lambda);
      const xn = x.map((v, i) => v + dx[i]);
      const fn = evalF(posesOf(xn, starts)).f;
      const cn = norm2(fn);
      if (cn < cost) { x = xn; f = fn; cost = cn; lambda = Math.max(1e-9, lambda / 3); }
      else { lambda *= 4; if (lambda > 1e8) break; }
      if (dx.every((d) => Math.abs(d) < 1e-14)) break;
    }
    return { x, f, cost, it, starts };
  };

  // arranques: sem rotação extra e com rotações de 180°/90° de todos os componentes livres
  const turns: Mat3[] = [I3, rodrigues([Math.PI, 0, 0]), rodrigues([0, Math.PI, 0]), rodrigues([0, 0, Math.PI]), rodrigues([Math.PI / 2, 0, 0]), rodrigues([-Math.PI / 2, 0, 0]), rodrigues([0, Math.PI / 2, 0]), rodrigues([0, -Math.PI / 2, 0])];
  let best = run(free.map(() => I3));
  const goal = (tol / L) ** 2;
  for (let k = 1; k < turns.length && best.cost > goal; k++) {
    const r = run(free.map(() => turns[k]));
    if (r.cost < best.cost) best = r;
    // um componente de cada vez (montagens com vários livres)
    for (let c = 0; c < free.length && best.cost > goal && free.length > 1; c++) {
      const starts = best.starts.slice();
      starts[c] = mm(turns[k], starts[c]);
      const r2 = run(starts);
      if (r2.cost < best.cost) best = r2;
    }
  }

  const poses = posesOf(best.x, best.starts);
  const { per } = evalF(poses);
  const residualsOut = new Map<string, number>();
  const failed = [...failedGeom];
  active.forEach((m, i) => {
    const r = Math.sqrt(norm2(per[i]));
    residualsOut.set(m.id, r);
    if (r > 1e-6) failed.push({ id: m.id, error: "Não cumprido (conflito com outros mates ou geometria impossível)" });
  });
  let dof = n;
  if (n > 0 && best.f.length) {
    const J = jacobian((xx) => evalF(posesOf(xx, best.starts)).f, best.x, best.f);
    dof = n - matrixRank(J, 1e-6);
  }
  return { ok: failed.length === 0, poses, dof, residuals: residualsOut, failed, iterations: best.it };
}

/** Os resíduos de posição (mm) são escalados; os de direção já são adimensionais. */
function isLengthResidual(m: SolverMate, k: number, len: number): boolean {
  const kinds = [m.ga.kind, m.gb.kind].sort().join("-");
  switch (m.kind) {
    case "coincident": case "distance":
      if (kinds === "plane-plane") return k === 3;
      if (kinds === "axis-plane") return k === 1;
      if (kinds === "axis-axis") return m.kind === "distance" ? k === 3 : k >= 3;
      return true; // ponto-plano, ponto-eixo, ponto-ponto
    case "concentric": return kinds === "axis-axis" ? k >= 3 : true;
    case "tangent": return k === len - 1;
    default: return false;
  }
}

function jacobian(F: (x: number[]) => number[], x: number[], f0: number[]): number[][] {
  const h = 1e-7;
  const J = f0.map(() => new Array(x.length).fill(0));
  for (let j = 0; j < x.length; j++) {
    const xp = x.slice(); xp[j] += h;
    const xm = x.slice(); xm[j] -= h;
    const fp = F(xp), fm = F(xm);
    for (let i = 0; i < f0.length; i++) J[i][j] = (fp[i] - fm[i]) / (2 * h);
  }
  return J;
}
