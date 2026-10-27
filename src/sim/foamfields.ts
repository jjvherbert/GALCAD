// Campos do OpenFOAM para o visualizador: pressão e velocidade nos patches e em cortes planos da
// malha poliédrica (polyMesh), a partir dos ficheiros ASCII do último tempo. Puro: usado pelo agente.
//
// Método: valores de célula interpolados para os pontos pela média das células vizinhas; nos patches
// com valor imposto (entrada, paredes noSlip) o ponto toma o valor do patch. Os cortes intersetam as
// arestas de cada célula com o plano e triangulam o polígono resultante (células convexas, como as do
// snappyHexMesh); os valores nos vértices do corte vêm da interpolação linear ao longo da aresta.
import type { FoamMesh } from "./foamread.ts";
import type { ResultLayer } from "./result.ts";

/** Campo (escalar ou vetorial) com o tipo e o valor escritos em cada patch. */
export interface FoamField {
  /** Valores internos por célula (n componentes cada) ou um valor uniforme. */
  internal: number[][] | number[];
  patches: Map<string, { type: string; value: number[][] | number[] | null }>;
}

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/FoamFile\s*\{[\s\S]*?\}/, "");

/**
 * Lê "uniform x", "uniform (x y z)" ou "nonuniform List<scalar|vector> N (…)" a partir do início de
 * `s`: uniforme → componentes; não uniforme → componentes de cada elemento.
 */
