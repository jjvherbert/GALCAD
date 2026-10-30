// Plano da malha manual (ao estilo do pré-processador do Femap): a partir da topologia exata do
// OpenCASCADE decide que volumes e faces se podem malhar de forma mapeada (transfinita), propaga o
// n.º de elementos pelas arestas opostas de cada face mapeada e converte as seeds do utilizador
// (n.º ou tamanho, razão de distribuição) em curvas transfinitas do Gmsh. As tags de faces e arestas
// são as do Gmsh (= ordem do OpenCASCADE no BREP exportado); o agente confere as caixas das curvas.
import type { TopoDS_Shape } from "./occ.ts";
import { bbox, edgeProps, explore } from "./occ.ts";
import type { FemCaseMesh, V3 } from "../sim/case.ts";

export interface PlanSeed { tags: number[]; mode: "count" | "size"; value: number; bias: number; biasAt: "start" | "end" | "ends" | "center" }

export interface PlanInput {
  /** Sólidos pela ordem do BREP (volume k+1 do Gmsh). */
  solids: TopoDS_Shape[];
  /** Faces e arestas de todo o BREP (tag = índice + 1). */
  faces: TopoDS_Shape[];
  edges: TopoDS_Shape[];
  size: number;
  /** Tamanho local por tag de face. */
  localSize: Map<number, number>;
  element: "tet" | "hex";
  hexMethod: "auto" | "structured" | "subdivision";
  seeds: PlanSeed[];
  /** Faces mapeadas pedidas pelo utilizador (tags). */
  mapped: number[];
  /** Nome de cada sólido (avisos). */
  names?: string[];
}

export type MeshPlan = Pick<FemCaseMesh, "hexMethod" | "volumes" | "surfaces" | "curves"> & { warnings: string[]; notes: string[] };

/**
 * Plano da malha. Hexaedros estruturados exigem volumes topologicamente hexaédricos (6 faces de 4
 * arestas, 12 arestas): os restantes têm de ser divididos em blocos (como no Femap) ou ir para a
 * subdivisão.
 */
