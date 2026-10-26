// Nomeação topológica estável.
//
// Cada face do corpo tem um nome persistente derivado do histórico de construção:
//   f3:side:l2        face lateral gerada pela entidade l2 do esboço, na feature f3
//   f3:end:l1         tampa final da região (chave l1) da extrusão f3
//   f7:fil{A&B}       face de filete gerada a partir da aresta entre as faces A e B
//   f9:i2:f3:side:l2  instância 2 de um padrão (f9) da face f3:side:l2
//   NOME~1            segunda parte de uma face que foi dividida (ordem geométrica)
// As arestas são nomeadas pelas faces adjacentes: {A&B} (ordenadas), com #k se houver várias.
// As referências guardadas no documento (TopoRef) usam estes nomes, com pistas geométricas
// como último recurso.
import type { GeoHint, TopoRef, Vec3 } from "../doc/types.ts";
import { type Any, type TopoDS_Edge, type TopoDS_Face, type TopoDS_Shape, edgeProps, explore, faceProps, hash, listToArray, v3 } from "./occ.ts";

export interface NamedFace {
  face: TopoDS_Face;
  name: string;
  /** Outros nomes que convergiram nesta face (ex.: faces coplanares unidas). */
  aliases?: string[];
}

export interface NamedBody {
  shape: TopoDS_Shape;
  faces: NamedFace[];
}

export interface NamedEdge {
  edge: TopoDS_Edge;
  name: string;
  faces: string[];
}