function parseValue(s: string): number[][] | number[] | null {
  const u = /^\s*uniform\s+(\([^()]*\)|[-+\deE.]+)/.exec(s);
  if (u) return u[1].startsWith("(") ? u[1].slice(1, -1).trim().split(/\s+/).map(Number) : [Number(u[1])];
  const nu = /^\s*nonuniform\s+List<(scalar|vector)>\s*(\d+)\s*\(/.exec(s);
  if (!nu) return null;
  let depth = 1, i = nu.index + nu[0].length;
  const start = i;
  for (; i < s.length && depth > 0; i++) { if (s[i] === "(") depth++; else if (s[i] === ")") depth--; }
  const body = s.slice(start, i - 1);
  if (nu[1] === "scalar") return body.trim().split(/\s+/).map((x) => [Number(x)]);
  return [...body.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}

export function readField(text: string): FoamField {
  const t = strip(text);
  const im = /internalField\s+/.exec(t);
  const internal = (im ? parseValue(t.slice(im.index + im[0].length)) : null) ?? [0];
  const patches: FoamField["patches"] = new Map();
  const bf = t.indexOf("boundaryField");
  if (bf >= 0) {
    const body = t.slice(bf + "boundaryField".length);
    const open = body.indexOf("{");
    let i = open + 1;
    while (i < body.length) {
      const m = /\s*(\w+)\s*\{/y;
      m.lastIndex = i;
      const h = m.exec(body);
      if (!h) break;
      let depth = 1, j = m.lastIndex;
      const start = j;
      for (; j < body.length && depth > 0; j++) { if (body[j] === "{") depth++; else if (body[j] === "}") depth--; }
      const blk = body.slice(start, j - 1);
      const type = /\btype\s+(\w+)\s*;/.exec(blk)?.[1] ?? "";
      const v = /\bvalue\s+/.exec(blk);
      patches.set(h[1], { type, value: v ? parseValue(blk.slice(v.index + v[0].length)) : null });
      i = j;
    }
  }
  return { internal, patches };
}

/** Valor (componentes) da célula `c`. */
const cellValue = (f: FoamField, c: number): number[] => (Array.isArray(f.internal[0]) ? (f.internal as number[][])[c] : (f.internal as number[]));

/** Valor (componentes) da face `k` de um patch: o escrito ou, se não houver, o da célula vizinha. */
function faceValue(f: FoamField, mesh: FoamMesh, patch: string, k: number, ncomp: number): number[] {
  const p = f.patches.get(patch);
  const b = mesh.boundary.get(patch)!;
  if (p?.type === "noSlip") return new Array(ncomp).fill(0);
  const v = p?.value;
  if (v) return Array.isArray(v[0]) ? (v as number[][])[k] : (v as number[]);
  return cellValue(f, mesh.owner[b.start + k]);
}

export interface FoamMeshFull extends FoamMesh { neighbour: number[] }

/**
 * Valores nos pontos da malha: média das células que os contêm; nos patches com valor imposto
 * (fixedValue, noSlip, inletOutlet com valor) o ponto fica com a média das faces desse patch.
 */
export function pointValues(f: FoamField, mesh: FoamMeshFull, ncomp: number): Float64Array {
  const np = mesh.points.length;
  const sum = new Float64Array(np * ncomp), cnt = new Float64Array(np);
  const add = (pt: number, v: number[]) => { cnt[pt]++; for (let q = 0; q < ncomp; q++) sum[pt * ncomp + q] += v[q]; };
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const o = cellValue(f, mesh.owner[fi]);
    for (const pt of mesh.faces[fi]) add(pt, o);
    if (fi < mesh.neighbour.length) { const nb = cellValue(f, mesh.neighbour[fi]); for (const pt of mesh.faces[fi]) add(pt, nb); }
  }
  for (let i = 0; i < np; i++) if (cnt[i]) for (let q = 0; q < ncomp; q++) sum[i * ncomp + q] /= cnt[i];
  // fronteiras com valor imposto
  const bsum = new Float64Array(np * ncomp), bcnt = new Float64Array(np);
  for (const [name, b] of mesh.boundary) {
    const p = f.patches.get(name);
    if (!p || !(p.type === "noSlip" || p.type === "fixedValue")) continue;
    for (let k = 0; k < b.n; k++) {
      const v = faceValue(f, mesh, name, k, ncomp);
      for (const pt of mesh.faces[b.start + k]) { bcnt[pt]++; for (let q = 0; q < ncomp; q++) bsum[pt * ncomp + q] += v[q]; }
    }
  }
  for (let i = 0; i < np; i++) if (bcnt[i]) for (let q = 0; q < ncomp; q++) sum[i * ncomp + q] = bsum[i * ncomp + q] / bcnt[i];
  return sum;
}

/** Um campo para as camadas: escalar derivado (ex.: |U|) a partir dos componentes. */
export interface LayerField { name: string; unit: string; field: FoamField; ncomp: number; map: (v: ArrayLike<number>) => number }

/** Triângulos (em leque) e valores nodais de um patch; posições em mm. */
export function patchLayer(name: string, mesh: FoamMeshFull, patch: string, fields: (LayerField | null)[], visible: boolean): ResultLayer | null {
  const b = mesh.boundary.get(patch);
  if (!b || !b.n) return null;
  const index = new Map<number, number>();
  const positions: number[] = [], triangles: number[] = [];
  for (let k = 0; k < b.n; k++) {
    const f = mesh.faces[b.start + k];
    const loc = f.map((pt) => { let i = index.get(pt); if (i === undefined) { i = index.size; index.set(pt, i); positions.push(...mesh.points[pt].map((x) => x * 1000)); } return i; });
    for (let q = 1; q + 1 < loc.length; q++) triangles.push(loc[0], loc[q], loc[q + 1]);
  }
  const values = fields.map((lf) => {
    if (!lf) return null;
    // média das faces do patch em cada ponto
    const s = new Float64Array(index.size), c = new Float64Array(index.size);
    for (let k = 0; k < b.n; k++) {
      const v = lf.map(faceValue(lf.field, mesh, patch, k, lf.ncomp));
      for (const pt of mesh.faces[b.start + k]) { const i = index.get(pt)!; s[i] += v; c[i]++; }
    }
    return [...s].map((x, i) => x / c[i]);
  });
  return { name, visible, positions, triangles, values };
}

/** Corte plano (ponto e normal em metros) com os campos interpolados; posições em mm. */
export function sliceLayer(name: string, mesh: FoamMeshFull, origin: number[], normal: number[], fields: (LayerField | null)[], visible: boolean): ResultLayer | null {
  const nn = Math.hypot(normal[0], normal[1], normal[2]);
  const n = normal.map((x) => x / nn);
  const pts = mesh.points;
  const tol = 1e-12;
  // distância com sinal (os pontos exatamente no plano passam para o lado positivo)
  const d = pts.map((p) => { const s = (p[0] - origin[0]) * n[0] + (p[1] - origin[1]) * n[1] + (p[2] - origin[2]) * n[2]; return Math.abs(s) < tol ? tol : s; });
  // base do plano para ordenar os vértices de cada polígono
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  for (let q = 0; q < 3; q++) u[q] /= ul;
  const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  // faces de cada célula
  let nCells = 0;
  for (const c of mesh.owner) if (c >= nCells) nCells = c + 1;
  const cellFaces: number[][] = Array.from({ length: nCells }, () => []);
  mesh.owner.forEach((c, fi) => cellFaces[c].push(fi));
  mesh.neighbour.forEach((c, fi) => cellFaces[c].push(fi));
  const pv = fields.map((lf) => (lf ? pointValues(lf.field, mesh, lf.ncomp) : null));
  const edgeIndex = new Map<string, number>();
  const positions: number[] = [], triangles: number[] = [];
  const values: number[][] = fields.map(() => []);
  const cut = (i: number, j: number) => {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    let k = edgeIndex.get(key);
    if (k !== undefined) return k;
    k = edgeIndex.size;
    edgeIndex.set(key, k);
    const t = d[i] / (d[i] - d[j]);
    const P = pts[i], Q = pts[j];
    positions.push(...[0, 1, 2].map((q) => (P[q] + t * (Q[q] - P[q])) * 1000));
    fields.forEach((lf, fi) => {
      const arr = pv[fi];
      if (!lf || !arr) return;
      const vi = Array.from(arr.subarray(i * lf.ncomp, (i + 1) * lf.ncomp)), vj = Array.from(arr.subarray(j * lf.ncomp, (j + 1) * lf.ncomp));
      values[fi].push(lf.map(vi.map((x, q) => x + t * (vj[q] - x))));
    });
    return k;
  };
  for (const faces of cellFaces) {
    const ids = new Set<number>();
    for (const fi of faces) {
      const f = mesh.faces[fi];
      for (let q = 0; q < f.length; q++) {
        const i = f[q], j = f[(q + 1) % f.length];
        if ((d[i] > 0) !== (d[j] > 0)) ids.add(cut(i, j));
      }
    }
    if (ids.size < 3) continue;
    const loop = [...ids];
    const c = [0, 1, 2].map((q) => loop.reduce((s, k) => s + positions[k * 3 + q], 0) / loop.length);
    const ang = (k: number) => {
      const r = [0, 1, 2].map((q) => positions[k * 3 + q] - c[q]);
      return Math.atan2(r[0] * w[0] + r[1] * w[1] + r[2] * w[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2]);
    };
    loop.sort((x, y) => ang(x) - ang(y));
    for (let q = 1; q + 1 < loop.length; q++) triangles.push(loop[0], loop[q], loop[q + 1]);
  }
  if (!triangles.length) return null;
  return { name, visible, positions, triangles, values: fields.map((lf, fi) => (lf ? values[fi] : null)) };
}