export function meshPlan(p: PlanInput): MeshPlan {
  const warnings: string[] = [], notes: string[] = [];
  const tagOf = (list: TopoDS_Shape[], s: TopoDS_Shape) => list.findIndex((x) => x.IsSame(s)) + 1;
  const info = new Map<number, { length: number; start: V3; end: V3; box: { min: V3; max: V3 }; verts: TopoDS_Shape[] }>();
  const edgeInfo = (t: number) => {
    let x = info.get(t);
    if (!x) {
      const e = p.edges[t - 1], ep = edgeProps(e), b = bbox(e);
      x = { length: ep.length, start: ep.start as V3, end: ep.end as V3, box: { min: b.min as V3, max: b.max as V3 }, verts: explore(e, "vertex") };
      info.set(t, x);
    }
    return x;
  };
  const faceEdges = (ft: number) => explore(p.faces[ft - 1], "edge").map((e) => tagOf(p.edges, e));
  /** Pares de arestas opostas de uma face de 4 arestas (as que não partilham vértice), ou null. */
  const opposite = (ft: number): [number, number][] | null => {
    const es = faceEdges(ft);
    if (es.length !== 4 || explore(p.faces[ft - 1], "wire").length !== 1) return null;
    const share = (a: number, b: number) => edgeInfo(a).verts.some((v) => edgeInfo(b).verts.some((w) => v.IsSame(w)));
    const pairs: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      const others = es.filter((_, j) => j !== i && !share(es[i], es[j]));
      if (others.length !== 1 || edgeInfo(es[i]).verts.length !== 2) return null;
      if (es[i] < others[0]) pairs.push([es[i], others[0]]);
    }
    return pairs.length === 2 ? pairs : null;
  };
  const solidFaces = p.solids.map((s) => explore(s, "face").map((f) => tagOf(p.faces, f)));
  const hexable = p.solids.map((s, k) => solidFaces[k].length === 6 && explore(s, "edge").length === 12 && solidFaces[k].every((f) => opposite(f)));

  let method: FemCaseMesh["hexMethod"];
  const volumes: number[] = [], surfaces = new Set<number>();
  if (p.element === "hex") {
    const bad = p.solids.map((_, k) => (hexable[k] ? null : p.names?.[k] ?? `volume ${k + 1}`)).filter((x) => x !== null);
    if (p.hexMethod === "structured" && bad.length) throw new Error(`Hexaedros estruturados: ${bad.join(", ")} não é um bloco hexaédrico (6 faces de 4 arestas) — divida-o em blocos ou use a subdivisão`);
    method = p.hexMethod === "subdivision" || bad.length ? "subdivision" : "structured";
    if (p.hexMethod === "auto" && bad.length) warnings.push(`Hexaedros por subdivisão (qualidade inferior): ${bad.join(", ")} não é um bloco hexaédrico; divida-o em blocos para uma malha estruturada`);
    if (method === "structured") p.solids.forEach((_, k) => { volumes.push(k + 1); solidFaces[k].forEach((f) => surfaces.add(f)); });
  }
  for (const f of p.mapped) {
    if (!opposite(f)) throw new Error(`Face mapeada ${f}: só faces com 4 arestas (um contorno) podem ser mapeadas`);
    surfaces.add(f);
  }

  // classes de arestas opostas (union-find): todas as arestas de uma classe têm o mesmo n.º de elementos
  const parent = new Map<number, number>();
  const find = (a: number): number => { const q = parent.get(a) ?? a; if (q === a) return a; const r = find(q); parent.set(a, r); return r; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const f of surfaces) for (const [a, b] of opposite(f)!) { parent.set(a, find(a)); parent.set(b, find(b)); union(a, b); }

  // seeds do utilizador por aresta (a última seed numa aresta prevalece)
  const seedOf = new Map<number, { n: number; seed: PlanSeed }>();
  for (const sd of p.seeds) {
    if (!(sd.value > 0)) throw new Error("Seed: o valor tem de ser positivo");
    if (!(sd.bias >= 1)) throw new Error("Seed: a razão de distribuição tem de ser ≥ 1 (maior / menor elemento)");
    for (const t of sd.tags) seedOf.set(t, { n: sd.mode === "count" ? Math.max(1, Math.round(sd.value)) : Math.max(1, Math.ceil(edgeInfo(t).length / sd.value - 1e-9)), seed: sd });
  }
  // tamanho efetivo de uma aresta: o menor entre o global e os locais das faces que a contêm
  const edgeFaces = new Map<number, number[]>();
  p.faces.forEach((_, i) => { for (const e of faceEdges(i + 1)) edgeFaces.set(e, [...(edgeFaces.get(e) ?? []), i + 1]); });
  const want = (t: number) => Math.max(1, Math.ceil(edgeInfo(t).length / Math.min(p.size, ...(edgeFaces.get(t) ?? []).map((f) => p.localSize.get(f) ?? Infinity)) - 1e-9));

  const classes = new Map<number, number[]>();
  for (const t of parent.keys()) classes.set(find(t), [...(classes.get(find(t)) ?? []), t]);
  const curves: NonNullable<FemCaseMesh["curves"]> = [];
  const dist = (sd: PlanSeed, n: number, same = true): { progression?: number; bump?: number } => {
    if (sd.bias === 1 || n < 2) return {};
    if (sd.biasAt === "ends") return { bump: 1 / sd.bias };
    if (sd.biasAt === "center") return { bump: sd.bias };
    // razão entre elementos consecutivos: maior/menor = r^(n−1); "start" = pequenos no início da aresta
    const r = sd.bias ** (1 / (n - 1));
    return { progression: (sd.biasAt === "end") === same ? 1 / r : r };
  };
  const curve = (t: number, n: number, d: { progression?: number; bump?: number }, user: boolean) => {
    const x = edgeInfo(t);
    curves.push({ tag: t, n, ...d, box: x.box, length: x.length, ...(user ? { user } : {}) });
  };
  for (const members of classes.values()) {
    const seeded = members.filter((t) => seedOf.has(t));
    const ns = [...new Set(seeded.map((t) => seedOf.get(t)!.n))];
    if (ns.length > 1) warnings.push(`Seeds incompatíveis nas arestas opostas ${seeded.join(", ")} (${ns.join(" vs ")} elementos): usado o maior — numa malha mapeada as arestas opostas têm o mesmo n.º de elementos`);
    const n = seeded.length ? Math.max(...ns) : Math.max(...members.map(want));
    // distribuição: a das seeds; as arestas sem seed seguem a primeira seed com distribuição, no mesmo sentido geométrico
    const ref = seeded.find((t) => seedOf.get(t)!.seed.bias !== 1);
    for (const t of members) {
      const own = seedOf.get(t);
      if (own) { curve(t, n, dist(own.seed, n), true); continue; }
      if (!ref) { curve(t, n, {}, false); continue; }
      const a = edgeInfo(ref), b = edgeInfo(t);
      const same = (a.end[0] - a.start[0]) * (b.end[0] - b.start[0]) + (a.end[1] - a.start[1]) * (b.end[1] - b.start[1]) + (a.end[2] - a.start[2]) * (b.end[2] - b.start[2]) >= 0;
      curve(t, n, dist(seedOf.get(ref)!.seed, n, same), false);
    }
  }
  // seeds fora das faces mapeadas: discretização imposta da aresta (o resto da malha adapta-se)
  for (const [t, { n, seed }] of seedOf) if (!parent.has(t)) curve(t, n, dist(seed, n), true);
  curves.sort((a, b) => a.tag - b.tag);

  if (method === "structured") notes.push(`hexaedros estruturados (mapeados) em ${volumes.length} volume(s), ${surfaces.size} faces mapeadas`);
  if (method === "subdivision") notes.push("hexaedros por subdivisão de uma malha tetraédrica (cada tetraedro em 4 hexaedros)");
  if (p.element !== "hex" && surfaces.size) notes.push(`${surfaces.size} face(s) mapeada(s)`);
  const user = curves.filter((c) => c.user).length;
  if (user) notes.push(`${user} aresta(s) com seed`);
  return { hexMethod: method, volumes: volumes.length ? volumes : undefined, surfaces: surfaces.size ? [...surfaces].sort((a, b) => a - b) : undefined, curves: curves.length ? curves : undefined, warnings, notes };
}