/** Índice por hash para encontrar rapidamente a mesma face (IsSame). */
export class ShapeIndex<T> {
  private map = new Map<number, { s: TopoDS_Shape; v: T }[]>();
  set(s: TopoDS_Shape, v: T) {
    const h = hash(s);
    const b = this.map.get(h) ?? [];
    const i = b.findIndex((x) => x.s.IsSame(s));
    if (i >= 0) b[i].v = v;
    else b.push({ s, v });
    this.map.set(h, b);
  }
  get(s: TopoDS_Shape): T | undefined {
    return this.map.get(hash(s))?.find((x) => x.s.IsSame(s))?.v;
  }
  has(s: TopoDS_Shape) { return this.get(s) !== undefined; }
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
/** Chave de ordenação geométrica determinística (centro de massa). */
const geoKey = (c: Vec3) => [round(c[0]), round(c[1]), round(c[2])];
const cmpKey = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Ordena formas por posição (para sufixos ~k / #k determinísticos). */
export function sortByPosition<S extends TopoDS_Shape>(shapes: S[], center: (s: S) => Vec3): S[] {
  const keyed = shapes.map((s) => ({ s, k: geoKey(center(s)) }));
  keyed.sort((a, b) => cmpKey(a.k, b.k));
  return keyed.map((x) => x.s);
}

const faceCenter = (f: TopoDS_Face) => faceProps(f).center;

/** Builder OCC com histórico (BRepBuilderAPI_MakeShape / BRepAlgoAPI_*). */
export interface HistoryBuilder {
  Modified(s: TopoDS_Shape): Any;
  Generated(s: TopoDS_Shape): Any;
  IsDeleted(s: TopoDS_Shape): boolean;
}

/**
 * Nomeia as faces do resultado de uma operação a partir dos nomes das faces de entrada:
 * - faces intactas mantêm o nome;
 * - faces modificadas herdam o nome (com ~k se foram divididas);
 * - faces novas recebem o nome de `generated` (ex.: filetes a partir das arestas) ou um nome de recurso.
 */
export function nameResult(
  builder: HistoryBuilder,
  inputs: NamedFace[],
  result: TopoDS_Shape,
  fid: string,
  generated: { from: TopoDS_Shape; name: string }[] = [],
): NamedBody {
  const resultFaces = explore(result, "face");
  const inResult = new ShapeIndex<number>();
  resultFaces.forEach((f, i) => inResult.set(f, i));
  const names: (string[] | undefined)[] = resultFaces.map(() => undefined);
  const give = (f: TopoDS_Shape, n: string) => {
    const i = inResult.get(f);
    if (i === undefined) return;
    (names[i] ??= []).push(n);
  };

  for (const nf of inputs) {
    if (builder.IsDeleted(nf.face)) continue;
    const mods = listToArray(builder.Modified(nf.face)).filter((m) => inResult.has(m));
    if (mods.length === 0) {
      if (inResult.has(nf.face)) give(nf.face, nf.name);
    } else if (mods.length === 1) {
      give(mods[0], nf.name);
    } else {
      sortByPosition(mods as TopoDS_Face[], faceCenter).forEach((m, k) => give(m, `${nf.name}~${k}`));
    }
  }
  for (const g of generated) {
    const gen = listToArray(builder.Generated(g.from)).filter((m) => inResult.has(m));
    if (gen.length === 1) give(gen[0], g.name);
    else sortByPosition(gen as TopoDS_Face[], faceCenter).forEach((m, k) => give(m, `${g.name}~${k}`));
  }
  return finalize(resultFaces, names, result, fid);
}

/** Completa nomes em falta com nomes de recurso determinísticos e resolve nomes múltiplos. */
export function finalize(faces: TopoDS_Face[], names: (string[] | undefined)[], shape: TopoDS_Shape, fid: string): NamedBody {
  const unnamed = faces.map((f, i) => ({ f, i })).filter(({ i }) => !names[i]?.length);
  sortByPosition(unnamed.map((u) => u.f), faceCenter).forEach((f, k) => {
    const u = unnamed.find((x) => x.f === f)!;
    names[u.i] = [`${fid}:u${k}`];
  });
  const used = new Map<string, number>();
  const out: NamedFace[] = faces.map((face, i) => {
    const all = [...new Set(names[i]!)].sort();
    const [name, ...aliases] = all;
    used.set(name, (used.get(name) ?? 0) + 1);
    return { face, name, aliases: aliases.length ? aliases : undefined };
  });
  // nomes repetidos (raro: a mesma origem em faces diferentes) → sufixo ~k
  for (const [n, count] of used) {
    if (count < 2) continue;
    const dup = out.filter((x) => x.name === n);
    sortByPosition(dup.map((d) => d.face), faceCenter).forEach((f, k) => { dup.find((d) => d.face === f)!.name = `${n}~${k}`; });
  }
  return { shape, faces: out };
}

/** Nomeia todas as faces de uma forma nova com uma função (ou nomes de recurso). */
export function nameFresh(shape: TopoDS_Shape, fid: string, namer: (f: TopoDS_Face) => string | undefined = () => undefined): NamedBody {
  const faces = explore(shape, "face");
  return finalize(faces, faces.map((f) => { const n = namer(f); return n ? [n] : undefined; }), shape, fid);
}

/** Nomes das arestas, derivados das faces adjacentes. */
export function namedEdges(body: NamedBody): NamedEdge[] {
  const idx = new ShapeIndex<{ edge: TopoDS_Edge; faces: string[] }>();
  const list: { edge: TopoDS_Edge; faces: string[] }[] = [];
  for (const nf of body.faces) {
    for (const e of explore(nf.face, "edge")) {
      let rec = idx.get(e);
      if (!rec) { rec = { edge: e, faces: [] }; idx.set(e, rec); list.push(rec); }
      rec.faces.push(nf.name);
    }
  }
  const groups = new Map<string, typeof list>();
  for (const r of list) {
    const key = `{${[...r.faces].sort().join("&")}}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: NamedEdge[] = [];
  for (const [key, g] of groups) {
    if (g.length === 1) out.push({ edge: g[0].edge, name: key, faces: g[0].faces });
    else sortByPosition(g.map((x) => x.edge), (e) => edgeProps(e).mid).forEach((e, k) => {
      out.push({ edge: e, name: `${key}#${k}`, faces: g.find((x) => x.edge === e)!.faces });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolução de referências
// ---------------------------------------------------------------------------

/** Remove sufixos de divisão (~k) de cada componente de um nome. */
const baseName = (n: string) => n.replace(/~\d+/g, "");
/** Componentes (faces) de um nome de aresta {A&B}#k. */
function edgeParts(n: string): string[] | null {
  const m = /^\{(.*)\}(#\d+)?$/.exec(n);
  if (!m) return null;
  // separar por & ao nível de topo (os nomes de faces podem conter {…})
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of m[1]) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "&" && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export interface Resolved<S> {
  items: S[];
  /** Como foi resolvida: exata, por nome base (face dividida/unida) ou por geometria. */
  how: "exact" | "base" | "geometry" | "missing";
}

export function resolveFace(body: NamedBody, ref: TopoRef): Resolved<NamedFace> {
  const exact = body.faces.filter((f) => f.name === ref.name || f.aliases?.includes(ref.name));
  if (exact.length) return { items: exact, how: "exact" };
  const b = baseName(ref.name);
  const base = body.faces.filter((f) => baseName(f.name) === b || f.aliases?.some((a) => baseName(a) === b));
  if (base.length) return { items: base, how: "base" };
  const g = byHint(body.faces.map((f) => ({ item: f, ...facePos(f.face) })), ref.hint);
  return g ? { items: [g], how: "geometry" } : { items: [], how: "missing" };
}

export function resolveEdge(body: NamedBody, edges: NamedEdge[], ref: TopoRef): Resolved<NamedEdge> {
  const exact = edges.filter((e) => e.name === ref.name);
  if (exact.length) return { items: exact, how: "exact" };
  const parts = edgeParts(ref.name);
  if (parts) {
    // a mesma combinação de faces-base (faces divididas criam várias arestas: aplica a todas)
    const want = parts.map(baseName).sort().join("&");
    const base = edges.filter((e) => [...new Set(e.faces.map(baseName))].sort().join("&") === want);
    if (base.length) return { items: base, how: "base" };
  }
  const g = byHint(edges.map((e) => ({ item: e, ...edgePos(e.edge) })), ref.hint);
  return g ? { items: [g], how: "geometry" } : { items: [], how: "missing" };
}

const facePos = (f: TopoDS_Face) => { const p = faceProps(f); return { c: p.center, n: p.normal }; };
const edgePos = (e: TopoDS_Edge) => { const p = edgeProps(e); return { c: p.mid, n: p.dir }; };

function byHint<S>(cands: { item: S; c: Vec3; n?: Vec3 }[], hint?: GeoHint): S | undefined {
  if (!hint || !cands.length) return undefined;
  let best: S | undefined, bestScore = Infinity;
  for (const c of cands) {
    let s = v3.dist(c.c, hint.c);
    if (hint.n && c.n) s *= 1 + (1 - Math.abs(v3.dot(hint.n, c.n))) * 4;
    else if (hint.n || c.n) s *= 2;
    if (s < bestScore) { bestScore = s; best = c.item; }
  }
  return best;
}

/** Pista geométrica para guardar com uma referência nova. */
export function hintFor(kind: "face" | "edge", s: TopoDS_Shape): GeoHint {
  const p = kind === "face" ? facePos(s as TopoDS_Face) : edgePos(s as TopoDS_Edge);
  return { c: p.c.map(round) as Vec3, n: p.n?.map(round) as Vec3 | undefined };
}
