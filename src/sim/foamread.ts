// Leitura mínima de ficheiros ASCII do OpenFOAM (campos e polyMesh) para resumir os resultados sem
// depender de function objects: caudal nos patches (phi) e pressão média por área (p nas células
// vizinhas do patch). Puro: usado pelo agente local.

/** Conteúdo entre o primeiro "(" depois do cabeçalho de lista "N (" e o ")" correspondente. */
function listBody(text: string, from = 0): { n: number; body: string; end: number } | null {
  const re = /(\d+)\s*\(/g;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  const start = i;
  for (; i < text.length && depth > 0; i++) { if (text[i] === "(") depth++; else if (text[i] === ")") depth--; }
  return { n: Number(m[1]), body: text.slice(start, i - 1), end: i };
}

const stripHeader = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/FoamFile\s*\{[\s\S]*?\}/, "");

export function readLabels(text: string): number[] {
  const l = listBody(stripHeader(text));
  return l ? l.body.trim().split(/\s+/).map(Number) : [];
}

export function readPoints(text: string): [number, number, number][] {
  const l = listBody(stripHeader(text));
  if (!l) return [];
  return [...l.body.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim().split(/\s+/).map(Number) as [number, number, number]);
}

export function readFaces(text: string): number[][] {
  const l = listBody(stripHeader(text));
  if (!l) return [];
  return [...l.body.matchAll(/\d+\s*\(([^()]+)\)/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}

/** Patches do ficheiro `boundary`: nome → { startFace, nFaces }. */
export function readBoundary(text: string): Map<string, { start: number; n: number }> {
  const out = new Map<string, { start: number; n: number }>();
  const t = stripHeader(text);
  for (const m of t.matchAll(/(\w+)\s*\{([^{}]*)\}/g)) {
    const n = /nFaces\s+(\d+)/.exec(m[2]), s = /startFace\s+(\d+)/.exec(m[2]);
    if (n && s) out.set(m[1], { start: Number(s[1]), n: Number(n[1]) });
  }
  return out;
}

/** Campo escalar: valores internos e, por patch, os valores escritos (ou null se o patch não os escreve). */
export function readScalarField(text: string): { internal: number[] | number; patches: Map<string, number[] | number | null> } {
  const t = stripHeader(text);
  const parse = (s: string): number[] | number | null => {
    const u = /^\s*uniform\s+([-+\deE.]+)/.exec(s);
    if (u) return Number(u[1]);
    const nu = /nonuniform\s+List<scalar>\s*/.exec(s);
    if (nu) { const l = listBody(s, nu.index); return l ? l.body.trim().split(/\s+/).map(Number) : null; }
    return null;
  };
  const im = /internalField\s+([\s\S]*?;)/.exec(t);
  const internal = im ? parse(t.slice(im.index + "internalField".length)) ?? 0 : 0;
  const patches = new Map<string, number[] | number | null>();
  const bf = t.indexOf("boundaryField");
  if (bf >= 0) {
    const body = t.slice(bf);
    for (const m of body.matchAll(/(\w+)\s*\{/g)) {
      if (m[1] === "boundaryField") continue;
      // bloco do patch até à chaveta correspondente
      let depth = 1, i = m.index! + m[0].length;
      const start = i;
      for (; i < body.length && depth > 0; i++) { if (body[i] === "{") depth++; else if (body[i] === "}") depth--; }
      const blk = body.slice(start, i - 1);
      const v = /\bvalue\s+([\s\S]*?;)/.exec(blk);
      patches.set(m[1], v ? parse(blk.slice(v.index + 5)) : null);
    }
  }
  return { internal: internal as number[] | number, patches };
}

const area = (pts: [number, number, number][], f: number[]) => {
  // área de um polígono plano pela soma dos produtos vetoriais a partir do primeiro vértice
  let ax = 0, ay = 0, az = 0;
  const p0 = pts[f[0]];
  for (let k = 1; k + 1 < f.length; k++) {
    const a = pts[f[k]], b = pts[f[k + 1]];
    const u = [a[0] - p0[0], a[1] - p0[1], a[2] - p0[2]], v = [b[0] - p0[0], b[1] - p0[1], b[2] - p0[2]];
    ax += u[1] * v[2] - u[2] * v[1]; ay += u[2] * v[0] - u[0] * v[2]; az += u[0] * v[1] - u[1] * v[0];
  }
  return 0.5 * Math.hypot(ax, ay, az);
};

export interface FoamMesh { points: [number, number, number][]; faces: number[][]; owner: number[]; boundary: Map<string, { start: number; n: number }> }

/** Soma de phi num patch (m³/s; negativa a entrar). */
export function patchFlux(phi: ReturnType<typeof readScalarField>, mesh: FoamMesh, patch: string): number {
  const v = phi.patches.get(patch);
  const b = mesh.boundary.get(patch);
  if (v === undefined || v === null || !b) return NaN;
  return typeof v === "number" ? v * b.n : v.reduce((s, x) => s + x, 0);
}

/** Média por área de um campo escalar num patch (valor escrito ou, se não houver, o da célula vizinha). */
export function patchAverage(field: ReturnType<typeof readScalarField>, mesh: FoamMesh, patch: string): number {
  const b = mesh.boundary.get(patch);
  if (!b) return NaN;
  const pv = field.patches.get(patch);
  let sa = 0, s = 0;
  for (let k = 0; k < b.n; k++) {
    const fi = b.start + k;
    const a = area(mesh.points, mesh.faces[fi]);
    const v = pv !== null && pv !== undefined ? (typeof pv === "number" ? pv : pv[k])
      : typeof field.internal === "number" ? field.internal : field.internal[mesh.owner[fi]];
    sa += a; s += a * v;
  }
  return s / sa;
}

/**
 * Força de pressão (cinemática × ρ = N) que o fluido exerce num patch: Σ p·S, com S a apontar para
 * fora do domínio de fluido (para dentro do corpo). Não inclui a parcela viscosa.
 */
export function patchPressureForce(p: ReturnType<typeof readScalarField>, mesh: FoamMesh, patch: string, rho: number): [number, number, number] {
  const b = mesh.boundary.get(patch);
  if (!b) return [NaN, NaN, NaN];
  const pv = p.patches.get(patch);
  const F: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < b.n; k++) {
    const fi = b.start + k;
    const f = mesh.faces[fi], pts = mesh.points;
    // vetor área do polígono (regra do triângulo em leque), na orientação da face (para fora do domínio)
    const S = [0, 0, 0];
    const p0 = pts[f[0]];
    for (let q = 1; q + 1 < f.length; q++) {
      const a = pts[f[q]], c = pts[f[q + 1]];
      const u = [a[0] - p0[0], a[1] - p0[1], a[2] - p0[2]], v = [c[0] - p0[0], c[1] - p0[1], c[2] - p0[2]];
      S[0] += 0.5 * (u[1] * v[2] - u[2] * v[1]); S[1] += 0.5 * (u[2] * v[0] - u[0] * v[2]); S[2] += 0.5 * (u[0] * v[1] - u[1] * v[0]);
    }
    const val = pv !== null && pv !== undefined ? (typeof pv === "number" ? pv : pv[k]) : typeof p.internal === "number" ? p.internal : p.internal[mesh.owner[fi]];
    for (let q = 0; q < 3; q++) F[q] += rho * val * S[q];
  }
  return F;
}
